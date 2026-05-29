// Tiny built-in HTTP server that hosts the Meta WhatsApp webhook endpoint.
//
// Two routes:
//   GET  <path>?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
//     → verification handshake; echoes `hub.challenge` when the verify token
//       matches the operator-configured value.
//   POST <path>
//     → message delivery; validates X-Hub-Signature-256 (HMAC-SHA256 over the
//       raw request body, keyed by WHATSAPP_APP_SECRET) and parses the JSON
//       envelope. Each parsed message is dispatched to `onEvent`.
//
// We use Node's built-in `http` + `crypto` to keep the dependency surface tiny
// (the Animus plugin host clears the daemon env on spawn and forwards only an
// allowlist; fewer deps = smaller attack surface + faster cold start).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";

import { mapWebhookEnvelope, type TriggerEvent, type MetaWebhookEnvelope } from "./inbound.js";

export interface WebhookServerOptions {
  port: number;
  path: string;
  verifyToken: string;
  /** Operator-supplied Meta App Secret. When empty, signature checks are
   *  SKIPPED and every POST is logged with a warning. */
  appSecret: string;
  /** Logical Animus trigger id stamped onto emitted events so the daemon
   *  router can match them to a `WorkflowTrigger`. May be empty. */
  triggerId?: string;
  /** Called for every parsed inbound TriggerEvent. */
  onEvent: (event: TriggerEvent) => void | Promise<void>;
  /** Optional diagnostic sink; defaults to stderr. Stdout is reserved for
   *  JSON-RPC frames. */
  logger?: (msg: string) => void;
}

export interface WebhookServerHandle {
  server: Server;
  close(): Promise<void>;
}

const defaultLogger = (msg: string): void => {
  process.stderr.write(`[animus-trigger-whatsapp] ${msg}\n`);
};

/**
 * Validate Meta's `X-Hub-Signature-256` header against the raw request body.
 * Returns `true` if the signature is well-formed AND matches, `false` otherwise.
 * Designed to be exported for unit testing without spinning up the server.
 */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!appSecret) return false;
  if (!header || typeof header !== "string") return false;
  const prefix = "sha256=";
  if (!header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length);
  // Expected hex digest from HMAC-SHA256.
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendStatus(res: ServerResponse, code: number, body = ""): void {
  res.statusCode = code;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

export function startWebhookServer(opts: WebhookServerOptions): Promise<WebhookServerHandle> {
  const log = opts.logger ?? defaultLogger;

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log(`unhandled webhook error: ${String(err)}`);
      if (!res.headersSent) sendStatus(res, 500, "internal error");
    });
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    // The Node URL class wants a base — Meta does not send Host header
    // guarantees, so synthesize one. Path-only matching below.
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== opts.path) {
      sendStatus(res, 404, "not found");
      return;
    }

    if (method === "GET") {
      // Meta verification handshake.
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge") ?? "";
      if (mode === "subscribe" && token && token === opts.verifyToken) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(challenge);
        return;
      }
      sendStatus(res, 403, "verification failed");
      return;
    }

    if (method !== "POST") {
      sendStatus(res, 405, "method not allowed");
      return;
    }

    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch (err) {
      log(`failed to read webhook body: ${String(err)}`);
      sendStatus(res, 400, "bad body");
      return;
    }

    const sig = req.headers["x-hub-signature-256"];
    const sigHeader = Array.isArray(sig) ? sig[0] : sig;
    if (opts.appSecret) {
      if (!verifySignature(raw, sigHeader, opts.appSecret)) {
        log("signature validation failed; rejecting webhook POST");
        sendStatus(res, 401, "signature mismatch");
        return;
      }
    } else {
      log("WARNING: WHATSAPP_APP_SECRET is empty; accepting webhook without signature check");
    }

    let envelope: MetaWebhookEnvelope;
    try {
      envelope = JSON.parse(raw.toString("utf8")) as MetaWebhookEnvelope;
    } catch (err) {
      log(`webhook body is not valid JSON: ${String(err)}`);
      sendStatus(res, 400, "bad json");
      return;
    }

    const events = mapWebhookEnvelope(envelope, opts.triggerId ?? "");
    for (const ev of events) {
      try {
        await opts.onEvent(ev);
      } catch (err) {
        log(`onEvent handler threw for ${ev.event_id}: ${String(err)}`);
      }
    }
    // Always 200 once we've parsed the body — per Meta, anything else triggers
    // retry storms.
    sendStatus(res, 200, "ok");
  };

  const handle_: WebhookServerHandle = {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };

  return new Promise<WebhookServerHandle>((resolve, reject) => {
    const onError = (err: Error): void => {
      // Bind failure (e.g. EADDRINUSE) surfaces here asynchronously. Reject
      // the start promise so callers can return a JSON-RPC error instead of
      // crashing the process with an unhandled exception.
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      // Keep a long-lived error listener installed for runtime issues so they
      // surface in logs instead of as unhandled exceptions.
      server.on("error", (err) => log(`webhook server runtime error: ${String(err)}`));
      resolve(handle_);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(opts.port);
  });
}
