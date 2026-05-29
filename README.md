# animus-trigger-whatsapp

WhatsApp Business Cloud API trigger backend plugin for [Animus](https://github.com/launchapp-dev).

Receives inbound WhatsApp messages via Meta's webhook delivery and exposes
outbound send RPCs so workflows can reply through the Graph API.

## Highlights

- **Inbound**: tiny built-in HTTP server (Node `http` + `crypto`, zero web framework dependencies) hosts a Meta-compatible webhook endpoint. Validates the `GET` verification handshake and every `POST`'s `X-Hub-Signature-256` HMAC before parsing.
- **Outbound (custom RPCs)**:
  - `whatsapp/send_text` — plain text messages
  - `whatsapp/send_template` — Meta-approved template messages (with language + components)
  - `whatsapp/send_media` — image/audio/video/document by public URL
- **Stdio plugin protocol**: integrates with the Animus plugin host via newline-delimited JSON-RPC. The SDK wires `initialize`, `health/check`, `shutdown`, and `exit` automatically.
- **TypeScript, Node 20+, ESM, zero runtime dependencies** (other than the Animus SDK).

## Platform choice

This plugin targets the [WhatsApp Business Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) — Meta's officially hosted webhook + send service. It does **not** support:

- WhatsApp Business On-Premise (Meta has [deprecated](https://developers.facebook.com/docs/whatsapp/on-premises-api/end-of-life) it),
- third-party libraries like `whatsapp-web.js` (against Meta's Terms of Service for any business use).

## Methods

| Method                    | Direction | Notes |
|---------------------------|-----------|-------|
| `trigger/schema`          | call      | Returns `{ kinds: ["whatsapp.message"], supports_resume, supports_dedup, supports_ack }` |
| `trigger/watch`           | call      | Binds the embedded HTTP server. Emits `trigger/event` notifications. |
| `trigger/ack`             | call      | No-op for v0.1.0 (Meta does not use Animus event ids). |
| `whatsapp/send_text`      | call      | `{ to, body, preview_url? }` |
| `whatsapp/send_template`  | call      | `{ to, template, language?, components? }` |
| `whatsapp/send_media`     | call      | `{ to, kind, url, caption?, filename? }` |
| `health/check`            | call      | Reflects whether required env vars are set. |

Inbound events surface as a single Animus event kind, `whatsapp.message`. The payload preserves Meta's original JSON verbatim under `payload.message`, plus `metadata` and `contacts` siblings.

## Environment variables

| Name | Required | Description |
|------|----------|-------------|
| `WHATSAPP_ACCESS_TOKEN` | yes | Meta Graph API access token. Prefer a long-lived **system-user** token from Business Manager. |
| `WHATSAPP_PHONE_NUMBER_ID` | yes | The numeric WABA phone-number-id (not the +E.164 number itself). Find it in WhatsApp Manager → Phone Numbers. |
| `WHATSAPP_VERIFY_TOKEN` | yes | Operator-chosen shared secret used for the `GET /webhook` verification handshake. Must match what you typed into Meta's webhook UI. |
| `WHATSAPP_APP_SECRET` | yes | Meta App Secret. Used to validate the `X-Hub-Signature-256` HMAC on every inbound `POST`. **Mandatory in production** — leaving it unset disables signature verification and logs a warning. |
| `WHATSAPP_WEBHOOK_PORT` | no | Port the embedded HTTP server binds to. Default `8089`. |
| `WHATSAPP_WEBHOOK_PATH` | no | Path the webhook is served on. Default `/webhook`. |
| `WHATSAPP_GRAPH_API_BASE` | no | Override the Graph API base URL. Default `https://graph.facebook.com/v22.0`. |

## Setup

### 1. Register a WhatsApp Business App with Meta

1. Go to [Meta for Developers → My Apps](https://developers.facebook.com/apps/).
2. Create an app of type **Business**.
3. Under **Add products**, add **WhatsApp**.
4. In the WhatsApp panel:
   - Note the **Phone number ID** (this is `WHATSAPP_PHONE_NUMBER_ID`).
   - Generate a temporary access token (or, for production, a system-user token from Business Manager → System Users). This is `WHATSAPP_ACCESS_TOKEN`.
5. Under **App settings → Basic**, copy the **App Secret**. This is `WHATSAPP_APP_SECRET`.

### 2. Choose a verify token

Pick any opaque string. Meta will echo your `hub.challenge` back to you only if your endpoint replies with this same value. Set it as `WHATSAPP_VERIFY_TOKEN`.

### 3. Expose the webhook publicly

The plugin runs an HTTP listener on `0.0.0.0:8089/webhook` by default. Meta requires HTTPS, so:

- **Dev**: `ngrok http 8089` and use the `https://*.ngrok-free.app/webhook` URL.
- **Prod**: terminate TLS at your reverse proxy (Caddy / nginx / Cloudflare Tunnel) and forward to the plugin.

### 4. Configure Meta's webhook

In the WhatsApp panel of your Meta app:

1. **Configuration → Webhook**: paste the public URL and `WHATSAPP_VERIFY_TOKEN`. Click **Verify and save**. Meta will fire a `GET` with `hub.mode=subscribe`; the plugin replies with `hub.challenge` only when the token matches.
2. **Subscribe** to the `messages` field.

### 5. Install + run

```bash
animus plugin install launchapp-dev/animus-trigger-whatsapp@v0.1.0

# Daemon-side environment (typically via the daemon's env file)
export WHATSAPP_ACCESS_TOKEN=EAAG...
export WHATSAPP_PHONE_NUMBER_ID=1234567890
export WHATSAPP_VERIFY_TOKEN=my-shared-secret
export WHATSAPP_APP_SECRET=abc123...

animus daemon restart
```

### 6. Wire the trigger in a workflow

```yaml
triggers:
  whatsapp_inbox:
    backend: animus-trigger-whatsapp
    kinds: [whatsapp.message]
    on_event:
      action: create_task
      title: "WhatsApp from {{ trigger.payload.message.from }}: {{ trigger.payload.message.text.body }}"

workflows:
  whatsapp_auto_reply:
    on_trigger: whatsapp_inbox
    steps:
      - call: whatsapp/send_text
        params:
          to: "{{ trigger.payload.message.from }}"
          body: "Thanks — we received your message."
```

## Local development

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
node dist/index.js --manifest    # print the plugin manifest
```

## NOT covered in v0.1.0

- Interactive lists / buttons (Meta `interactive` message type) — receive-side handled (`type: text` only echoed; future versions will expose `whatsapp/send_interactive`).
- Business catalog / product messages.
- Per-message ack with Meta-side `mark_as_read`.
- Multi-WABA support (one plugin instance = one phone-number-id).
- Outbound media upload (we accept a public URL; Meta media-id upload is a future enhancement).
- Reaction outbound send.

## License

[Elastic License 2.0](./LICENSE)
