# Changelog

All notable changes to `@launchapp-dev/animus-trigger-whatsapp` are documented
here. This project follows [Semantic Versioning](https://semver.org/).

## 0.1.1 - 2026-05-28

### Fixed

- **Wire shape for `trigger/event` notifications.** v0.1.0 emitted
  `params = { id: <watch_request_id>, event: { id, occurred_at, kind, payload, ... } }`
  per the (stale) `animus-protocol/spec.md` §7.3 wrapper. The live daemon
  trigger supervisor (see
  `crates/orchestrator-daemon-runtime/src/schedule/trigger_supervisor.rs`
  around line 289) calls
  `serde_json::from_value::<TriggerEvent>(notification.params)` — `params`
  IS the `TriggerEvent`, not a wrapper. v0.1.0 events were therefore
  silently dropped at runtime against the live host.
- Switched to the flat shape that matches
  `crates/animus-plugin-protocol/src/lib.rs::TriggerEvent` field-for-field:
  `event_id` (was `id`), `trigger_id`, `subject_id`, `subject_kind`,
  `action_hint`, `payload`. The `kind` discriminator and Meta-derived
  `occurred_at` timestamp now ride along inside `payload` so workflow
  templates can still reach them via `{{trigger.payload.kind}}` /
  `{{trigger.payload.occurred_at}}`.

### Added

- `WHATSAPP_TRIGGER_ID` env var. The daemon's `route_event` (see
  `crates/orchestrator-daemon-runtime/src/schedule/trigger_supervisor.rs`
  around line 602) drops any event whose `trigger_id` is `None`. Operators
  set this to the `id` of the `WorkflowTrigger` in `.animus/workflows.yaml`
  so emitted events get routed to the matching workflow. As a fallback the
  plugin also accepts `params.trigger_id` (sibling-plugin convention) or
  `params.config.trigger_id` from `trigger/watch` if the host overlays one.
- A WARN line on stderr when `trigger/watch` starts without a configured
  `trigger_id`, since events will be dropped at the router until it's set.

### Upgrade notes

- v0.1.0 will not work at runtime against any current Animus daemon —
  upgrade to 0.1.1 before installing in production.
- Workflow templates that previously dereferenced `trigger.event.payload.*`
  now read `trigger.payload.*`. Templates that referenced `trigger.event.kind`
  or `trigger.event.occurred_at` should move to `trigger.payload.kind` /
  `trigger.payload.occurred_at`.
- Set `WHATSAPP_TRIGGER_ID` in the daemon environment to the id of the
  matching `WorkflowTrigger`; otherwise the host will drop every event
  with an "lacks trigger_id" diagnostic.

## 0.1.0 - 2026-05-28

- Initial release. **Do not deploy** — see 0.1.1 notes; the
  `trigger/event` wire shape is incompatible with the host deserializer.
