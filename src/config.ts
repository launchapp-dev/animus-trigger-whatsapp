// Runtime configuration sourced from environment variables. Mirrors the
// `env_required` block in `plugin.toml`. Missing required vars are NOT a fatal
// constructor error — the plugin still spawns and answers `health/check` with
// an `unhealthy` report so the host can surface a useful operator message.

export const MISSING_ACCESS_TOKEN_MSG =
  "WHATSAPP_ACCESS_TOKEN is not set; the plugin cannot call the Graph API. " +
  "Generate a token in Meta Business Manager → System Users → Access Tokens.";

export const MISSING_PHONE_NUMBER_ID_MSG =
  "WHATSAPP_PHONE_NUMBER_ID is not set; the plugin has no sender identity. " +
  "Find it under WhatsApp Manager → Phone Numbers (the numeric id, NOT the +E.164 number).";

export const MISSING_VERIFY_TOKEN_MSG =
  "WHATSAPP_VERIFY_TOKEN is not set; the webhook GET handshake will reject Meta.";

export const MISSING_APP_SECRET_MSG =
  "WHATSAPP_APP_SECRET is not set; inbound webhook signature validation is disabled. " +
  "This is INSECURE in production — set the value from Meta App → Settings → Basic.";

// Meta retires Graph API versions on a rolling cadence. v22.0 is the current
// stable WhatsApp Cloud API surface as of mid-2025; operators can override
// via WHATSAPP_GRAPH_API_BASE if they want to pin to a specific version.
export const DEFAULT_GRAPH_API_BASE = "https://graph.facebook.com/v22.0";
export const DEFAULT_WEBHOOK_PORT = 8089;
export const DEFAULT_WEBHOOK_PATH = "/webhook";

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  verifyToken: string;
  appSecret: string;
  webhookPort: number;
  webhookPath: string;
  graphApiBase: string;
}

function envStr(name: string): string {
  const v = process.env[name];
  return typeof v === "string" ? v : "";
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return fallback;
  return n;
}

export function loadConfigFromEnv(): WhatsAppConfig {
  return {
    accessToken: envStr("WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId: envStr("WHATSAPP_PHONE_NUMBER_ID"),
    verifyToken: envStr("WHATSAPP_VERIFY_TOKEN"),
    appSecret: envStr("WHATSAPP_APP_SECRET"),
    webhookPort: parsePort(process.env["WHATSAPP_WEBHOOK_PORT"], DEFAULT_WEBHOOK_PORT),
    webhookPath: envStr("WHATSAPP_WEBHOOK_PATH") || DEFAULT_WEBHOOK_PATH,
    graphApiBase: envStr("WHATSAPP_GRAPH_API_BASE") || DEFAULT_GRAPH_API_BASE,
  };
}

/**
 * Returns a human-readable error message for the first missing required var,
 * or `null` if the config is complete enough to operate.
 */
export function describeConfigGap(cfg: WhatsAppConfig): string | null {
  if (!cfg.accessToken) return MISSING_ACCESS_TOKEN_MSG;
  if (!cfg.phoneNumberId) return MISSING_PHONE_NUMBER_ID_MSG;
  if (!cfg.verifyToken) return MISSING_VERIFY_TOKEN_MSG;
  if (!cfg.appSecret) return MISSING_APP_SECRET_MSG;
  return null;
}
