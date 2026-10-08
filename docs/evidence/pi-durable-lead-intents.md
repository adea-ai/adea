# Lead-turn admission and product candidate

This continuation supports [U1 (#1172)](https://github.com/adea-ai/adea/issues/1172)
and [U2 (#1173)](https://github.com/adea-ai/adea/issues/1173) after the independent
workspace lead/topic foundation. It does not implement their integrated acceptance journey.

The product candidate adds model defaults and exact payer review, channel-bound intent
recovery, preparation, explicit dispatch, status/progress and truthful cancellation.
These paths remain unavailable without the released compatible SDK and trusted runtime,
model, original-actor and publication composition. Focused mock/port tests are separate
from PostgreSQL, actual packaged HTTP/runtime and mounted UI qualification.

## Atomic canonical admission

The existing message endpoint accepts an explicit `leadTurn: true` with a body or body
reference, artifacts and mentions. A caller cannot supply execution, session, selection,
plan, budget, sender or child authority in this mode. Ordinary message writes and direct
project/session history remain unchanged and create no lead intent.

`createLeadTurn` locks the live workspace, membership, direct channel, designated lead
and current audience through the transaction. It requires the sender and lead to be
channel participants and the user audience to retain workspace membership. Message,
canonical `message.created` event and `lead_turn_intents` row commit together. Failure
before commit rolls all three back. A retry after commit returns the same message and
intent; changing request content or admission mode under the same key conflicts.

The intent uses a UUID and `lead-turn:<UUID>` dispatch key. It pins Adea and CP Agent
identities, profile identity/version/revision, channel version/visibility, original sender
and sorted audience references. It contains no credential, model authorization, copied
message body or runtime session. The canonical message remains the content authority.
Retry and inspection recheck live authority rather than treating these pins as a grant.

Migration 0043 adds only the intent table and preserves all previous table definitions.
It intentionally admits only `state: 'blocked'` with
`reasonCode: 'ADMISSION_SERVICE_UNAVAILABLE'`. The API returns that bounded receipt.
Saving a message is therefore distinguishable from runtime admission and execution.
The receipt is durable recovery identity for a future authorized dispatcher, not evidence
that a dispatcher is currently installed. An authorized participant can inspect the
receipt via the server database function without taking over the original sender's intent.

## Model readiness boundary

`model-selection-readiness.ts` accepts only the agreed `{ ready, reasonCode }` projection
and maps safe reason codes to bounded remedies. Unknown, malformed, contradictory or
extra-field objects become `READINESS_UNAVAILABLE`; upstream free text, credential refs
and secrets cannot reach the result. This projection is not model resolution or an
inference grant. Connector credentials never imply model readiness.

## Integration prerequisites

The pinned Adea SDK does not expose the new model-connection and Pi lead dispatch
operations, and the existing signer scope union does not include execution admission,
read or cancellation. No scope or credential changes are part of this slice. CP's
unpublished source contracts are useful for agreement but do not establish a public SDK
release or deployed composition.

Integration needs the released typed SDK, an authorized signer/service composition and
a trusted resolver for this exact UUID intent. CP must resolve accepted plans, attempts,
reservations and current product audience before inference, with project identity optional
for a standalone workspace lead. It must preserve the canonical `ses_` runtime session
mapping and immutable model selection, never invent a project or infer dispatch from history.

The original packed R1 proof accepted an optional/null project at its product authority port,
but that artifact's canonical execution plan required a project. Workspace-only input
therefore fails with `PI_LEAD_PROJECT_SCOPE_REQUIRED` before any admission marker,
command, attempt or budget record. Supporting a standalone workspace lead requires that
canonical plan/admission scope to support it as well as the SDK and signer prerequisites.
The product must not attach an unrelated project to bypass this boundary.

The later workspace-kernel and R1 source work must be qualified through a new immutable
composed artifact before this old negative receipt can be superseded. Source-positive
tests alone do not upgrade the earlier package proof.

## Prepare, disclosure and explicit start

Saving a lead message retains the draft and creates only its canonical message and blocked
intent. Recovery/status/progress reads cannot prepare or start inference. Preparation
persists the server-resolved execution/attempt/selection binding and the upstream retained
preparation reference/expiry without a runtime handle or session claim. The UI shows the
trusted provider, model, account, authentication mode, funding source and explicit payer;
it never infers the payer from the connection administrator. Before explicit start it
rereads the exact funding binding. A changed payer, revision, model or expiry blocks the
same accepted attempt. A fresh admission after canonical cancellation or expiry is required;
that retry path is not yet connected. The server independently checks retained confirmation and current
authority before runtime start. Missing confirmation composition denies dispatch.

The immutable R2 host-binding candidate is
[CP #962, `6475b1a49e1a49e9e79624829ac93c426535bafb`](https://github.com/adea-ai/control-plane/pull/962).
Its public funding schema remains unchanged. The host derives original actor and accepted
execution binding from server records; transport, admission and vault lease identities
remain separate. It retains the full current funding view as one immutable winner per
attempt, with expiry bounded by five minutes, funding and admission. Its private
confirmation reference is not a client capability. Native provider and recorded-spending
consumers must share the confirmed `forExecution` facade at physical-send boundaries.
This source identity does not establish a registry release, deployed composition or the
combined Adea/R1/R2 candidate proof. Production remains unavailable until that composition
and its exact artifact are qualified.

Interrupted unchanged message saves retain their local retry key; changing topic or
content creates a new submission. Canonical intent replay remains the server authority.
Prepared recovery remains read-only until an explicit confirmed start. Running, pending,
uncertain and terminal turns cannot be prepared again. Audience changes invalidate late
responses and payer confirmation without touching drafts or independent direct sessions.
Cancellation displays the observed acknowledgement, including `cancelling` when provider
charges or the final outcome remain uncertain. Waiting-for-input approval actions remain
unavailable until their governed interaction API is composed.

An external dispatch whose acknowledgement is lost may leave `dispatch_pending` without
its dispatch reference. The candidate uses R1's optional `pi-durable.lead.lookup` read
operation with only the canonical intent ID. Current reader, original actor and audience
authority are required. A null or incomplete receipt keeps the turn pending; only actual
persisted execution/attempt/dispatch/session references matching the accepted binding can
be retained. A subsequent status read supplies the observed execution state. Lookup cannot
prepare, replay funding, infer a new session ID or restart model work, including after
preparation expiry. Missing lookup composition keeps recovery unavailable. Its source
contract and fixture tests are not an immutable packaged or live integration claim.

Child outcome delivery additionally needs the exact admitted parent/child mapping and
retained J1 inbox artifact. A later Adea consumer must recheck audience and atomically append
the timeline record with an independent publication receipt. A retained outcome or sender
receipt is not public delivery. No child outcome consumer or UI is enabled here.

## Reproducible local checks

Qualification uses Node 24.21.0, Bun 1.4.0 and isolated PostgreSQL with migrations through 0044. Focused commands:

```sh
bun test packages/db/tests/integration/lead-turns.test.ts
bun test apps/web/test/lead-turn-request.test.ts apps/web/test/model-selection-readiness.test.ts packages/api-client/tests/unit/lead-turns.test.ts
```

Database tests cover atomic failure/retry, immutable identity conflicts, wrong-workspace
and nonparticipant denial, revoked audience/profile authority, inspection by an existing
participant and ordinary direct-session bypass. Readiness tests cover every agreed denial
and malformed/secret-bearing objects. Independent review reran 19 database tests and 24
client/server tests across this continuation and the foundations with no actionable
introduced regression. These are real local PostgreSQL and unit results; runtime/provider,
browser UI, production migrations and live lead-to-child execution remain unqualified.

## Actual packed candidate consumer proof

The candidate-only consumers in `scripts/pi-durable-candidate` import the real public
`@adea-ai/sdk` methods from isolated locally packed artifacts. The fixture installs only
manifest-local archives after SHA256 verification; it changes no production dependency
or lockfile. Synthetic service authentication and trusted provider metadata stay in the
fixture. Every successful response is bound to its request/correlation, workspace and
requested resource. Selection overrides also bind the model, connection and runtime target.

The isolated consumer proof passed strict compilation and seven model transport tests
plus two lead response-binding regressions. It then exercised all six model operations
against R2's configured HTTP service: defaults CAS, lead/direct selection, credential
revision/revocation, connection revocation and wrong-workspace denial. These operations
qualify metadata and readiness, not inference or credential use with a live provider.

A real PostgreSQL Adea fixture created the designated lead, topic, canonical message and
UUID intent. Its current-authority resolver supplied database-fetched evidence to R1's
trusted test host. The real dispatch endpoint rejected that workspace-only intent with
`PI_LEAD_PROJECT_SCOPE_REQUIRED`; command, execution, attempt, budget, usage, admission,
runtime session and provider counters all remained unchanged. Retrying the Adea write
retained the same message/intent/event. An ordinary history write created no additional
intent; this does not qualify a live direct session's authority.

An independent, explicitly declared CP project fixture exercised all four lead methods
through authenticated HTTP and actual SQLite/Pi execution with a scripted loopback
provider. Completion, canonical session replay, progress cursor and cancellation passed.
The fixture never wrote that project into the Adea workspace or lead intent. R2's BYO
selection and this separate scripted runtime were not composed into one admission; live
provider execution, production activation and the integrated U2 journey remain unqualified.

For reproduction, supply the two actual artifact manifests and host modules to
`run-candidate-proof.mjs` with its documented CLI flags and an isolated `DATABASE_URL`.
Run Bun from the CP host checkout so Nest uses its declared legacy-decorator compiler
configuration. The proof closes HTTP hosts, consumer packages and database connections
in `finally`; the runner's owner separately stops the task-owned PostgreSQL listener.
Artifact hashes and the host's current source identity are recorded separately in the
result, because a mutable host source is not the immutable package artifact.

## Current independent source qualification

The candidate adds durable admission intents, prepared execution bindings and canonical
publication receipts. Normal repository types passed (31 tasks), the web production build
and rendered shared UI source verification passed, and full repository formatting and lint
passed after ordinary fixes. The focused source suite passed 137 tests and 776 assertions
across 15 files. Restricted-role PostgreSQL passed 11 tests and 58 assertions, including
lookup receipt recovery after preparation expiry without inventing an observed state.
The fixture role has TEMP permission and no database or public-schema CREATE permission.

These checks qualify source behavior and real database persistence. The runtime and SDK
fixtures in the source suite are mocked; mounted UI/browser evidence, fresh combined
R1/R2 packed workspace execution and provider-backed activation remain pending. Earlier
packed workspace rejection evidence is retained and is not upgraded by the newer source
contracts. Installed unsupported SDK versions remain inactive. Partial issues stay open.

## Mounted cancellation visibility repair

The original controls evaluated cancellation visibility from the controller's plain
closure state. A real mounted Solid regression observed the running badge but failed
because the cancellation button remained absent. The controls now read the Solid view
signal through the same cancellability predicate used by the action guard. The identical
single-worker Playwright test passes: initial null state, observed running, exactly one
cancellation request, busy disappearance, cancelling acknowledgement and terminal removal.
Its product transport is scripted; this narrow mounted proof does not qualify the broader
model/payer journey, connected runtime cancellation or any live provider.

## Hosted bundle and composer repair

The hosted Host gate retained a Chat raw-byte failure (325,526 against 310,272).
Lead controls now load only for a designated lead through the existing deferred
Control Plane UI entry, alongside model setup. An initial separate lazy entry passed
the Chat cap but exposed 160 client files against the unchanged 157 cap. Consolidating
the independent lead controls, model pane and shared funding-model chunks into the
existing deferred entry passed every unchanged bundle gate: Chat 308,342 raw bytes and
102,522 gzip bytes, with 157 client JavaScript files. No budget or snapshot was changed.

The hosted conventional failures identified changed failure-notice copy and a thread
composer remount after a same-ID root refetch. The legacy notice is restored, and the
thread mount is keyed by root identity while updated root metadata stays reactive.
Disposal protection still prevents a late acknowledgement clearing a different topic.
The retry assertion now requires the same canonical idempotency key for an unchanged
message, while preserving payload, draft, attachments and successful-clear assertions.

The two original functional browser cases pass, including a strengthened same-DOM
thread assertion. Two additional real mounted composer regressions and the mounted
cancellation regression pass with scripted responses. These five focused browser
cases do not qualify the whole visual suite or connected provider/runtime behavior.
The hosted worker handler errors followed a refused database connection during warm-up
against the intentionally unavailable visual-lane database; the focused local run saw
neither error. The hosted failure logs remain retained separately, and this repair does
not claim that a source change eliminated that warm-up failure.
