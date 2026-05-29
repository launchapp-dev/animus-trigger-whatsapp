import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

import {
  KIND_WHATSAPP_MESSAGE,
  mapWebhookEnvelope,
  type MetaWebhookEnvelope,
} from "./inbound.js";
import { verifySignature } from "./webhook-server.js";
import {
  buildMediaBody,
  buildTemplateBody,
  buildTextBody,
  sendMedia,
  sendTemplate,
  sendText,
  type SendContext,
} from "./outbound.js";

describe("verifySignature", () => {
  const secret = "test-app-secret";
  const body = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");

  it("accepts a valid sha256= signature", () => {
    const digest = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifySignature(body, `sha256=${digest}`, secret)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const digest = createHmac("sha256", secret).update(body).digest("hex");
    const tampered = Buffer.from(JSON.stringify({ hello: "evil" }), "utf8");
    expect(verifySignature(tampered, `sha256=${digest}`, secret)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const digest = createHmac("sha256", "other-secret").update(body).digest("hex");
    expect(verifySignature(body, `sha256=${digest}`, secret)).toBe(false);
  });

  it("rejects missing prefix", () => {
    const digest = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifySignature(body, digest, secret)).toBe(false);
  });

  it("rejects empty header", () => {
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, "", secret)).toBe(false);
  });

  it("rejects when app secret is empty", () => {
    const digest = createHmac("sha256", "anything").update(body).digest("hex");
    expect(verifySignature(body, `sha256=${digest}`, "")).toBe(false);
  });
});

describe("mapWebhookEnvelope", () => {
  it("emits one whatsapp.message event per inbound text message", () => {
    const envelope: MetaWebhookEnvelope = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "ENTRY123",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+15551234567",
                  phone_number_id: "PHONE_ID_1",
                },
                contacts: [{ profile: { name: "Ada" }, wa_id: "15555550100" }],
                messages: [
                  {
                    id: "wamid.ABC123",
                    from: "15555550100",
                    timestamp: "1716000000",
                    type: "text",
                    text: { body: "hello there" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const events = mapWebhookEnvelope(envelope);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event_id).toBe("whatsapp:PHONE_ID_1/wamid.ABC123");
    // No triggerId supplied → null so the host can still log + drop deliberately.
    expect(ev.trigger_id).toBeNull();
    expect(ev.action_hint).toBe("create_task");
    const payload = ev.payload as {
      kind: string;
      occurred_at: string;
      message: { text: { body: string } };
    };
    expect(payload.kind).toBe(KIND_WHATSAPP_MESSAGE);
    expect(payload.occurred_at).toBe(new Date(1716000000 * 1000).toISOString());
    expect(payload.message.text.body).toBe("hello there");
  });

  it("emits events for image, document, audio types", () => {
    const envelope: MetaWebhookEnvelope = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "P" },
                messages: [
                  { id: "m1", type: "image", image: { id: "img1" } },
                  { id: "m2", type: "document", document: { id: "doc1" } },
                  { id: "m3", type: "audio", audio: { id: "aud1" } },
                ],
              },
            },
          ],
        },
      ],
    };
    const events = mapWebhookEnvelope(envelope);
    expect(events.map((e) => e.event_id)).toEqual([
      "whatsapp:P/m1",
      "whatsapp:P/m2",
      "whatsapp:P/m3",
    ]);
  });

  it("ignores statuses-only payloads (delivery receipts)", () => {
    const envelope: MetaWebhookEnvelope = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "P" },
                statuses: [{ id: "wamid.X", status: "delivered" }],
              },
            },
          ],
        },
      ],
    };
    expect(mapWebhookEnvelope(envelope)).toEqual([]);
  });

  it("ignores envelopes from other product objects", () => {
    const envelope: MetaWebhookEnvelope = {
      object: "page",
      entry: [{ changes: [{ field: "messages", value: { messages: [{ id: "x", type: "text" }] } }] }],
    };
    expect(mapWebhookEnvelope(envelope)).toEqual([]);
  });

  it("ignores unsupported message types (button echoes, etc.)", () => {
    const envelope: MetaWebhookEnvelope = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "P" },
                messages: [{ id: "x", type: "button" }],
              },
            },
          ],
        },
      ],
    };
    expect(mapWebhookEnvelope(envelope)).toEqual([]);
  });

  it("stamps the supplied trigger_id onto every emitted event", () => {
    const envelope: MetaWebhookEnvelope = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "P" },
                messages: [
                  { id: "m1", type: "text", text: { body: "a" } },
                  { id: "m2", type: "text", text: { body: "b" } },
                ],
              },
            },
          ],
        },
      ],
    };
    const events = mapWebhookEnvelope(envelope, "whatsapp-inbound");
    expect(events).toHaveLength(2);
    for (const ev of events) {
      expect(ev.trigger_id).toBe("whatsapp-inbound");
    }
  });

  it("falls back to now when timestamp is missing", () => {
    const before = Date.now();
    const events = mapWebhookEnvelope({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: { metadata: { phone_number_id: "P" }, messages: [{ id: "m", type: "text" }] },
            },
          ],
        },
      ],
    });
    const after = Date.now();
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as { occurred_at: string };
    const ts = Date.parse(payload.occurred_at);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("outbound body builders", () => {
  it("buildTextBody shapes the WhatsApp text payload", () => {
    expect(buildTextBody({ to: "15555550100", body: "hi" })).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15555550100",
      type: "text",
      text: { body: "hi" },
    });
  });

  it("buildTextBody passes preview_url through when set", () => {
    const out = buildTextBody({ to: "x", body: "https://example.com", preview_url: true });
    expect(out["text"]).toEqual({ body: "https://example.com", preview_url: true });
  });

  it("buildTemplateBody defaults language to en_US", () => {
    expect(buildTemplateBody({ to: "x", template: "hello_world" })).toEqual({
      messaging_product: "whatsapp",
      to: "x",
      type: "template",
      template: { name: "hello_world", language: { code: "en_US" } },
    });
  });

  it("buildTemplateBody honors components + language", () => {
    const out = buildTemplateBody({
      to: "x",
      template: "order_ack",
      language: "es_ES",
      components: [{ type: "body", parameters: [{ type: "text", text: "A" }] }],
    });
    expect(out["template"]).toMatchObject({
      name: "order_ack",
      language: { code: "es_ES" },
      components: [{ type: "body", parameters: [{ type: "text", text: "A" }] }],
    });
  });

  it("buildMediaBody attaches caption only for image/video/document", () => {
    expect(buildMediaBody({ to: "x", kind: "image", url: "u", caption: "c" })).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "x",
      type: "image",
      image: { link: "u", caption: "c" },
    });
    const audio = buildMediaBody({ to: "x", kind: "audio", url: "u", caption: "ignored" });
    expect(audio["audio"]).toEqual({ link: "u" });
  });

  it("buildMediaBody attaches filename only for documents", () => {
    const doc = buildMediaBody({
      to: "x",
      kind: "document",
      url: "u",
      filename: "report.pdf",
    });
    expect(doc["document"]).toEqual({ link: "u", filename: "report.pdf" });
  });
});

describe("outbound HTTP shape", () => {
  function mockFetch(responseBody: unknown, status = 200): typeof fetch {
    return vi.fn(async () =>
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
  }

  it("sendText calls the configured endpoint with bearer auth + correct JSON body", async () => {
    const fetchImpl = mockFetch({ messages: [{ id: "wamid.OUT1" }] });
    const ctx: SendContext = {
      accessToken: "TOKEN",
      phoneNumberId: "PNID",
      graphApiBase: "https://graph.facebook.com/v18.0",
      fetchImpl,
    };
    const out = await sendText(ctx, { to: "15555550100", body: "hello" });
    expect(out.message_id).toBe("wamid.OUT1");
    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v18.0/PNID/messages");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer TOKEN");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15555550100",
      type: "text",
      text: { body: "hello" },
    });
  });

  it("sendTemplate posts the template body", async () => {
    const fetchImpl = mockFetch({ messages: [{ id: "wamid.T1" }] });
    const ctx: SendContext = {
      accessToken: "T",
      phoneNumberId: "P",
      graphApiBase: "https://graph.facebook.com/v18.0",
      fetchImpl,
    };
    await sendTemplate(ctx, { to: "x", template: "ack" });
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0]!;
    const body = JSON.parse(init.body as string) as { type: string; template: { name: string } };
    expect(body.type).toBe("template");
    expect(body.template.name).toBe("ack");
  });

  it("sendMedia posts media body", async () => {
    const fetchImpl = mockFetch({ messages: [{ id: "wamid.M1" }] });
    const ctx: SendContext = {
      accessToken: "T",
      phoneNumberId: "P",
      graphApiBase: "https://graph.facebook.com/v18.0",
      fetchImpl,
    };
    await sendMedia(ctx, { to: "x", kind: "image", url: "https://example.com/p.png" });
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0]!;
    const body = JSON.parse(init.body as string) as { type: string; image: { link: string } };
    expect(body.type).toBe("image");
    expect(body.image.link).toBe("https://example.com/p.png");
  });

  it("propagates Graph API errors as thrown errors", async () => {
    const fetchImpl = mockFetch({ error: { message: "bad token" } }, 401);
    const ctx: SendContext = {
      accessToken: "BAD",
      phoneNumberId: "P",
      graphApiBase: "https://graph.facebook.com/v18.0",
      fetchImpl,
    };
    await expect(sendText(ctx, { to: "x", body: "hi" })).rejects.toThrow(/graph api 401/);
  });

  it("strips trailing slash on graphApiBase", async () => {
    const fetchImpl = mockFetch({ messages: [{ id: "wamid.SLASH" }] });
    const ctx: SendContext = {
      accessToken: "T",
      phoneNumberId: "P",
      graphApiBase: "https://graph.facebook.com/v18.0/",
      fetchImpl,
    };
    await sendText(ctx, { to: "x", body: "hi" });
    const [url] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(url).toBe("https://graph.facebook.com/v18.0/P/messages");
  });
});
