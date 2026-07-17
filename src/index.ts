/**
 * bedrock-auto-auth
 *
 * Reads Bedrock/AWS config from ~/.pi/agent/settings.json under the "bedrock"
 * key, injects it into process.env so pi-provider-bedrock picks it up, and
 * watches for expired SSO tokens — automatically opening a browser auth URL
 * and re-submitting the last prompt once login completes.
 *
 * ~/.pi/agent/settings.json:
 * {
 *   "bedrock": {
 *     "profile": "genai",
 *     "region": "us-east-1"
 *   }
 * }
 *
 * The "profile" key is equivalent to PI_BEDROCK_PROFILE.
 * The "region" key is equivalent to PI_BEDROCK_REGION (default: "us-east-1").
 *
 * Env vars take precedence over settings.json so existing setups are unaffected.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

  // Inject into process.env so pi-provider-bedrock picks them up
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

// ─── Auth-error detection ────────────────────────────────────────────────────

/**
 * Patterns that indicate an expired / missing AWS SSO token.
 *
 * Two distinct failure modes:
 *
 * 1. SDK-level expiry — caught before the Bedrock request is made.
 *    The CredentialsProviderError / TokenProviderError message surfaces directly
 *    as the errorMessage. These have clear "SSO session", "Token is expired", etc.
 *
 * 2. Bedrock-level 403 with unread EventStream body — happens when the STS
 *    role credentials expired or the SSO token was accepted by GetRoleCredentials
 *    but the Bedrock service itself rejects them. formatBedrockError serialises
 *    the unread $response.body stream object as JSON, producing internal Node.js
 *    stream fields like "_events" and "_readableState" rather than an actual error
 *    message. This is reliably distinct from a legitimate IAM permission denial,
 *    which would have a JSON body containing a "message" key.
 */
const AUTH_ERROR_PATTERNS = [
  // SDK-level SSO/token expiry (CredentialsProviderError / TokenProviderError)
  /token is expired/i,
  /aws sso login/i,
  /sso token/i,
  /SSO session/i,
  /No token available/i,
  // Other SDK-level auth errors
  /ExpiredToken/,
  /InvalidIdentityToken/,
  /UnauthorizedException/,
  // Bedrock 403 where the response body is an unread EventStream (stream internals
  // serialised by safeJsonStringify — not a real IAM permission-denied message)
  /AccessDeniedException:.*403:.*"_events"/,
  /AccessDeniedException:.*403:.*"_readableState"/,
];

function isBedrockAuthError(errorMessage: string): boolean {
  return AUTH_ERROR_PATTERNS.some((p) => p.test(errorMessage));
}

// ─── AWS SSO login ───────────────────────────────────────────────────────────

/**
 * Run `aws sso login --profile <profile> --no-browser`.
 * Returns the authorization URL from stdout/stderr, or null if not found.
 * Resolves when the login subprocess exits.
 */
function runSsoLogin(profile: string): Promise<{ url: string | null; exitCode: number }> {
  return new Promise((resolve) => {
    let url: string | null = null;
    const urlPattern = /https:\/\/oidc\.[^\s]+/;

    const child = spawn("aws", ["sso", "login", "--profile", profile, "--no-browser"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    function scanLine(line: string) {
      if (!url) {
        const match = line.match(urlPattern);
        if (match) url = match[0];
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
  // Resolve config at load time so pi-provider-bedrock gets the env vars in time
  const { profile } = resolveConfig();

  if (!profile) return; // No Bedrock config — nothing to do

  // Track the last user prompt so we can re-submit it after login
  let lastUserPrompt: string | null = null;

  pi.on("before_agent_start", (event) => {
    lastUserPrompt = event.prompt ?? null;
  });

  // Prevent re-entrant login flows
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

      const { url, exitCode } = await runSsoLogin(profile);

      if (url) {
        openUrl(url);
        ctx.ui.notify(`🌐 Opening browser for AWS SSO login.\nURL: ${url}`, "info");
      } else {
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
