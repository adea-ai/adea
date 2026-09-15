# Dev View implementation guide

This is the execution handoff for milestone
[M12](https://github.com/adea-ai/adea/milestone/23). Follow it in dependency
order with [ADR 0009](../decisions/0009-dev-view-control-plane.md), the
[normative runtime spec](../specs/dev-runtime.md), the
[donor audit](../research/dev-view-donor-audit.md), and the
[task plan](../plans/m12-dev-view.md).

## Prime directive: adapt before inventing

For every feature, begin at the pinned donor unit named below. The desired
workflow is:

1. read the donor implementation, its imports, nearest tests, and exact license;
2. isolate the smallest coherent behavior, including its edge-case tests;
3. copy TypeScript units where the dependency graph fits; otherwise translate
   the unit mechanically to TypeScript/Solid while preserving state transitions,
   component hierarchy, interactions, and test cases;
4. replace only the donor's framework/host/state/transport seams;
5. add the Adea scope, authorization, identity, generation, limits, durability,
   accessibility, and failure behavior required by the Dev Runtime spec;
6. record every copied or substantially translated file in the audit ledger and
   `NOTICE` in the same commit;
7. compare the result against donor behavior and the Apple Note before merging.

Do **not** use “different language/framework” as a reason to redesign a proven
unit. Do **not** copy a defect listed under “replace/harden.” Do **not** copy or
translate Warp AGPL implementation or any `hexuria/opengrok` material.

## Exact source checkout

[`dev-view-source-manifest.json`](../research/dev-view-source-manifest.json) is
the machine-readable handoff. It fixes every allowed donor origin, full commit
OID, license/NOTICE path, issue slice, source unit, nearest tests, destination,
and required adaptation. It is authoritative over a floating default branch or
package release.

At the start of a slice, pull only its allowed donors into an untracked temporary
root and verify the exact object before reading or copying:

```sh
manifest=docs/research/dev-view-source-manifest.json
root="${TMPDIR:-/tmp}/adea-dev-view-donors"
mkdir -p "$root"

donor=orca # choose only a donor named by the current slice
field() { DONOR="$donor" FIELD="$1" bun -e \
  'const m=await Bun.file(process.argv[1]).json(); console.log(m.donors[process.env.DONOR][process.env.FIELD])' \
  "$manifest"; }
origin="$(field origin)"
revision="$(field revision)"
reuse="$(field reuse)"
case "$reuse" in prohibited_*) echo "prohibited donor" >&2; exit 1;; esac

rm -rf "$root/$donor"
git init -q "$root/$donor"
git -C "$root/$donor" remote add origin "$origin"
git -C "$root/$donor" fetch --depth=1 origin "$revision"
git -C "$root/$donor" checkout --detach FETCH_HEAD
test "$(git -C "$root/$donor" rev-parse HEAD)" = "$revision"
```

Then read the manifest's `source` and `tests` arrays completely. Do not install,
build, or launch the donor unless the issue explicitly adds a reviewed need;
Adea tests should port the donor fixtures. Never retrieve Warp or OpenGrok for
implementation. Before copying, reread `licensePath`/`noticePath`, every
`dependencyManifests`/`thirdPartyLicensePaths` entry, inspect all imports, and
enter the selected destination row in the provenance ledger. Donor manifests
are review evidence, never permission to import the donor's dependency graph.

## First implementation foundation (#395)

Issue: [#395](https://github.com/adea-ai/adea/issues/395)

Create these stable seams before feature code:

| Path                                                  | Sole M12 responsibility                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/types/src/dev-runtime.ts`                   | shared wire/domain DTOs, enums, decoders, error registry                                                    |
| `packages/data/src/dev-runtime.ts`                    | query keys, provider adapters, invalidation and node/workspace cache release                                |
| `packages/state/src/index.ts`                         | ephemeral selection/layout only                                                                             |
| `packages/dev-view/package.json`                      | lazy Solid package and explicit dependencies                                                                |
| `packages/dev-view/src/index.ts`                      | public Solid entry; no host imports                                                                         |
| `packages/dev-view/src/platform.ts`                   | `DevRuntimeService` and truthful unavailable provider                                                       |
| `packages/dev-view/src/**`                            | Dev Solid UI and pure reducers                                                                              |
| `packages/workspace-ui/src/workspace-view-toggle.tsx` | add the stable `dev` view value                                                                             |
| `packages/workspace-ui/src/global-workspace-rail.tsx` | add Dev immediately below Chat                                                                              |
| `apps/web/src/components/workspace-navigation.tsx`    | one lazy Dev mount; no desktop-only tree                                                                    |
| `apps/web/src/lib/desktop-dev-runtime.ts`             | authenticated desktop/remote provider adapter                                                               |
| `apps/desktop/shell/src/dev-runtime/**`               | privileged host adapters behind M10 only                                                                    |
| `apps/desktop/shell/src/commands.ts`                  | integrate command registration; never create a parallel server                                              |
| `packages/ui/src/styles/dev-view.css`                 | token-only shared Dev styles                                                                                |
| `docs/research/dev-view-donor-audit.md` and `NOTICE`  | #394 owns policy/baseline; each reuse issue owns its issue-tagged append-only rows; #426 verifies aggregate |

Create missing paths only in the issue that owns them. Do not move durable truth
into `packages/state` or put host implementations in UI packages.

Implementation steps:

1. Transcribe the baseline opaque IDs, `Scope`, command/reply/stream envelope,
   error, capability, and provider interfaces exactly from the Dev Runtime spec
   and its normative `docs/specs/dev-runtime-operations.json` registry. Generate
   or hand-write one strict request/reply decoder per registry entry; registry
   capabilities, resources, body shapes, replies, and stream mappings are fixed.
   Donor-specific project/harness records remain owned by #398/#400; #395 does
   not pull their Orca/Zeron units early.
2. Define one `DevRuntimeService` interface in `packages/dev-view/src/platform.ts`
   and expose it through the existing `WorkspacePlatformServices`. Include an
   explicit capability snapshot and typed `unavailable` implementation.
3. Add version-1 decoders for every baseline command/reply/event/record before
   host or UI uses plain objects. Each later issue adds its operation-specific
   aliases before handlers. Reject unknown versions and retain corrupt durable
   data.
4. Add package export/lazy import boundaries and a test proving Chat/Virtual do
   not import the Dev chunk.
5. Add issue-tagged donor ledger and `NOTICE` rows for only the exact #395 units
   selected. “Based on several donors” is not sufficient provenance.

Stop if M10 #33 cannot authenticate and authorize the desktop/remote command
channel. Do not place privileged commands onto the current unauthenticated
loopback endpoints as a temporary shortcut. The current local-content adapter
is also transitional: `apps/desktop/shell/src/commands.ts` uses the file-backed
store described at the top of `docs/specs/local-content.md`; do not assume its
planned OS credential-store/SQLite authority is implemented until the owning
M10 acceptance tests prove it.

## Shell, navigation, and binary layout (#395)

Issue: [#395](https://github.com/adea-ai/adea/issues/395)

### Reuse

- KiroCrew shell/navigation decomposition at full pinned revision:
  [`website/src/pages/ChatSidebar.tsx`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/website/src/pages/ChatSidebar.tsx) and
  [`website/src/pages/chat/SidePanel.tsx`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/website/src/pages/chat/SidePanel.tsx).
- bb split operations:
  [`types.ts`](https://github.com/get-bb/bb/blob/52a9256373d4d36f9b60e9e2a7f333464091a2ac/apps/app/src/lib/split-layout/types.ts),
  [`ops.ts:172-508`](https://github.com/get-bb/bb/blob/52a9256373d4d36f9b60e9e2a7f333464091a2ac/apps/app/src/lib/split-layout/ops.ts#L172-L508), and
  [`persistence.ts:109-126`](https://github.com/get-bb/bb/blob/52a9256373d4d36f9b60e9e2a7f333464091a2ac/apps/app/src/lib/split-layout/persistence.ts#L109-L126).
- Muxy's binary split semantics and tests at full pinned revision:
  [`SplitNode.swift`](https://github.com/muxy-app/muxy/blob/5c5be8697c57a2fe70cda97fdbaf7c912e2e31b6/Muxy/Models/Workspace/SplitNode.swift) and
  [`SplitNodeTests.swift`](https://github.com/muxy-app/muxy/blob/5c5be8697c57a2fe70cda97fdbaf7c912e2e31b6/Tests/MuxyTests/Models/Workspace/SplitNodeTests.swift).

### Implement

1. Add `Dev` below Chat in `GlobalWorkspaceRail`; lazy-load `packages/dev-view`.
2. Port KiroCrew's rail/context/sidebar component boundaries and row affordances
   to Solid while retaining Adea's existing rail tokens and accessible controls.
3. Copy bb's pure split insertion/removal/resize normalization algorithms into
   `packages/dev-view/src/layout/`, narrowing the model from global n-ary leaves
   to strict binary `split | leaf` nodes scoped to
   `(workspaceId, projectId, runtimeSessionId)`.
4. Port Muxy's split invariants/tests: no cycles, all leaf IDs unique, collapse
   preserves neighbor, removing final leaf yields one terminal leaf, and ratios
   clamp. Add maximum depth 8 and a default hard cap of 8 leaves.
5. Reject unknown/missing/duplicate leaf IDs during restore; retain unread raw
   preferences and fall back to one terminal leaf. Never persist DOM geometry.
6. Build direct left Files/Source Control and right Browser/Devices,
   Agents/History toggles. The active center remains one RuntimeSession; pane
   leaves are not permanent top-level tabs.
7. Add keyboard separators, logical focus return, 44×44 px touch targets where
   applicable, reduced motion, zoom/reflow tests, and full-width/focus modes.

### Do not carry forward

bb's global schema/persistence, arbitrary n-ary tree, React/Zustand workers, or
Pierre dependencies. KiroCrew's Electron bridge and hidden subscription flows
remain out of the UI package.

## Worktree service (#397)

Issue: [#397](https://github.com/adea-ai/adea/issues/397)

### Primary donor

Port Orca's TypeScript units rather than designing a new service:

- [`orca-runtime-create-managed-worktree.ts`](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/runtime/orca-runtime-create-managed-worktree.ts);
- [`worktree-removal-safety.ts:65-192`](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/worktree-removal-safety.ts#L65-L192);
- [`worktree-trash.ts:34-130`](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/worktree-trash.ts#L34-L130);
- [`repo-worktree-admin-fingerprint.ts:15-23`](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/runtime/repo-worktree-admin-fingerprint.ts#L15-L23).

Use Muxy's
[`WorktreeStore.swift:265-371`](https://github.com/muxy-app/muxy/blob/5c5be8697c57a2fe70cda97fdbaf7c912e2e31b6/Muxy/Services/Project/WorktreeStore.swift#L265-L371)
for staged setup/teardown UX and its process-quiescer tests as negative/race
fixtures.

### Destination and adaptations

```text
apps/desktop/shell/src/dev-runtime/worktrees/
  service.ts              # Orca create flow and lifecycle coordinator
  identity.ts             # Orca admin fingerprint, expanded identities
  mutation-owner.ts       # sidecar owner/cross-process lock
  include-copy.ts         # bounded .worktreeinclude plan
  merge.ts                # expected-SHA temporary-worktree merge
  cleanup-plan.ts         # Orca safety predicates plus Adea blockers
  trash.ts                # Orca quarantine flow plus durable continuation
  journal.ts              # idempotent crash recovery
```

Preserve Orca's proof-before-trash and rename-before-delete structure. Add what
the donor lacks: M10 scope checks; repo/common-dir/root/gitdir identities;
generations; durable journals; leases; external-vs-managed provenance;
dangerous-path/nested-worktree checks; dirty, untracked, unpushed, conflicted,
protected-ref blockers; expected-SHA branch deletion; complete rollback or
quarantine. A bounded trash sweep MUST persist and resume its cursor.

Replace Muxy's cwd/name/PID/PGID process ownership and `lsof`-wide termination
with launch-record/start-identity authority. Replace all shell text with argv.
Never call `git worktree remove --force` as the safety mechanism.

Write failing tests first for each crash boundary and replacement race, then
port the donor happy-path tests. Use disposable repositories only.

## Project registry and sidebar (#398)

Issue: [#398](https://github.com/adea-ai/adea/issues/398)

### Reuse

- KiroCrew scanner:
  [`project_scan.py:1-31`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/src/kiro_crew/project_scan.py#L1-L31)
  and
  [`project_scan.py:1465-1662`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/src/kiro_crew/project_scan.py#L1465-L1662),
  with pinned tests
  [`members`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/test/test_project_scan_members.py),
  [`properties`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/test/test_project_scan_properties.py),
  [`models`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/test/test_project_scan_models.py),
  [`fixtures`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/test/test_project_scan_fixtures.py), and
  [`walker`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/test/test_project_scan_walker.py).
- Orca's project/repository/group DTOs and navigation hierarchy.
- bb's relation model in
  [`packages/db/src/schema.ts:110-148`](https://github.com/get-bb/bb/blob/52a9256373d4d36f9b60e9e2a7f333464091a2ac/packages/db/src/schema.ts#L110-L148).

### Implement

1. Translate KiroCrew's scanner behavior into small modules under
   `apps/desktop/shell/src/dev-runtime/projects/scanner/`: manifest readers,
   workspace expansion, ignore/prune policy, bounded walker, fingerprint/cache,
   and recommendation mapper. Preserve donor fixtures and expected discovery
   results; add the spec's symlink, cancellation, depth/count/byte/time budgets.
   Do not translate the 1,662-line file into one TypeScript file.
2. Adapt Orca row/group/repository semantics to
   `packages/dev-view/src/sidebar/`; use project intent → repository → worktree →
   runtime session rather than flattening identities.
3. Use bb's normalized relationship idea, but keep durable truth on the
   authorized host/Control Plane and UI selection in `packages/state` only.
4. Implement the Add menu with recent, picker/import, clone URL, GitHub,
   monorepo package, and external-worktree discovery. Show canonical identity,
   node, authorization, and duplicate/adoption state before mutation.
5. Implement visible-row-priority refresh and watcher coalescing from the spec;
   no one-subprocess-per-row polling.
6. Wire one new-session transaction to #397 then #396/#400. Partial bootstrap or
   harness failure leaves a recoverable visible session; no orphan deletion.

## Terminal and sidecar (#396)

Issue: [#396](https://github.com/adea-ai/adea/issues/396)

### Reuse stack

- Start from t3code's
  [`PtyAdapter.ts:32-66`](https://github.com/pingdotgg/t3code/blob/77bca8b2d76a1f42552e5eee7d277fcb1160347a/apps/server/src/terminal/PtyAdapter.ts#L32-L66)
  and
  [`BunPtyAdapter.ts:33-145`](https://github.com/pingdotgg/t3code/blob/77bca8b2d76a1f42552e5eee7d277fcb1160347a/apps/server/src/terminal/BunPtyAdapter.ts#L33-L145).
- Port bb terminal lifecycle/queue mechanics from
  [`terminal-manager.ts:20-117`](https://github.com/get-bb/bb/blob/52a9256373d4d36f9b60e9e2a7f333464091a2ac/apps/host-daemon/src/terminals/terminal-manager.ts#L20-L117),
  [`423-451`](https://github.com/get-bb/bb/blob/52a9256373d4d36f9b60e9e2a7f333464091a2ac/apps/host-daemon/src/terminals/terminal-manager.ts#L423-L451),
  and [`698-730`](https://github.com/get-bb/bb/blob/52a9256373d4d36f9b60e9e2a7f333464091a2ac/apps/host-daemon/src/terminals/terminal-manager.ts#L698-L730).
- Copy/adapt bb reconnect, heartbeat, queue, and stale-socket handling from
  [`terminal-websocket-transport.ts:8-107`](https://github.com/get-bb/bb/blob/52a9256373d4d36f9b60e9e2a7f333464091a2ac/packages/client-core/src/terminal/terminal-websocket-transport.ts#L8-L107),
  [`172-303`](https://github.com/get-bb/bb/blob/52a9256373d4d36f9b60e9e2a7f333464091a2ac/packages/client-core/src/terminal/terminal-websocket-transport.ts#L172-L303),
  [`346-394`](https://github.com/get-bb/bb/blob/52a9256373d4d36f9b60e9e2a7f333464091a2ac/packages/client-core/src/terminal/terminal-websocket-transport.ts#L346-L394),
  and [`422-434`](https://github.com/get-bb/bb/blob/52a9256373d4d36f9b60e9e2a7f333464091a2ac/packages/client-core/src/terminal/terminal-websocket-transport.ts#L422-L434).
- Adapt Orca
  [`terminal-history.ts:186-285`](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/terminal-history.ts#L186-L285)
  and
  [`shell-startup-features.ts:14-94`](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/shell-startup-features.ts#L14-L94).
- Translate Buzz's bounded renderer-credit flow from
  [`terminal_transport.rs:64-178`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/desktop/src-tauri/src/terminal_transport.rs#L64-L178)
  and [`257-380`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/desktop/src-tauri/src/terminal_transport.rs#L257-L380),
  plus its `env_fence.rs` allowlist tests.

### Implement and harden

1. Place PTY/sidecar implementation in
   `apps/desktop/shell/src/dev-runtime/terminal/` with a separately versioned
   sidecar entry point. Keep t3code's Bun spawn/resize/write/kill API shape.
2. Change t3code/bb string callbacks to `Uint8Array` end-to-end; test invalid and
   fragmented UTF-8 and synchronous callback-before-assignment.
3. Keep bb's bounded queue/reconnect/heartbeat algorithms, but authenticate the
   endpoint and attach token, bind scope/session/generation, add sequence,
   checkpoint/replay, resync, and backpressure. Availability code is not auth.
4. Keep Buzz's one-in-flight/credit idea as renderer flow control, but never
   infer process ownership or durable replay from credit.
5. Keep Orca's per-worktree history UX and startup feature assembly, but store
   relative content-addressed wrapper/history IDs. Re-prove containment before
   deletion; persisted absolute paths are labels only.
6. Render with `@xterm/xterm`; lazy WebGL and recover to DOM on context loss.
   Do not use Ghostty WASM or Warp code. Build block/bottom-editor behavior from
   the Adea spec/Apple Note only.
7. Implement `TerminalInputAuthority` as a pure reducer with fixtures now;
   #400 later binds it to real harness ownership. Fence every input chunk.

## Files, editor, search, and local source control (#399)

Issue: [#399](https://github.com/adea-ai/adea/issues/399)

### Primary UI donor

Port Terax component composition to Solid and CodeMirror 6:

- [`EditorPane.tsx:107-120`](https://github.com/crynta/terax-ai/blob/b02a7dcbfe58d22b2352d9618b8ed3199e317a00/src/modules/editor/EditorPane.tsx#L107-L120);
- [`GitDiffPane.tsx:139-219`](https://github.com/crynta/terax-ai/blob/b02a7dcbfe58d22b2352d9618b8ed3199e317a00/src/modules/editor/GitDiffPane.tsx#L139-L219);
- [`AiDiffPane.tsx:88-195`](https://github.com/crynta/terax-ai/blob/b02a7dcbfe58d22b2352d9618b8ed3199e317a00/src/modules/editor/AiDiffPane.tsx#L88-L195);
- `src/modules/explorer/FileExplorer.tsx:62-75`;
- `src/modules/source-control/SourceControlPanel.tsx:90-106`;
- `src/app/App.tsx:1443-1468`.

Preserve information hierarchy, file/status rows, editor/diff switching, and
diff review interactions. Replace React effects/context with Solid owners and
resources; replace Tauri invokes with `DevRuntimeService`.

### Supporting donors

Adapt t3code's
[`CheckpointStore.ts:25-99`](https://github.com/pingdotgg/t3code/blob/77bca8b2d76a1f42552e5eee7d277fcb1160347a/apps/server/src/checkpointing/CheckpointStore.ts#L25-L99),
[`GitVcsDriver.ts:714-791`](https://github.com/pingdotgg/t3code/blob/77bca8b2d76a1f42552e5eee7d277fcb1160347a/apps/server/src/vcs/GitVcsDriver.ts#L714-L791),
and [`editor.ts:4-117`](https://github.com/pingdotgg/t3code/blob/77bca8b2d76a1f42552e5eee7d277fcb1160347a/packages/contracts/src/editor.ts#L4-L117).
Keep checkpoint namespacing and editor capability DTO ideas. Replace forceful or
broad filesystem operations with the spec's root/path/file-identity authority.

### Required additions

- compare-and-swap atomic saves with SHA/stat identity;
- per-line mixed-EOL/BOM/encoding/final-newline preservation;
- `lstat` special-file rejection and immediate symlink/parent revalidation;
- supervised argv-only streaming `rg` with cancellation and result budgets;
- NUL-safe git parsing and `--` path separation;
- worker parsing/virtualization and bounded large/binary fallbacks;
- plan/commit confirmation for discard/restore;
- full remote URL redaction without losing nested namespaces.

Do not port Terax's mtime-only save, in-process search walker, majority-EOL
normalization, raw remote URLs, or self-arming OSC parser.

## Harnesses and canonical sessions (#400)

Issue: [#400](https://github.com/adea-ai/adea/issues/400)

### Reuse

- Orca's pinned [`src/shared/tui-agent.ts`](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/shared/tui-agent.ts) identity/agent semantics;
- Orca's
  [`agent-status-osc.ts:23-130`](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/shared/agent-status-osc.ts#L23-L130)
  as a bounded transcript parser reference;
- Orca's
  [`agent-session-pty-write-gate.ts:20-145`](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/runtime/agent-session-pty-write-gate.ts#L20-L145)
  as the primary write-fencing donor;
- KiroCrew ACP implementation at the pinned revision:
  [`client.py`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/src/kiro_crew/acp/client.py),
  [`runtime.py`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/src/kiro_crew/acp/runtime.py), and
  [`session_provider.py`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/src/kiro_crew/acp/session_provider.py), with its client/runtime/provider/shutdown/liveness tests;
- Zeron's pinned
  [`crates/harness/**`](https://github.com/zeronsh/zeron/tree/30a9a9537c5ec96226c87f4bf349b6f77c5dfb59/crates/harness),
  [`registry.rs`](https://github.com/zeronsh/zeron/blob/30a9a9537c5ec96226c87f4bf349b6f77c5dfb59/crates/engine/src/registry.rs),
  [`rpc.rs`](https://github.com/zeronsh/zeron/blob/30a9a9537c5ec96226c87f4bf349b6f77c5dfb59/crates/engine/src/rpc.rs), and settings/history modules;
- Buzz's pinned [`resolvePersonaRuntime.ts`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/desktop/src/features/agents/lib/resolvePersonaRuntime.ts) for explicit precedence/reset behavior, not credential identity;
- Muxy's pinned [`AIAgentDetector.swift`](https://github.com/muxy-app/muxy/blob/5c5be8697c57a2fe70cda97fdbaf7c912e2e31b6/Muxy/Services/AgentDetection/AIAgentDetector.swift) only as a degraded detection fixture.

### Implement

1. Translate registries and preference precedence into shared typed reducers;
   keep AgentProfile, HarnessInstallation, credential reference,
   RuntimeSession, and HarnessRun independent.
2. Adapt KiroCrew's ACP state transitions and error fixtures behind M10's
   discovered installation/protocol. Do not create a second ACP authority.
3. Copy/adapt Orca's write-gate reducer, replacing agent-specific heuristics with
   `(session, run, generation, source)` authority and atomic transfer. Connect
   the #396 fixture interface.
4. Use native/ACP events as canonical; wrap supported hook events in Adea's
   authenticated protocol; port Orca/Muxy parsers only as bounded degraded
   fallback. No raw OSC self-arms an agent or creates an approval/tool event.
5. Make Dev and Chat subscribe by the same `runtimeSessionId`; route changes
   never launch/stop/duplicate. Reconnect uses event cursor/resync.
6. Deliver initial prompts through structured APIs first. Record acknowledgement;
   ambiguous timeout is visible and not blindly retried.
7. Port Zeron's archive/history interaction semantics and add source,
   confidence, freshness, degraded reason, and pagination.

## Browser and Devices (#422)

Issue: [#422](https://github.com/adea-ai/adea/issues/422)

### Reuse

- KiroCrew's browser transport/lane taxonomy:
  [`browser.md:435-468`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/docs/system-specs/modules/browser.md#L435-L468)
  and its launcher/CLI-view/Electron BrowserView/web-hook tests;
- Orca pinned
  [`src/main/browser/**`](https://github.com/stablyai/orca/tree/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/browser) and
  [`src/main/emulator/**`](https://github.com/stablyai/orca/tree/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/emulator)
  for target/session/CDP/emulator inventory and adjacent test flows;
- t3code's pinned [`apps/server/src`](https://github.com/pingdotgg/t3code/tree/77bca8b2d76a1f42552e5eee7d277fcb1160347a/apps/server/src)
  preview/port/browser modules for discovery, annotations, screenshots, and
  external-editor handoff;
- Buzz renderer publication/credit unit for bounded latest-frame transport.

### Implement

1. Keep ADR 0006's lane separation. Port donor orchestration into
   `apps/desktop/shell/src/dev-runtime/browser/` and UI into
   `packages/dev-view/src/browser/`; replace Electron/Tauri calls with
   Bun.WebView/CDP/M10 adapters.
2. Use KiroCrew's explicit transport kind/capability surface so unavailable
   operations remain visible and typed.
3. Use Orca target/device inventory and lifecycle composition; add immutable
   profile/lane IDs, host scope, generations, explicit takeover, and launch
   identity.
4. Use t3code preview/annotation UX, but replace permissive browser permissions,
   broad filesystem reads, and partial cookie import.
5. Use Buzz's one-in-flight/latest-frame backpressure for screencasts; add frame
   sequence, viewport generation, authenticated attach, stale-input rejection,
   and replay/resync semantics where required.
6. Implement SSRF/DNS-rebinding/redirect checks and prove a loopback preview is
   Adea-owned before granting the exception. Browsed origin is never authority.
7. Make cookie import a previewed atomic transaction with complete rollback and
   vault storage. Never touch the user's normal browser profile.
8. Port Orca's emulator inventory tests; use fixed argv and exact inventory IDs,
   and stop only Adea-launched identity-matching processes.

## GitHub source control (#423)

Issue: [#423](https://github.com/adea-ai/adea/issues/423)

### Reuse

- Orca `src/main/github/client/**` plus repository-level
  `src/main/github/client-*.test.ts`, IPC, and routing tests as the primary
  provider and fixture donor;
- t3code VCS/provider/PR DTO patterns and `GitVcsDriver`;
- KiroCrew `website/src/pages/ChatSidebar.tsx:719-1072` and
  [`PullRequestPanel.tsx:253-278`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/website/src/components/PullRequestPanel.tsx#L253-L278)
  for linked work item, PR lifecycle, check, and review UI.

### Implement

1. Copy Orca's provider client into an Adea-owned adapter boundary, preserve its
   pagination/rate/error fixtures, and replace Electron IPC/auth storage with
   M10 credential references and `DevRuntimeService`.
2. Adapt t3code's host-neutral DTOs and local git integration, but do not scrape
   `gh` text or leak configurable credentials to arbitrary usage/provider URLs.
3. Port KiroCrew's PR/issue/check information hierarchy to Solid; sanitize all
   remote text and never insert it into prompts or shell automatically.
4. Add ETag/cursor caching, enterprise-host trust, idempotent PR reconciliation,
   and authoritative reread after mutation.
5. Use plan/commit with expected SHAs for push/update/merge. Force means exact
   `--force-with-lease`; never raw force, reset, admin bypass, or automatic
   conflict resolution.
6. Create ordinary PRs as drafts and honor repository-required merge strategy,
   checks, reviews, and conversation resolution.

## Resources, usage, and cleanup (#424)

Issue: [#424](https://github.com/adea-ai/adea/issues/424)

### Reuse

- Muxy's
  [`WorktreeProcessQuiescer.swift:57-159`](https://github.com/muxy-app/muxy/blob/5c5be8697c57a2fe70cda97fdbaf7c912e2e31b6/Muxy/Services/Git/WorktreeProcessQuiescer.swift#L57-L159)
  and tests for process-tree measurement and PID/PGID reuse races;
- Muxy's process metrics and
  [`ExtensionStore.swift:1034-1040`](https://github.com/muxy-app/muxy/blob/5c5be8697c57a2fe70cda97fdbaf7c912e2e31b6/Muxy/Services/Extensions/ExtensionStore.swift#L1034-L1040)
  only as unsafe port-kill counterexamples;
- t3code's pinned [`apps/server/src/usage/**`](https://github.com/pingdotgg/t3code/tree/77bca8b2d76a1f42552e5eee7d277fcb1160347a/apps/server/src/usage)
  plus process/port/provider-limit modules and adjacent tests for discovery and
  presentation;
- the already-ported, tested Adea terminal-history and archive/trash services
  owned by #396/#397. #424 consumes those local services as its sole cleanup
  executor; it does not pull, recopy, or independently translate Orca.

### Implement

1. Port Muxy's process-tree enumeration/measurement and race tests. Replace
   cwd/name/PID/PGID assertions with Adea launch record, PID start identity,
   executable, process-group/session, owner, and generation; recheck before each
   signal or use stable handles.
2. Port t3code's port presentation but derive ownership from launch/session
   metadata and only confirm with OS inspection. External ports have no stop.
3. Build one inventory reducer joining terminal, harness, server, browser,
   device, process, port, metric, lease, and retained-data records. Unknown or
   stale relationships remain explicit.
4. Adapt donor usage cards/normalizers behind fixed reviewed API/protocol/local
   transcript adapters. Add source/confidence/freshness, rate cache, SSRF and
   credential-host constraints, and terms review for undocumented APIs.
5. Make Archive call only archive. Make Complete-and-clean call #397's durable
   plan/commit coordinator. UI cannot invent or weaken deletion proof.
6. Add active/idle/hidden sampling schedules, concurrency/time/output caps, and
   bounded downsampled history. Unsupported/denied is not zero.

## Appearance and App Library (#425)

Issue: [#425](https://github.com/adea-ai/adea/issues/425)

### Reuse

- Translate Zeron's complete appearance state/interaction model from
  [`crates/ui/src/appearance.rs:29-281`](https://github.com/zeronsh/zeron/blob/30a9a9537c5ec96226c87f4bf349b6f77c5dfb59/crates/ui/src/appearance.rs#L29-L281)
  and `crates/theme/src/**`.
- Port KiroCrew App Library composition from
  [`DiscoverPage.tsx:580-588`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/website/src/pages/apps/DiscoverPage.tsx#L580-L588)
  and
  [`CategoryRail.tsx:1-72`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/website/src/components/appstore/CategoryRail.tsx#L1-L72),
  with `website/playwright/apps.spec.ts` and
  `website/src/test/appstoreCategories.test.ts`.
- Extend Adea's existing `ThemeProvider`, semantic CSS tokens, plugin catalog,
  signature/digest verification, and install-plan flow; do not replace them.

### Implement

1. Translate Zeron's system/light/dark mode plus separate light/dark selection
   and live preview into `AppearancePreferencesV2` and the toolbar popover.
   Preserve live rollback/selection behavior; add accent, surface, and reduced
   transparency.
2. Migrate the old key without flash. OS Reduce Transparency overrides surface;
   system mode follows the OS live.
3. Extend one token manifest to UI, xterm ANSI/palette, CodeMirror syntax/diff/
   search, charts, focus, and selection. Browser pages are not recolored.
4. Port KiroCrew's category rail, search, installed/discover states, detail
   affordance, and tests to Solid using Adea tokens.
5. Keep activation restricted to bundled first-party entry IDs. Catalog-only
   entries may install metadata/connectors; no downloaded UI code, `eval`,
   remote modules, or arbitrary postinstall.
6. Preserve core rail recovery: hidden items remain in App Library and Reset
   Navigation restores defaults. Active selection cannot disappear silently.
7. Record KiroCrew Apache/NOTICE provenance for translated components and exact
   test fixtures. Theme metadata claiming “User supplied” is unverified until a
   real license/provenance check succeeds.

## Integration and release gate (#426)

Issue: [#426](https://github.com/adea-ai/adea/issues/426)

Do not treat integration as permission to redesign completed slices. Exercise
the exact donor-derived units through the shared owner journey and repair at the
owning layer.

1. Build deterministic fake PTY, disposable git, fake RuntimeConnection,
   native/ACP/hook/transcript, browser/CDP/device/cookie, GitHub, metrics/PID/
   port-reuse, and persistence-failure fixtures.
2. Run the owner journey: add project → create/bootstrap worktree → attach PTY →
   auto-launch default harness → continue same RuntimeSession in Chat → edit and
   compare files → preview/browser/device → checkpoint/commit/push/draft PR →
   inspect checks/usage/resources → archive → separately plan/complete cleanup.
3. Run local and remote execution-host variants plus unauthorized, offline,
   disconnected, revoked, partial, conflict, stale, corrupt, disk-full,
   sidecar-update, and app-update/rollback variants.
4. Run all adversarial cases in the Dev Runtime spec. Validate packaged CEF and
   Bun.WebView behavior; fixture-only desktop tests are insufficient.
5. Prove lazy bundle boundaries and no React/Pierre/Electron/Tauri/GPUI donor
   runtime leakage.
6. Scan changed files, git blobs, bundle, and generated artifacts for Warp and
   OpenGrok prohibited provenance. Perform manual structural-similarity review
   and obtain implementer attestation.
7. Reconcile every ledger row, source header, dependency license, and `NOTICE`.
8. Close #426 only after all earlier issues and their named M10/M11 dependencies
   are closed and every declared check has current evidence.

## Per-PR implementation checklist

- [ ] The PR names its M12 issue and one narrow slice.
- [ ] The donor revision/path/test and license were reread before editing.
- [ ] The smallest coherent licensed unit was copied/translated instead of
      independently reinvented.
- [ ] Framework/host seams replaced without discarding proven behavior.
- [ ] Known donor defects were converted to failing tests before hardening.
- [ ] Scope, identity, generation, authorization, limits, persistence, errors,
      cancellation, and recovery match the Dev Runtime spec.
- [ ] Provenance ledger, headers, dependency review, and `NOTICE` are current.
- [ ] Warp/OpenGrok denylist and manual review pass where relevant.
- [ ] Focused tests, affected package tests, format, lint, typecheck, build, and
      docs-boundary tests pass.
- [ ] Diff contains no unrelated generated/vendor files or secrets.
