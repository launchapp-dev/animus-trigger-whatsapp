// Meta webhook payload → Animus TriggerEvent mapping.
//
// The Meta WhatsApp Business Cloud API delivers an "entry"/"changes"/"value"
// envelope on every webhook POST. For inbound messages, `value.messages[]` is
// populated, with one entry per message in the batch. We surface ONE
// TriggerEvent per inbound message, keyed by Meta's `id` so the daemon can
// dedupe redelivered events.
//
// v0.1.0 emits a single Animus event kind, `whatsapp.message`, with the
// original Meta message JSON preserved verbatim under `payload` so workflow
// YAML can template against `{{trigger.payload.text.body}}`,
// `{{trigger.payload.from}}`, etc.

export const KIND_WHATSAPP_MESSAGE = "whatsapp.message";
export const ACTION_HINT_CREATE_TASK = "create_task";

export interface TriggerEvent {
  id: string;
  occurred_at: string;
  kind: string;
  payload: unknown;
  subject_id?: string | null;
  action_hint?: string | null;
}

interface MetaMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: unknown;
  audio?: unknown;
  video?: unknown;
  document?: unknown;
  // Other fields are passed through untouched.
  [k: string]: unknown;
}

interface MetaValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: unknown[];
  messages?: MetaMessage[];
  statuses?: unknown[];
}

interface MetaChange {
  field?: string;
  value?: MetaValue;
}

interface MetaEntry {
  id?: string;
  changes?: MetaChange[];
}

export interface MetaWebhookEnvelope {
  object?: string;
  entry?: MetaEntry[];
}

/** The set of message `type` values we surface as v0.1.0 events. */
const SUPPORTED_MESSAGE_TYPES = new Set([
  "text",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "voice",
  "location",
  "contacts",
  "reaction",
]);

function parseMetaTimestamp(ts: string | undefined): string {
  if (!ts) return new Date().toISOString();
  // Meta delivers a UNIX seconds string. Reject anything non-numeric and fall
  // back to "now" so a malformed payload doesn't poison the event.
  const secs = Number.parseInt(ts, 10);
  if (!Number.isFinite(secs) || secs <= 0) return new Date().toISOString();
  return new Date(secs * 1000).toISOString();
}

function buildEventId(phoneNumberId: string | undefined, msgId: string | undefined): string {
  const sender = phoneNumberId ?? "unknown";
  const id = msgId ?? `gen-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  return `whatsapp:${sender}/${id}`;
}

/**
 * Walk a Meta webhook envelope and emit one TriggerEvent per inbound
 * `messages[]` entry. Statuses (delivered / read receipts) are intentionally
 * ignored in v0.1.0.
 */
export function mapWebhookEnvelope(envelope: MetaWebhookEnvelope): TriggerEvent[] {
  const out: TriggerEvent[] = [];
  if (envelope.object !== "whatsapp_business_account") return out;
  for (const entry of envelope.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value;
      if (!value || !Array.isArray(value.messages)) continue;
      const phoneNumberId = value.metadata?.phone_number_id;
      for (const msg of value.messages) {
        if (!msg || typeof msg !== "object") continue;
        const msgType = typeof msg.type === "string" ? msg.type : "unknown";
        if (!SUPPORTED_MESSAGE_TYPES.has(msgType)) continue;
        out.push({
          id: buildEventId(phoneNumberId, msg.id),
          occurred_at: parseMetaTimestamp(msg.timestamp),
          kind: KIND_WHATSAPP_MESSAGE,
          payload: {
            message: msg,
            metadata: value.metadata ?? null,
            contacts: value.contacts ?? null,
            entry_id: entry.id ?? null,
          },
          subject_id: null,
          action_hint: ACTION_HINT_CREATE_TASK,
        });
      }
    }
  }
  return out;
}
