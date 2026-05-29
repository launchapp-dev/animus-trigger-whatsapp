#!/usr/bin/env node
// WhatsApp Business Cloud API trigger backend for Animus.
//
// The SDK's high-level `definePlugin` only wires `subject_backend` in v0.1.0,
// so this plugin uses the SDK's lower-level wire helpers (`createWire`,
// `buildManifest`, `okResponse`, `errorResponse`) and owns the JSON-RPC
// dispatch loop. We still get:
//   - `--manifest` shortcut
//   - canonical handshake/initialize reply
//   - newline-delimited JSON-RPC framing
//   - host-compatible HealthCheckResult shape
//   - host-compatible error codes
//
// Roles exposed:
//   - `trigger/schema`      → return kinds + capability flags
//   - `trigger/watch`       → long-running; emits `trigger/event` notifications
//                             when the embedded HTTP webhook server receives a
//                             POST from Meta
//   - `trigger/ack`         → no-op (we 200 on the webhook layer; Meta does not
//                             use Animus-side event ids)
//   - `whatsapp/send_text`  → POST text message via Graph API
//   - `whatsapp/send_template` → POST template message
//   - `whatsapp/send_media` → POST media (image/audio/video/document) via URL
//   - `health/check`        → reflect env-var readiness

import process from "node:process";
import { stdout as nodeStdout } from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildInitializeResult,
  buildManifest,
  createWire,
  ErrorCode,
  errorResponse,
  okResponse,
  validateInitializeParams,
  type PluginIdentity,
  type RpcRequest,
  type RpcResponse,
  type Wire,
} from "@launchapp-dev/animus-plugin-sdk";

import { describeConfigGap, loadConfigFromEnv, type WhatsAppConfig } from "./config.js";
import { KIND_WHATSAPP_MESSAGE, type TriggerEvent } from "./inbound.js";
import { startWebhookServer, type WebhookServerHandle } from "./webhook-server.js";
import {
  sendMedia,
  sendTemplate,
  sendText,
  type SendContext,
  type SendMediaParams,
  type SendTemplateParams,
  type SendTextParams,
} from "./outbound.js";

const PLUGIN_NAME = "animus-trigger-whatsapp";
const PLUGIN_VERSION = "0.1.0";
const PLUGIN_DESCRIPTION =
  "WhatsApp Business Cloud API trigger - inbound webhook receiver + outbound Graph API sender";

const identity: PluginIdentity = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  description: PLUGIN_DESCRIPTION,
  plugin_kind: "trigger_backend",
};

const capabilities = {
  methods: [
    "trigger/schema",
    "trigger/watch",
    "trigger/ack",
    "whatsapp/send_text",
    "whatsapp/send_template",
    "whatsapp/send_media",
    "health/check",
  ],
  streaming: true,
  progress: false,
  cancellation: false,
};

const manifest = buildManifest(identity, capabilities, {
  env_required: [
    {
      name: "WHATSAPP_ACCESS_TOKEN",
      description: "Meta Graph API access token (system-user or temporary).",
      required: true,
      sensitive: true,
    },
    {
      name: "WHATSAPP_PHONE_NUMBER_ID",
      description: "WABA phone-number-id used as the sender (numeric id, not the +E.164 number).",
      required: true,
      sensitive: false,
    },
    {
      name: "WHATSAPP_VERIFY_TOKEN",
      description: "Shared secret used for the Meta webhook GET verification handshake.",
      required: true,
      sensitive: true,
    },
    {
      name: "WHATSAPP_APP_SECRET",
      description: "Meta App Secret used to validate X-Hub-Signature-256 HMACs.",
      required: true,
      sensitive: true,
    },
    {
      name: "WHATSAPP_WEBHOOK_PORT",
      description: "Local TCP port the embedded HTTP webhook server binds to (default 8089).",
      required: false,
      sensitive: false,
    },
    {
      name: "WHATSAPP_WEBHOOK_PATH",
      description: "Path the webhook server listens on (default /webhook).",
      required: false,
      sensitive: false,
    },
    {
      name: "WHATSAPP_GRAPH_API_BASE",
      description: "Override Graph API base URL (default https://graph.facebook.com/v22.0).",
      required: false,
      sensitive: false,
    },
  ],
});

interface WatchState {
  /** The originating `trigger/watch` request id (echoed in every event). */
  watchRequestId: string | number | null;
  wire: Wire;
  server: WebhookServerHandle;
}

let activeWatch: WatchState | null = null;

async function closeActiveWatch(): Promise<void> {
  if (!activeWatch) return;
  const state = activeWatch;
  activeWatch = null;
  try {
    await state.server.close();
  } catch (err) {
    process.stderr.write(`[${PLUGIN_NAME}] webhook server close failed: ${String(err)}\n`);
  }
}

function buildSendContext(cfg: WhatsAppConfig): SendContext {
  return {
    accessToken: cfg.accessToken,
    phoneNumberId: cfg.phoneNumberId,
    graphApiBase: cfg.graphApiBase,
  };
}

function buildHealth(cfg: WhatsAppConfig): {
  status: "healthy" | "degraded" | "unhealthy";
  uptime_ms: number | null;
  memory_usage_bytes: number | null;
  last_error: string | null;
} {
  const gap = describeConfigGap(cfg);
  if (gap) {
    return { status: "unhealthy", uptime_ms: null, memory_usage_bytes: null, last_error: gap };
  }
  return { status: "healthy", uptime_ms: null, memory_usage_bytes: null, last_error: null };
}

async function handleTriggerWatch(
  id: string | number | null,
  cfg: WhatsAppConfig,
  wire: Wire,
): Promise<RpcResponse> {
  const gap = describeConfigGap(cfg);
  if (gap) {
    return errorResponse(id, ErrorCode.InvalidRequest, gap);
  }
  if (activeWatch) {
    return errorResponse(
      id,
      ErrorCode.InvalidRequest,
      "trigger/watch already active; only one webhook listener per process",
    );
  }
  // The protocol spec (see animus-protocol/spec.md §trigger/event) requires
  // `params.id` to echo the originating watch request id and `params.event`
  // to carry the full TriggerEvent body. Capture the id here so the webhook
  // callback can stamp every emitted notification with it.
  const watchRequestId = id;
  try {
    const server = await startWebhookServer({
      port: cfg.webhookPort,
      path: cfg.webhookPath,
      verifyToken: cfg.verifyToken,
      appSecret: cfg.appSecret,
      onEvent: (event: TriggerEvent) => {
        void wire.notify("trigger/event", {
          id: watchRequestId,
          event,
        });
      },
    });
    activeWatch = { watchRequestId, wire, server };
    return okResponse(id, { watching: true });
  } catch (err) {
    return errorResponse(id, ErrorCode.InternalError, `failed to bind webhook server: ${String(err)}`);
  }
}

async function handleTriggerAck(
  id: string | number | null,
  params: Record<string, unknown>,
): Promise<RpcResponse> {
  // We already 200 the HTTP POST inside the webhook handler. Meta does not
  // use Animus event ids, so per-event ack is a no-op for v0.1.0 — but the
  // protocol spec (`{ event_id, acked: true }`) and host conformance checks
  // require us to echo the supplied event id back.
  const eventId = typeof params["event_id"] === "string" ? (params["event_id"] as string) : "";
  return okResponse(id, { event_id: eventId, acked: true });
}

function validateSendParams(method: string, params: Record<string, unknown>): string | null {
  const requireStr = (key: string): string | null =>
    typeof params[key] === "string" && (params[key] as string).length > 0
      ? null
      : `${method}: \`${key}\` is required (non-empty string)`;
  if (method === "whatsapp/send_text") {
    return requireStr("to") ?? requireStr("body");
  }
  if (method === "whatsapp/send_template") {
    return requireStr("to") ?? requireStr("template");
  }
  if (method === "whatsapp/send_media") {
    return requireStr("to") ?? requireStr("kind") ?? requireStr("url");
  }
  return null;
}

async function handleSend(
  id: string | number | null,
  method: string,
  params: Record<string, unknown>,
  cfg: WhatsAppConfig,
): Promise<RpcResponse> {
  const gap = describeConfigGap(cfg);
  if (gap) {
    return errorResponse(id, ErrorCode.InvalidRequest, gap);
  }
  const invalid = validateSendParams(method, params);
  if (invalid) {
    return errorResponse(id, ErrorCode.InvalidParams, invalid);
  }
  const ctx = buildSendContext(cfg);
  try {
    if (method === "whatsapp/send_text") {
      const result = await sendText(ctx, params as unknown as SendTextParams);
      return okResponse(id, result);
    }
    if (method === "whatsapp/send_template") {
      const result = await sendTemplate(ctx, params as unknown as SendTemplateParams);
      return okResponse(id, result);
    }
    if (method === "whatsapp/send_media") {
      const result = await sendMedia(ctx, params as unknown as SendMediaParams);
      return okResponse(id, result);
    }
    return errorResponse(id, ErrorCode.MethodNotFound, `unknown method '${method}'`);
  } catch (err) {
    return errorResponse(id, ErrorCode.InternalError, `send failed: ${String(err)}`);
  }
}

async function dispatch(
  frame: RpcRequest,
  wire: Wire,
  cfg: WhatsAppConfig,
): Promise<RpcResponse | undefined> {
  const id = frame.id;
  const method = frame.method;
  const params = (frame.params ?? {}) as Record<string, unknown>;

  if (id === undefined) {
    // Notification path.
    if (method === "exit") {
      setImmediate(() => {
        void closeActiveWatch().finally(() => process.exit(0));
      });
      return undefined;
    }
    if (method === "initialized" || method.startsWith("$/")) return undefined;
    return undefined;
  }

  switch (method) {
    case "initialize": {
      const incompat = validateInitializeParams(params as never);
      if (incompat) return errorResponse(id, ErrorCode.InvalidRequest, incompat);
      return okResponse(id, buildInitializeResult(identity, capabilities));
    }
    case "$/ping":
      return okResponse(id, {});
    case "health/check":
      return okResponse(id, buildHealth(cfg));
    case "shutdown":
      await closeActiveWatch();
      return okResponse(id, {});
    case "exit":
      setImmediate(() => {
        void closeActiveWatch().finally(() => process.exit(0));
      });
      return okResponse(id, {});
    case "trigger/schema":
      // We do not persist a delivery cursor and Meta will not redeliver
      // webhook events the plugin has already 200'd. Anything delivered while
      // the listener is down is gone, so honestly report no resume support.
      return okResponse(id, {
        kinds: [KIND_WHATSAPP_MESSAGE],
        supports_resume: false,
        supports_dedup: false,
        supports_ack: true,
      });
    case "trigger/watch":
      return handleTriggerWatch(id, cfg, wire);
    case "trigger/ack":
      return handleTriggerAck(id, params);
    case "whatsapp/send_text":
    case "whatsapp/send_template":
    case "whatsapp/send_media":
      return handleSend(id, method, params, cfg);
    default:
      return errorResponse(id, ErrorCode.MethodNotFound, `unknown method '${method}'`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--manifest") || args.includes("-m")) {
    await new Promise<void>((resolve, reject) => {
      nodeStdout.write(`${JSON.stringify(manifest)}\n`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    process.exit(0);
  }
  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write(
      `${PLUGIN_NAME} ${PLUGIN_VERSION} - Animus STDIO plugin\n` +
        `Usage:\n` +
        `  ${PLUGIN_NAME} --manifest    Print plugin manifest as JSON and exit\n` +
        `  ${PLUGIN_NAME}               Run JSON-RPC loop on stdin/stdout\n`,
    );
    process.exit(0);
  }

  const cfg = loadConfigFromEnv();
  const wire: Wire = createWire();
  try {
    await wire.run((frame) => dispatch(frame, wire, cfg));
  } finally {
    // Stdin closed without a graceful `shutdown`/`exit` (daemon restart,
    // crash, or SIGKILL). Release the webhook port so the next plugin instance
    // can bind it without colliding with our orphaned listener.
    await closeActiveWatch();
  }
}

// Top-level entry — only run when invoked directly so importers (tests) can
// reuse the helper exports.
//
// A naive `import.meta.url === \`file://${argv[1]}\`` check breaks when the
// plugin is installed: pnpm/npm expose the binary as `node_modules/.bin/<name>`
// (often a symlink or .cmd shim), so `argv[1]` points at the shim while
// `import.meta.url` resolves to the realpath under `node_modules/<pkg>/dist/`.
// We compare the resolved paths so installed invocations always reach main().
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const selfPath = fileURLToPath(import.meta.url);
    let entryReal: string;
    try {
      entryReal = realpathSync(entry);
    } catch {
      entryReal = entry;
    }
    let selfReal: string;
    try {
      selfReal = realpathSync(selfPath);
    } catch {
      selfReal = selfPath;
    }
    if (selfReal === entryReal) return true;
    // Tolerate pathToFileURL round-tripping (Windows + drive-letter cases).
    return pathToFileURL(selfReal).href === pathToFileURL(entryReal).href;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch((err) => {
    process.stderr.write(`[${PLUGIN_NAME}] fatal: ${String(err)}\n`);
    process.exit(1);
  });
}

export { dispatch, manifest, identity, capabilities };
