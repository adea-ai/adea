# Shared transcript adoption: runtime event boundary

This source audit separates the shared renderer from the native runtime's actual
event producers. It accompanies the donor UI migration; it is not evidence of a
working production ACP stream or successful assistant response.

## Verified source contract

- `packages/types/src/dev-runtime-wire.ts` enumerates assistant, tool, approval,
  and question event kinds, but their payload is `unknown`. Payload validation
  checks bounded JSON, not per-kind call identity, interaction eligibility,
  synthesis, or substantive-answer semantics. Transport provenance binds the
  envelope's source; a nested payload field named `source` is not that authority.
- `apps/desktop/shell/src/dev-runtime/harness/acp-lane.ts` declares a driver
  with spawn, close, and optional prompt delivery. It has no structured-event
  subscription seam. Advertised optional `tools` capability is not evidence that
  a particular call or result was emitted.
- `apps/desktop/shell/src/dev-runtime/harness/register.ts` appends
  `turn.user_input` after successful delivery. Its payload records transport,
  connection/process identity, and byte count; it omits the prompt text. This is
  a delivery receipt, not a content-bearing user message.
- The register appends lifecycle facts and observed run transitions. Process
  exit or run completion does not prove a final assistant answer. Without an
  injected ACP driver, it uses the typed unavailable fallback. The production
  Dev Runtime source contains no emitter for assistant, tool, approval, or
  question events.
- The canonical event-stream specification in
  [Dev Runtime](../specs/dev-runtime.md) explicitly forbids fabricating harness
  turn/tool/approval events from host lifecycle facts.

## Consumer boundary

The shared `TranscriptComposition` accepts already redacted, host-classified
rows. Stable identity and presentation can be adopted independently. Current
runtime data does not establish call phases, call IDs, noninteractive tool
eligibility, synthesis, or final-answer boundaries. Unknown rows must remain
visible and unfolded; approvals, questions, failures, and interactive content
must retain their existing actions and authority checks. Do not infer those
classifications from label text, kind prefixes, connection state, process exit,
or nested payload metadata.

Production folding requires a native structured-event producer and validated
per-kind payload contracts first. That runtime work belongs to the owning
session/event implementation, rather than a policy or protocol parser inside
shared UI. Adea issue #717 remains open: returning-user surface integration,
real session-route continuity, and native runtime qualification are distinct
acceptance gates. Fixture browser tests and packed renderer tests do not close
those native gates.
