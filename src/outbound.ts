// Outbound message senders — thin wrappers over `POST {base}/{phone-number-id}/messages`.
//
// We use Node 20+'s built-in global `fetch` so the dep tree stays empty.
// Each helper builds a JSON body in the shape Meta documents for the
// corresponding message type and returns the parsed JSON response (which
// includes the `messages[].id` the daemon can echo back to workflows).

export interface SendContext {
  accessToken: string;
  phoneNumberId: string;
  graphApiBase: string;
  /** Optional override for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface SendTextParams {
  to: string;
  body: string;
  /** Optional Meta preview-URL flag (mirrors API field name). */
  preview_url?: boolean;
}

export interface SendTemplateParams {
  to: string;
  /** Meta-approved template name. */
  template: string;
  /** BCP-47 language code, e.g. "en_US". */
  language?: string;
  /** Pre-built components array passed through verbatim to Meta. */
  components?: unknown[];
}

export type WhatsAppMediaKind = "image" | "audio" | "video" | "document" | "sticker";

export interface SendMediaParams {
  to: string;
  kind: WhatsAppMediaKind;
  /** Public URL Meta can fetch the media from. */
  url: string;
  /** Optional caption (image / video / document only). */
  caption?: string;
  /** Optional filename (document only). */
  filename?: string;
}

export interface SendResult {
  /** Raw JSON returned by Meta. Includes `messages[].id`. */
  meta_response: unknown;
  /** First message id Meta echoed back, surfaced for convenience. */
  message_id: string | null;
}

function buildEndpoint(ctx: SendContext): string {
  const base = ctx.graphApiBase.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(ctx.phoneNumberId)}/messages`;
}

async function postMessage(ctx: SendContext, body: unknown): Promise<SendResult> {
  const f = ctx.fetchImpl ?? fetch;
  const res = await f(buildEndpoint(ctx), {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  if (!res.ok) {
    throw new Error(`graph api ${res.status}: ${text || res.statusText}`);
  }
  let messageId: string | null = null;
  if (parsed && typeof parsed === "object" && parsed !== null) {
    const messages = (parsed as { messages?: unknown }).messages;
    if (Array.isArray(messages) && messages.length > 0) {
      const first = messages[0] as { id?: unknown } | undefined;
      if (first && typeof first.id === "string") messageId = first.id;
    }
  }
  return { meta_response: parsed, message_id: messageId };
}

/**
 * Build the request body for `whatsapp/send_text`. Exported for unit tests.
 */
export function buildTextBody(p: SendTextParams): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: p.to,
    type: "text",
    text: {
      body: p.body,
      ...(p.preview_url === undefined ? {} : { preview_url: p.preview_url }),
    },
  };
}

export function buildTemplateBody(p: SendTemplateParams): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    to: p.to,
    type: "template",
    template: {
      name: p.template,
      language: { code: p.language ?? "en_US" },
      ...(p.components ? { components: p.components } : {}),
    },
  };
}

export function buildMediaBody(p: SendMediaParams): Record<string, unknown> {
  const media: Record<string, unknown> = { link: p.url };
  if (p.caption && (p.kind === "image" || p.kind === "video" || p.kind === "document")) {
    media["caption"] = p.caption;
  }
  if (p.filename && p.kind === "document") {
    media["filename"] = p.filename;
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: p.to,
    type: p.kind,
    [p.kind]: media,
  };
}

export async function sendText(ctx: SendContext, params: SendTextParams): Promise<SendResult> {
  if (!params.to) throw new Error("send_text: `to` is required");
  if (!params.body) throw new Error("send_text: `body` is required");
  return postMessage(ctx, buildTextBody(params));
}

export async function sendTemplate(ctx: SendContext, params: SendTemplateParams): Promise<SendResult> {
  if (!params.to) throw new Error("send_template: `to` is required");
  if (!params.template) throw new Error("send_template: `template` is required");
  return postMessage(ctx, buildTemplateBody(params));
}

export async function sendMedia(ctx: SendContext, params: SendMediaParams): Promise<SendResult> {
  if (!params.to) throw new Error("send_media: `to` is required");
  if (!params.kind) throw new Error("send_media: `kind` is required");
  if (!params.url) throw new Error("send_media: `url` is required");
  return postMessage(ctx, buildMediaBody(params));
}
