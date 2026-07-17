# pi-bedrock-auto-auth

A [pi](https://pi.dev) extension that automatically re-authenticates AWS SSO when your Bedrock token expires — opening a browser login URL and re-submitting your last prompt once authentication completes.

Mirrors the automatic Bedrock auth behaviour in Claude Code.

## How it works

1. Detects AWS SSO auth errors from the Bedrock provider (`ExpiredToken`, `Token is expired`, etc.)
2. Runs `aws sso login --profile <your-profile> --no-browser` automatically
3. Extracts the authorization URL and opens it in your default browser
4. Waits for login to complete, then re-submits your last prompt seamlessly

## Requirements

- [pi](https://pi.dev) coding agent
- [pi-provider-bedrock](https://github.com/samfoy/pi-provider-bedrock) (or another Bedrock provider)
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) on your `PATH`
- An AWS profile configured with SSO (see [AWS SSO setup](#aws-sso-setup))

## Installation

```bash
pi install git:github.com/Raithlin/pi-bedrock-auto-auth
```

This also works:

```bash
pi install https://github.com/Raithlin/pi-bedrock-auto-auth
```

## Setup

### 1. Install the Bedrock provider

If you haven't already:

```bash
pi install npm:pi-provider-bedrock
```

### 2. Configure your AWS profile

Add a `bedrock` block to `~/.pi/agent/settings.json`:

```json
{
  "bedrock": {
    "profile": "my-aws-profile",
    "region": "us-east-1"
  }
}
```

| Key | Required | Default | Description |
|-----|----------|---------|-------------|
| `profile` | **Yes** | — | AWS profile name (must be configured with SSO in `~/.aws/config`) |
| `region` | No | `us-east-1` | AWS region for Bedrock |

The extension injects these as `PI_BEDROCK_PROFILE`, `PI_BEDROCK_REGION`, `AWS_PROFILE`, and `AWS_REGION` into the process environment at startup, so `pi-provider-bedrock` activates without any shell configuration needed.

**Environment variables take precedence** over `settings.json`, so existing setups using `PI_BEDROCK_PROFILE` in your shell profile are unaffected.

### 3. Select a Bedrock model

Start pi and switch to a Bedrock model:

```
/model bedrock/<model-name>
```

Or use `Ctrl+P` to cycle models.

### 4. That's it

The next time your SSO token expires mid-session, pi will automatically:

- Notify you that it's starting re-authentication
- Open your browser to the AWS SSO login page
- Wait for you to complete login
- Re-submit your last prompt

## AWS SSO setup

If you haven't configured AWS SSO yet, add a profile to `~/.aws/config`:

```ini
[profile my-aws-profile]
sso_session = my-sso
sso_account_id = 123456789012
sso_role_name = MyRole
region = us-east-1
output = json

[sso-session my-sso]
sso_start_url = https://my-org.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access
```

Then do an initial login:

```bash
aws sso login --profile my-aws-profile
```

## Full settings.json example

```json
{
  "defaultModel": "bedrock/my-model",
  "bedrock": {
    "profile": "my-aws-profile",
    "region": "us-east-1"
  },
  "packages": [
    "npm:pi-provider-bedrock",
    "git:github.com/Raithlin/pi-bedrock-auto-auth"
  ]
}
```

## License

MIT
