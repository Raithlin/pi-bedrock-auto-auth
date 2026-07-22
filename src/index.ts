/**
 * bedrock-auto-auth
 *
 * Single self-contained extension that:
 * 1. Reads Bedrock/AWS config from ~/.pi/agent/settings.json ("bedrock" key)
 * 2. Registers a "bedrock" provider with nCino and public models
 * 3. Watches for expired SSO tokens and automatically re-authenticates
 *
 * ~/.pi/agent/settings.json:
 * {
 *   "bedrock": {
 *     "profile": "genai",
 *     "region": "us-east-1"
 *   }
 * }
 *
 * Env vars (PI_BEDROCK_PROFILE, PI_BEDROCK_REGION) take precedence over settings.json.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { getApiProvider } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Constants ───────────────────────────────────────────────────────────────

const PROVIDER = "bedrock";
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const BEDROCK_MODELS: Array<{
  id: string;
  name: string;
  bedrockId: string;
  contextWindow: number;
  maxTokens: number;
  forceCache?: boolean;
}> = [
  {
    id: "ncino-sonnet",
    name: "Sonnet (nCino)",
    bedrockId: "arn:aws:bedrock:us-east-1:714322698969:application-inference-profile/9kj0csdyqyvq",
    contextWindow: 200000,
    maxTokens: 16000,
    forceCache: true,
  },
  {
    id: "ncino-opus",
    name: "Opus (nCino)",
    bedrockId: "arn:aws:bedrock:us-east-1:714322698969:application-inference-profile/n0e3heu53j8f",
    contextWindow: 200000,
    maxTokens: 32000,
    forceCache: true,
  },
  {
    id: "ncino-haiku",
    name: "Haiku (nCino)",
    bedrockId: "arn:aws:bedrock:us-east-1:714322698969:application-inference-profile/1267pweyv7t9",
    contextWindow: 200000,
    maxTokens: 8096,
    forceCache: true,
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6 1M (Bedrock)",
    bedrockId: "us.anthropic.claude-opus-4-6-v1",
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 1M (Bedrock)",
    bedrockId: "us.anthropic.claude-sonnet-4-6",
    contextWindow: 1000000,
    maxTokens: 64000,
  },
];

// ─── Config loading ──────────────────────────────────────────────────────────

interface BedrockConfig {
  profile?: string;
  region?: string;
}

function loadSettingsConfig(): BedrockConfig {
  try {
    const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
    const raw = readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const bedrock = settings["bedrock"];
    if (bedrock && typeof bedrock === "object") {
      return bedrock as BedrockConfig;
    }
  } catch {
    // File missing or malformed — fine, fall through to env vars
  }
  return {};
}

function resolveConfig(): { profile: string | undefined; region: string } {
  const fromSettings = loadSettingsConfig();

  // Env vars take precedence over settings.json
  const profile = process.env.PI_BEDROCK_PROFILE ?? fromSettings.profile;
  const region = process.env.PI_BEDROCK_REGION ?? fromSettings.region ?? "us-east-1";

  // Inject into process.env so the built-in bedrock API provider picks them up
  if (profile && !process.env.PI_BEDROCK_PROFILE) {
    process.env.PI_BEDROCK_PROFILE = profile;
  }
  if (!process.env.PI_BEDROCK_REGION) {
    process.env.PI_BEDROCK_REGION = region;
  }
  if (profile && !process.env.AWS_PROFILE) {
    process.env.AWS_PROFILE = profile;
  }
  if (!process.env.AWS_REGION) {
    process.env.AWS_REGION = region;
  }

  return { profile, region };
}

// ─── Provider registration ───────────────────────────────────────────────────

function streamBedrock(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const provider = getApiProvider("bedrock-converse-stream");
  if (!provider) throw new Error("Bedrock API provider not registered");

  const profile = process.env.PI_BEDROCK_PROFILE;
  const region = process.env.PI_BEDROCK_REGION || "us-east-1";

  const entry = BEDROCK_MODELS.find((m) => m.id === model.id);
  if (!entry) throw new Error(`No bedrock mapping for ${model.id}`);

  const bedrockModel: Model<Api> = {
    id: entry.bedrockId,
    name: entry.name,
    api: "bedrock-converse-stream" as Api,
    provider: "amazon-bedrock",
    baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
    reasoning: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };

  if (entry.forceCache) process.env.AWS_BEDROCK_FORCE_CACHE = "1";

  return provider.stream(bedrockModel, context, {
    ...(options ?? {}),
    profile,
    region,
  } as Record<string, unknown>);
}

// ─── Auth-error detection ────────────────────────────────────────────────────

const AUTH_ERROR_PATTERNS = [
  // SDK-level SSO/token expiry
  /token is expired/i,
  /aws sso login/i,
  /sso token/i,
  /SSO session/i,
  /No token available/i,
  // Other SDK-level auth errors
  /ExpiredToken/,
  /InvalidIdentityToken/,
  /UnauthorizedException/,
  // Bedrock 403 with unread EventStream body (stream internals serialised)
  /AccessDeniedException:.*403:.*"_events"/,
  /AccessDeniedException:.*403:.*"_readableState"/,
];

function isBedrockAuthError(errorMessage: string): boolean {
  return AUTH_ERROR_PATTERNS.some((p) => p.test(errorMessage));
}

// ─── AWS SSO login ───────────────────────────────────────────────────────────

/**
 * Run `aws sso login --profile <profile> --no-browser`.
 * Calls `onUrl` as soon as the authorization URL is detected so the caller
 * can open the browser immediately (the login process blocks waiting for
 * the user to authenticate before it exits).
 * Resolves when the login subprocess exits.
 */
function runSsoLogin(
  profile: string,
  onUrl?: (url: string) => void,
): Promise<{ url: string | null; exitCode: number }> {
  return new Promise((resolve) => {
    let url: string | null = null;
    const urlPattern = /https:\/\/[^\s]+/;

    const child = spawn("aws", ["sso", "login", "--profile", profile, "--no-browser"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    function scanLine(line: string) {
      if (!url) {
        const match = line.match(urlPattern);
        if (match) {
          url = match[0];
          onUrl?.(url);
        }
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      chunk.toString().split("\n").forEach(scanLine);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      chunk.toString().split("\n").forEach(scanLine);
    });

    child.on("close", (code) => {
      resolve({ url, exitCode: code ?? 1 });
    });

    child.on("error", () => {
      resolve({ url, exitCode: 1 });
    });
  });
}

/** Open a URL with the system browser (macOS: open, Linux: xdg-open). */
function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
  child.unref();
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Resolve config at load time
  const { profile, region } = resolveConfig();

  if (!profile) return; // No Bedrock config — nothing to do

  // ── Register the provider ──────────────────────────────────────────────────

  pi.registerProvider(PROVIDER, {
    api: `${PROVIDER}-api` as Api,
    baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
    apiKey: "aws-profile-auth",
    models: BEDROCK_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: true,
      input: ["text", "image"] as ("text" | "image")[],
      cost: ZERO_COST,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
    streamSimple: streamBedrock,
  });

  // ── Auto-auth on SSO token expiry ──────────────────────────────────────────

  let lastUserPrompt: string | null = null;

  pi.on("before_agent_start", (event) => {
    lastUserPrompt = event.prompt ?? null;
  });

  let loginInProgress = false;

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;
    if (msg.stopReason !== "error") return;
    if (!msg.errorMessage) return;
    if (!isBedrockAuthError(msg.errorMessage)) return;
    if (loginInProgress) return;

    loginInProgress = true;

    try {
      ctx.ui.notify(
        `🔐 AWS SSO token expired for profile "${profile}". Starting login…`,
        "warning",
      );

      const { url, exitCode } = await runSsoLogin(profile, (detectedUrl) => {
        openUrl(detectedUrl);
        ctx.ui.notify(`🌐 Opening browser for AWS SSO login.\nURL: ${detectedUrl}`, "info");
      });

      if (!url) {
        ctx.ui.notify(
          `⚠️  Could not extract authorization URL. ` +
            `Run manually: aws sso login --profile ${profile}`,
          "warning",
        );
      }

      if (exitCode !== 0) {
        ctx.ui.notify(
          `❌ AWS SSO login failed (exit ${exitCode}). Please authenticate and retry.`,
          "error",
        );
        return;
      }

      ctx.ui.notify("✅ AWS SSO login complete. Re-submitting your request…", "info");

      const prompt = lastUserPrompt;
      if (prompt) {
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      }
    } finally {
      loginInProgress = false;
    }
  });
}
