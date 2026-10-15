# Structured activity contract handoff (#1394)

This is contract and admission evidence. No native/ACP producer, command/test
runner, output parser, renderer or successful production run is claimed.
The normative [runtime spec](../specs/dev-runtime.md#structured-activity-producer-contracts-1394)
and `packages/types/src/dev-runtime-activity/` define the schemas.

## Ownership and integration

Issue #1394 is isolated from assistant-message #1386, call identity #1387,
citations #1389, usage #1391, interactions #1395, user-owned #1396, UI #416 and
consumer #1385. It neither imports their unmerged implementations nor changes
their branches. The six new kinds do not overload `turn.result`, tool calls,
usage, questions, approvals, queue or reasoning records.

Shared aggregation hunks need coordinator integration:

- `packages/types/src/dev-runtime-wire.ts`: add the activity kind spread,
  shape dispatcher and strict ownership decoder alongside the other contracts.
  Preserve every existing kind, legacy branch and per-kind decoder. The full
  CBOR envelope helper and 65,536-byte constant are also used by the separate
  PR #1399 size repair; retain one identical helper when combining them.
- `packages/types/src/dev-runtime.ts`: combine additive type/value exports;
  deduplicate only the shared CBOR helper exports.
- `packages/types/package.json`: retain this focused activity subpath and any
  other owners' additive subpaths; no dependency or lockfile change is needed.
- `apps/desktop/shell/src/dev-runtime/harness/events.ts`: keep the separate
  activity provenance argument, snapshots and semantic chunk dedupe alongside
  #1387's call admission/eligibility verifier. Source-event equality dispatches
  by contract kind; neither branch may remove the other's identity/provenance
  checks. Nonactivity legacy appends retain their original behavior here.
- `docs/specs/dev-runtime.md`: retain each issue's adjacent normative subsection.
  The new evidence link belongs to #1394; no shared provenance ledger is edited.

The per-event provenance argument is supplied by the owning authenticated
adapter, not deserialized from request/event JSON or inferred from a capability
advertisement. Generic replay returns unknown payload data and cannot be used
as owned activity admission. Consumer UI can therefore retain plain Trace rows
until its separately reviewed integration is ready.

## Evidence and limits

The tests exercise all six schemas, partial-list/count disagreement, explicit
unknown status with exit code zero, restart survival, malformed records,
unsafe paths/URLs, source/confidence/ownership refusal, immutable snapshots,
canonical replay, and terminal identity across source/session/generation/run/
command/stream. Legacy opaque rows remain readable and cannot be appended as
new structured facts.

Boundary tests measure actual UTF-8 JSON and canonical CBOR. An authority-minted
`runtime-events-v1` grant retains its existing 65,536-byte maximum. Individually
valid payload fields whose whole event exceeds that limit are refused before
log writes; an exactly fitting event round-trips through the real stream frame
codec. A one-byte ASCII excess and same-character-count multibyte excess are
refused. No transport cap is increased. Authenticated-hook observations keep
their tighter 8 KiB envelope fence.

## Independent review repairs

Review of head `afb4cb9bdc9fa5008dbe632f6ecca8d40834c7f0` found three issues:
distinct lone surrogates collapsed to the same CBOR text, an exact-fit event
at sequence 9 could not retry because its provisional sequence was 10, and
the address guard omitted U+061C, U+200E and U+200F. Four focused regressions
failed on that head before the repairs.

The repair rejects ill-formed Unicode in payloads, keys and envelope data and
in the CBOR encoder itself, without normalizing valid text. Address tests cover
raw paths and raw/escaped URLs for every bidi-control range. Replay validation
returns no new event; ownership/schema/Unicode checks and identity/content
comparison precede the budget for a genuinely new envelope. Duplicate results
carry no event value that could be persisted accidentally. New records still
pass the original full-frame and hook ceilings before publication.

Additional tests cover an exact 65,536-byte sequence-9 retry, terminal semantic
replay with a longer source event ID, an exact 8 KiB hook retry, missing owner
proof, changed content, ill-formed replay IDs and oversize new sequence-10
events. No count/status is inferred and no limit or legacy authority changes.
The Unicode helper and validation-only replay mechanism also accompany the
separate call-contract repair; coordinator integration must retain both
contracts' final new-event budget and permission/ownership gates.

Limits are conservative contract defaults, not packaged performance or native
producer qualification. Actual producer ownership, redaction/classification,
raw-frame limits, transport integration, consumer rendering and packaged
acceptance remain separately owned work. No counts or statuses are recomputed
from the fixture rows or inferred from process/lifecycle facts.
