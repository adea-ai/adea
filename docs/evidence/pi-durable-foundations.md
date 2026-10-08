# Workspace lead and direct-topic foundations

This additive slice implements the isolated-topic contracts of
[F2 (#1171)](https://github.com/adea-ai/adea/issues/1171) and the structural lead API portion of
[F1 (#1170)](https://github.com/adea-ai/adea/issues/1170). F2's local acceptance checks and independent source review are recorded below;
hosted exact-head checks and merge review remain required. F1's automatic Home
and optional-workspace provisioning remains separate. This slice does not qualify a running
Pi lead, a provider connection, or a lead-to-child journey.

## Identity and setup

Migration 0042 adds `agents.is_workspace_lead`, defaulting every existing Agent to false.
A partial unique index allows one designation per workspace, including configuration-error
Agents. A designated lead cannot be archived or placed under a project. Stable Adea and
Control Plane IDs and all existing Agent rows remain intact.

`POST /api/v1/workspaces/:workspaceId/agents/lead` accepts `{}` and idempotently provisions
the structural lead for an owner or admin. Concurrent setup serializes on the workspace.
`GET` returns `{ lead: AgentSummary | null }` only to a member of a live workspace. Neither
operation calls a model, copies credentials, chooses a provider, or creates a session.
The structural profile sentinel is explicitly missing until an exact eligible profile is
adopted through the existing revision-checked profile flow. Profile availability reads preserve
that setup state without a catalog call. A lead designation is never proof of model readiness.

Automatic integration with Home and optional-workspace creation remains a follow-up after
the canonical workspace changes; this slice does not change workspace creation or deletion.

## Topics and audience

`POST /api/v1/workspaces/:workspaceId/channels` with
`{ kind: 'direct_agent', mode: 'new_topic', agentId, title }` and a caller-generated
`Idempotency-Key` creates a distinct participant-only topic. The server binds the key to the
caller and hashes the original request, so retries preserve the ID after renaming or archiving,
while changed original fields conflict. The creator and the same-workspace Agent are the
initial audience. Workspace membership alone does not grant private topic history access.
Creation retries also recheck current audience, including after archive or participant removal.

The old creation request retains its default-lane semantics. Its separate partial unique
index applies only to `direct-agent:` keys; opening it never chooses a new topic. The
legacy default lane retains its original audience, and reopening an archived lane creates a
new history. No migration merges conversations, changes participants, rewrites messages,
or adds native session ownership. Channel identity plus Agent identity is the isolation
binding; a later execution adapter must use that canonical binding.

Workspace event delivery enforces that audience for replay and live pages, including for
owners and admins. Missing or foreign references are withheld. Batched indexed projections
avoid one query per event; the database regression compares five-event and 120-event pages.

When a workspace-visible conversation becomes participant-only, a denied former reader receives
only a sequence/cursor audience-change signal. Resident query data and channel/thread selections
are cleared before refetch; retained transcripts and late responses must match the new audience
generation. Private-from-creation channels and hidden projects disclose no conversation identity.
The actual QueryClient and mounted Solid resource regressions cover this cache-revocation repair.

## F2 acceptance map

| Issue requirement                                                         | Implementation and evidence                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit security scope, audience and isolated conversation+Agent binding | Canonical Channel carries workspace ID, Agent ID and participant visibility/audience; messages bind to that Channel. `conversations.test.ts` checks distinct topic histories and nonparticipant denial; `event-audience.test.ts` checks current audience across replay/live classification.                                                                                                        |
| Deliberate new-topic keys and coordinated uniqueness migration            | Caller-scoped keys and original-request hashes preserve retry identity without selecting the default lane. DB/client/data tests cover two topics, changed requests, caller isolation and legacy retries; `lead-topic-migration.test.ts` applies actual 0042 SQL to the old index shape.                                                                                                            |
| Workspace authorization separate from conversation authorization          | Current membership and Channel audience are checked separately; owner/admin cannot bypass participant-only history. Wrong-workspace/nonparticipant/removed-participant tests and cache-revocation tests cover denial; newly created topics inherit no other history.                                                                                                                               |
| Preserve archive, search/read-state and legacy endpoint scope             | Migration test preserves archived bodies, audiences and read frontiers. New `topic-read-state-search.test.ts` explicitly covers topic-scoped search, independent Channel/thread frontiers, archive persistence, current audience removal, empty new-topic history and unchanged legacy lane. The fresh PostgreSQL run passed with the migration, audience and existing search/read-state fixtures. |

Archived channels remain excluded from the normal search, read-state and message endpoints;
their canonical bodies and read frontiers remain stored. This preserves existing endpoint scope
rather than introducing an archive-reading API. F2 acceptance does not require F1 automatic
provisioning, U1/U2 model/runtime integration or live-provider execution.

## Migration and rollback

Apply 0042 before deploying the new columns or topic callers. Its snapshot deliberately
preserves all staged Home, workspace-deletion and task-retention declarations from 0041,
even while their runtime declaration is awaiting canonical integration. Generating from
the older runtime declarations must not remove these expansions.

The real PostgreSQL migration fixture applies the reviewed SQL to old-shape fixtures and
compares original Agent IDs/CP IDs, active and archived channel identities, private bodies,
participants, timestamps and read frontiers before and after. Other integration fixtures
exercise duplicate/concurrent setup, two topic histories, archived reads, changed requests,
wrong-workspace requests and nonparticipant denial. Fixtures establish local database
behavior, not a production data inventory or a live runtime/provider qualification.

Rollback keeps the expanded columns and histories. Do not restore the global direct-Agent
unique index after topics exist: it would reject multiple legitimate topics. A compatible
reader can continue serving old scoped endpoints; topic creation can be disabled while
new histories remain readable. Destructive rollback, production backfill and rollout require
their own inventory and acceptance evidence.

## Integration boundary

The pinned SDK lacks the new model-connection operations. The existing connector credential
UI cannot imply a model-ready connection. U1's safe reason/remedy projection is tested
separately and is not wired to a provider or UI. U2 requires the canonical CP admission
service, current model selection and audience-authorized terminal publication. Ordinary
message persistence, runtime status inspection and direct project sessions do not call a
lead or claim dispatch.

## Reproducible foundation checks

Local qualification uses Node 24.21.0, Bun 1.4.0 and an isolated PostgreSQL instance,
with migrations through 0042 applied before running the foundation fixtures:

```sh
bun test packages/db/tests/integration/workspace-leads.test.ts packages/db/tests/integration/conversations.test.ts packages/db/tests/integration/event-audience.test.ts packages/db/tests/integration/lead-topic-migration.test.ts
bun test packages/db/tests/integration/topic-read-state-search.test.ts
bun test packages/api-client/tests/unit/agents.test.ts packages/api-client/tests/unit/conversations.test.ts packages/data/tests/unit/conversations.test.ts apps/web/test/agent-profile-availability.test.ts
bun test scripts/docs-boundary.test.ts
```

The event audience regressions failed before the fix and passed afterward. Independent
review reran the isolated database and focused client/server checks with no actionable
introduced regression. No screenshots, browser acceptance, production migration,
credential setup, model inference or live provider result is implied by these checks.

## F2 local qualification on canonical main

The F2-only source was reconciled onto canonical `a4c4690a`; U1/U2 intent, model and
candidate-runtime work remains separately preserved and is absent from this PR.
A fresh isolated PostgreSQL database applied migrations through 0042 and verified
a deterministic rerun (43 migration entries, including 0000).

| Check                                                                     | Result                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused database suite (six files, including `read-state-search.test.ts`) | 17 passed, 0 failed, 208 assertions; includes distinct topic search/read frontiers, archived bodies/frontiers, legacy lanes and hidden-project audience denial.              |
| `bun run format:check` and `bun run lint`                                 | Formatting passed; 17 lint tasks passed with zero warnings/errors.                                                                                                           |
| `bun run typecheck`                                                       | 31 tasks passed.                                                                                                                                                             |
| `bun run test:unit`                                                       | 30 tasks passed; coverage lane 302 passed, 0 failed, 7,163 assertions and 92.28% line coverage. Desktop suite: 1,269 passed with four existing packaged-only skips.          |
| `bun run build` and fresh `bun run --cwd apps/web build`                  | 15 workspace tasks passed; fresh production web build passed and verified 103 rendered shared UI modules against 187 Tailwind sources.                                       |
| `bun run --cwd apps/web start:check-bundle`                               | Fresh candidate production client module/size gate passed with unchanged limits.                                                                                             |
| Focused data/state/Solid-resource/SSE/source-boundary lane                | 89 passed, 0 failed, 318 assertions across 20 files. The mounted query/resource test is runtime evidence; ConversationSurface composition assertions remain source evidence. |

The additional standalone `node scripts/check-dev-view-bundle.mjs` guard fails
on canonical main as well as this candidate: canonical 215,770 bytes and candidate
215,710 bytes against the unchanged 114,688-byte entry/layout cap. The candidate
is 60 bytes smaller. This is retained as a pre-existing Dev View performance
follow-up; no cap or test was changed. `start:verify` and the TanStack Start PR
workflow invoke the passing `start:check-bundle`, rather than this standalone
guard. No complete performance, browser, packaged-desktop, production migration,
provider or runtime qualification is claimed.

Normal commit hooks and the final immutable PR head are recorded in the PR's
qualification receipt. Required hosted checks and Task8's exact-head review
remain the ready/merge boundary.

## Post-publication F2 hold and focused repair

Parent review of `60ee3cfa` found retained channel-list fallback reselection after
an audience reset and unconditional selection of a late direct-conversation
mutation response. Full F2 acceptance was withdrawn and PR1186 returned to draft.
Mounted tests of the real controller, Solid resources and QueryClient reproduced
three failures (both audience races plus the workspace-switch response race).

The pending repair stamps channel-list fetches with their workspace and admission
audience epoch, checks that authority before navigation/reconciliation, resets
explicit selection authority on scope changes, and guards direct/group response
selection. Settled empty lists clear stale selections; pending lists wait. The
focused browser-condition lane passes 25 tests/73 assertions, including eight
mounted controller cases and one direct fetch-epoch case. Normal discovery runs those cases through its browser
Solid subprocess. Equivalent guards cover Virtual/global navigation, with source-composition checks only; their full browser mounting remains unverified. Focused formatting/lint and `git diff --check` pass.

Old-head hosted Integration run `37736780043` also failed the migration preservation
fixture with SQLSTATE42501 (database CREATE permission). The fixture now prepares
session-local temporary tables and applies the same reviewed SQL in `pg_temp`,
matching the existing runtime-role temporary-table pattern without schema grants.
The fixture repair passed in the granted window under a synthetic local runtime
role with database CREATE=false, app schema CREATE=false and TEMP=true: all six
focused database files passed (17 tests/208 assertions). Fresh root typecheck
passed 31 tasks after correcting a nullable-list compiler error; root format/lint
passed (17 lint tasks, zero warnings/errors). Affected data tests passed 61/222
and workspace-ui tests passed 167/577. Build/bundle/hooks and hosted exact-head
qualification remain required. Prior passing results do not qualify this uncommitted repair;
#1171 stays open and the PR body uses `Refs #1171` during the hold.

Independent source review found no remaining actionable defect in these repairs. This is source review, not repaired-head PostgreSQL/browser/compiler qualification.

### Current scoped F2 acceptance map

- Explicit new-topic creation binds the existing workspace Agent and separates
  caller-scoped retry identity from the optional legacy default lane.
- Actual restricted-role PostgreSQL verifies independent topic search, channel
  and thread frontiers, archive bodies/frontiers, legacy IDs/audiences and denied
  participant/hidden-project paths (17 tests/208 assertions across six files).
- Actual mounted controller regressions cover stale fallback, denied/empty
  refresh, cross-workspace resident list, late direct/group results and valid
  same-audience thread preservation. Virtual/nav composition is source evidence.
- Migration/index and caller semantics remain coordinated. Lead structure is
  additive, but automatic Home/optional-workspace provisioning remains F1 work.

Old-head hosted Integration run37736780043 SQLSTATE42501 and the cancelled
aggregate remain historical failures; the new local restricted-role proof does
not retrospectively turn those checks green. #1171 remains open pending root's
repaired exact-head review and hosted gates; no U1/U2/provider claim is added.

### Clean-source qualification boundary

Final review discovered that preserved, unowned ` 2` file copies participated in
root compiler, package test discovery and the web build. TanStack generated an
extra `/agents/lead 2` route from a copied file. The unstaged generated addition
was preserved as external evidence and restored to intended tracked source.
No copied file was deleted, moved or staged. Root format/lint/type/build and the
package test counts above are raw passing results with this contamination and
are provisional, not clean repaired-head qualification. The direct web build
and bundle check also passed mechanically but are not accepted qualification.
The explicitly selected canonical PostgreSQL suite (17/208) and focused runtime
lane (25/73) are unaffected. Normal hooks/publication are held pending an explicit
copied-file ownership/preservation decision and clean affected checks. PR1186
remains draft; no merge or issue closure is authorized from these raw results.
