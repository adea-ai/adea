# M12 — Daily Driver: Dev View (Dev Control Plane)

- Milestone: [#23](https://github.com/adea-ai/adea/milestone/23)
- Status at planning acceptance: 12 open, 0 closed
- Product authority: Apple Note **“Adea Dev View”**
- Architecture: [ADR 0009](../decisions/0009-dev-view-control-plane.md)
- Runtime contract: [Dev Runtime spec](../specs/dev-runtime.md) and [exact operation registry](../specs/dev-runtime-operations.json)
- Donor evidence/provenance: [source audit](../research/dev-view-donor-audit.md)
- Exact donor checkout/source/test map: [source manifest](../research/dev-view-source-manifest.json)
- Threat model: [Dev View threat model](../security/dev-view-threat-model.md)
- Implementation recipes: [guide](../guides/dev-view-implementation.md)

## Agent start contract

“Start M12” is an execution instruction, not a request for design discovery.
An implementation agent MUST, without asking the owner to restate choices:

1. read this plan, ADR 0009, the Dev Runtime spec, threat model, donor audit,
   source manifest, and implementation guide;
2. inspect current git/GitHub state and select the first open issue below whose
   dependency and required-authority gates are satisfied;
3. pull only that issue's pinned donor units with the guide's exact checkout
   procedure, read each listed source/test and its imports, and record the files
   actually reused;
4. write failing Adea tests translated from the listed donor tests plus the
   issue's hardening cases, then implement the destination paths named by the
   manifest and guide;
5. run focused checks, update provenance/NOTICE/spec in the same commit where
   applicable, run the broadest required checks, and attach the prescribed
   evidence before moving to the next ready issue.

If an upstream authority is absent, record the exact issue/test blocker and move
to another dependency-ready non-privileged slice; do not invent a parallel
authority and do not ask a design question already answered by this package.
This package is the implementation-complete normative transcription of the
private Apple Note; implementation agents do not need Notes access. Only an
actual contradiction, unavailable external credential/resource, or owner
decision explicitly marked open in an issue permits escalation.

Shared provenance files use one ownership protocol: #394 owns policy text and
the empty baseline; each implementation issue owns only ledger and root
`NOTICE` rows explicitly tagged with its issue number and local destination,
added in the same commit as reuse; rows are append-only and may not modify
another issue's block; #426 verifies and formats the aggregate. The issue that
changes normative behavior owns its same-commit spec paragraph. This protocol
is the merge authority for concurrent slices, not shared semantic ownership.

## Outcome

Adea becomes an owner-grade developer control plane. A user can organize
projects, create an isolated worktree, run approved bootstrap, attach a durable
terminal, automatically launch the preferred harness, continue the same session
in Chat, inspect/edit/diff files, use browser/device lanes, manage GitHub work,
inspect resources/usage, archive losslessly, and perform separately authorized
safe cleanup.

The milestone is complete only when this journey works on the packaged macOS
desktop, including recovery from disconnects and partial failure. Remote
RuntimeConnection certification is outside M12: the owner moved it to
M14 — Remote Runtime Integration (executes after M13 — Chat View closes and
gates M17 — Spatial; decision 2026-09-16). M12 keeps one shared adapter code
path and no second wire contract so the remote host consumes it unchanged.

## Product contract

- Slim global rail; full-height contextual Dev sidebar.
- Group → project → repository → worktree/session hierarchy and archived shelf.
- One active central RuntimeSession with binary terminal/editor split leaves.
- Direct left Files/Source Control and right Browser/Devices, Agents/History.
- Pipeline: authorize → update base → worktree → bootstrap → terminal → default
  harness.
- Dev and Chat project one canonical RuntimeSession.
- Native/ACP events precede authenticated hooks; bounded PTY fallback is visibly
  degraded.
- Worktrees, process/port ownership, status/history, usage, and cleanup are
  first-class and proof-driven.
- Human and task-owned browser lanes remain separate per ADR 0006.
- Appearance is live/versioned/coherent; App Library never executes arbitrary
  downloaded UI code.
- Worktrees materialize fast: `.worktreeinclude` populations and dependency
  trees use copy-on-write file clones, with a package-manager-aware,
  per-project dependency-template cache (#397/#398) and template visibility in
  #424's retained-data view.
- Reuse licensed donor units first; independently invent only where no suitable
  licensed donor exists. Warp/OpenGrok restrictions are absolute.
- **Visual conformance is donor-sourced too:** every donor-derived surface ports
  the donor's UI composition — layout, widget structure, previews, and
  interaction flow — reimplemented in Solid against Adea tokens. Donor
  composition is the visual spec; conformance is checked by tests + the visual
  lane, not by owner design review (owner directive 2026-09-18; see #425's
  Zeron composition checklist for the pattern).

## Non-goals and ownership boundaries

Explicitly outside M12 scope (owner-confirmed 2026-09-16):

- GitHub Projects/Kanban/automation surfaces — they belong in App Library, not
  the core sidebar (#423); the owner classifies these as later App Library
  add-ons, not MVP;
- terminal cloud share links — deferred until a redaction/expiry policy exists
  (#396, Dev Runtime spec);
- a real-browser extension lane (#422, Dev Runtime spec).

Owned by other milestones, consumed here:

- mobile handoff is M11 #187's authority; M12 only renders its projections;
- provider subscription/billing management stays with the account surface; M12
  #424 owns only the usage/limit cards and adapters;
- the remote runtime-node host loads the same
  `apps/desktop/shell/src/dev-runtime/**` adapter sources and exposes the same
  registry over an authorized `RuntimeConnection` — M12 does not define a
  second remote wire contract;
- remote RuntimeConnection production certification is M14 — Remote Runtime
  Integration's authority (owner decision 2026-09-16: it runs after M12 and M13
  close, and gates M17 — Spatial Workspace). M12 exercises the shared adapter
  and registry through authorized fake RuntimeConnection, revocation, and
  scope-isolation fixtures, but does not certify remote production behavior;
- M10 must still define the authorized-root (`RootBookmark`) mint/revoke flow
  and vault `CredentialRef` enrollment that the Dev Runtime DTOs consume — M12
  reads them but cannot mint either.

Committed scope that must not be reclassified as non-goals without an owner
decision: per-project mute/snooze (#424), independent per-session badges for
harness/dirty/PR-check/server-port state (#395), tab hover/detail cards
(#423), macOS permissions onboarding (#471), and computer use (#472).

Owner reclassification 2026-09-16: the planning pass had recorded computer use
and macOS permissions onboarding as non-goals; the owner returned both to M12
scope as #471 (needed — the Orca permissions page is the Apple Note's model)
and #472 (critical). Automations and GitHub Projects/Kanban stay outside M12
as later App Library add-ons.

## Dependency order

```text
M10/M11 required substrate
  └─ #394 architecture, audit, contract
      ├─ #395 shell and panes
      │   ├─ #398 registry/sidebar (also #397)
      │   ├─ #396 terminal (also #397)
      │   │   ├─ #400 harness/sessions
      │   │   └─ #424 resources/cleanup (also #397/#398/#400/#422)
      │   ├─ #399 files/local source control (also #397)
      │   │   └─ #423 GitHub (also #398)
      │   ├─ #422 Browser & Devices
      │   ├─ #425 Appearance/App Library
      │   ├─ #471 permissions onboarding (also M10 #33)
      │   └─ #472 computer use (also #400/#422/#471, M10 #33)
      └─ #397 worktree service
all above ── #426 integration/release gate
```

Work may overlap only after its contract dependency is merged. Closure follows
the stricter prerequisites in ADR 0009. No issue may close merely because UI
fixtures exist when its production host adapter is unfinished.

This plan, its linked in-repository contracts, and each task's acceptance list
are the complete implementation authority. GitHub issue bodies are synchronized
tracking mirrors, not an additional source an implementation agent must
discover. If a mirror differs, use this package, stop that issue before merge,
and synchronize the issue in the same planning change. A criterion may be
deferred only to a separately owner-accepted, linked follow-up issue; omission
or a generic “later” note is not deferral.

## M10/M11 entry gate

Before a privileged M12 operation merges, verify:

- M10 #33 authenticates and authorizes the command/channel; current loopback
  `/__adea/invoke` and `/__adea/events` are not accepted as authority;
- runtime-node identity, pairing, eligibility, rotation, and revocation follow
  the runtime-node spec;
- M10 owns filesystem/process/credential/harness discovery and remote routing;
- M11 owns task, approval, cancellation, resume, and profile-version authority;
- M12 introduces no second authority and no circular milestone dependency.

If a required upstream API is absent, land its approved upstream issue first or
keep the M12 adapter behind an unavailable capability. Do not build a bypass.

## Pre-implementation closure gate after #447

PR #447 (`feat(dev-view): add M12 foundation shell`) is merged, but #395
remains open. The merged slice is a truthful, dependency-ready shell; it is not
provider-backed Dev View completion. Before starting a privileged M12 slice,
resolve the following decisions in code, tests, and the synchronized contract
pages. Do not treat a fixture-only green run as evidence that any item below is
complete.

### Canonical session/provider seam

- Define the UI-facing Dev Runtime projection over the registry's typed list/get
  replies. `DevWorkspaceEntry` must consume authoritative groups, projects,
  worktrees, and `RuntimeSession` projections rather than a production fixture
  tree.
- `selectedRuntimeSessionId` is valid only when the session belongs to the
  selected project, workspace, account, and runtime node. A stale, archived, or
  revoked selection is cleared or visibly recovered; it is never paired with a
  different project's session.
- Dev and Chat read the same `runtimeSessionId` and subscribe to the same
  provider/cache identity. Switching views mounts or unmounts a projection only;
  it never creates, stops, resumes, or transfers a process implicitly.
- Input ownership and explicit Dev↔Chat transfer are M10/M11-authorized
  operations. The UI may request a transfer, but cannot infer ownership from a
  pane, tab, route, or terminal focus.
- A real provider must supply an authenticated `Scope` before preference writes
  or runtime data are accepted. The fixture provider remains development/E2E
  only and is impossible to enable in production.

### Utility-slot and persistence decision

- #395 owns two independent utility slots: one left and one right. Each side
  may have one active pane or be collapsed; changing the active pane on one
  side must not hide or replace the pane on the other side.
- The persisted utility record contains all six pane identities exactly once,
  each pane's side, order, visibility, size, last nonzero size, and explicit
  full-width state. Side placement and tab order are user preferences, not
  resource authority.
- The center tree and utility slots are scoped to
  `(accountId, workspaceId, runtimeNodeId, projectId, runtimeSessionId)`. The
  session ID is intentional: restoring a pane that references a prior
  session's terminal/editor resource is unsafe. A future project-level default
  may seed a new session, but it must not restore session-owned resources.
- Introduce a versioned V1→V2 preference migration. V1 values from #447 are
  retained and migrated by filling missing panes from safe defaults; corrupt or
  future values remain available under an unread/recovery key and are never
  overwritten silently.
- Add tests for quota errors, storage unavailability, stale writes from two
  windows, runtime-node changes, invalid focus targets, and a full reload with
  both utility sides visible. `focusTargetId` must resolve to a leaf, never a
  split-node ID.

### Contract and release-boundary decisions

- Keep the operation catalog generated from one source, but require exact
  generated-artifact checks, per-operation request/capability/resource tests,
  success-DTO/handler parity, and explicit registry versioning before a handler
  is registered. Capability ordering uses ASCII/code-point ordering, never
  locale-dependent comparison.
- Any unbounded byte offset, length, sequence, or byte count is a canonical
  decimal string on the wire. Numeric fields are permitted only when the
  registry supplies a safe explicit upper bound.
- M12 certifies the local packaged macOS path. M14 owns production
  RuntimeConnection/remote-node certification. M12 must keep one shared,
  remote-ready adapter/registry and remote authorization fixtures, but must not
  claim that remote production behavior is certified. The spec, threat model,
  plan, and #426 acceptance text must use this same boundary.

Only after this gate is recorded as satisfied may #397/#396/#399/#400/#422
register or exercise privileged host behavior. Pure reducers, typed fixtures,
contract tests, and unavailable UI states may continue before the gate.

## Task 1 — Architecture, source audit, and contract

Issue: [#394](https://github.com/adea-ai/adea/issues/394)

Deliverables:

- ADR 0009, Dev Runtime spec, donor source audit/ledger and source manifest,
  threat model, implementation guide, this plan, and AGENTS routing;
- stable DTO/error/event/lifecycle vocabulary;
- exact pinned donor map, reuse/reject reasons, Warp/OpenGrok policy.

Acceptance:

- [ ] Product, hierarchy, package boundaries, authority, state machines, errors,
      limits, persistence, security, failure/recovery, and tests are normative.
- [ ] Every donor claim has a pinned path/symbol/test and verified license.
- [ ] File-level provenance process and `NOTICE` obligations are explicit.
- [ ] M10/M11 closure graph is acyclic and owners are unambiguous.
- [ ] ADR, spec, and donor audit land together with their router entry.
- [ ] Every donor's relevant source, nearest tests, manifests/dependency
      boundary, license, and NOTICE state are verified at the pinned revision.
- [ ] Docs links/routing tests pass; implementation can proceed without a new
      architectural decision.

## Task 2 — Shell, navigation, and panes

Issue: [#395](https://github.com/adea-ai/adea/issues/395)
Depends on: #394

Deliverables:

- shared `packages/types`, `packages/data`, `packages/dev-view`, web-provider, and
  shell registration skeleton with dependency-boundary/decoder tests;
- an authoritative Dev Runtime projection seam for groups, projects, worktrees,
  and canonical `RuntimeSession` records, with no production fixture fallback;
- lazy Dev rail entry and contextual sidebar frame;
- strict binary center layout plus independent left/right utility slots;
- scoped V2 layout/selection preference with a tested V1 migration;
- responsive, keyboard, screen-reader, focus/full-width modes and explicit
  focus restoration after pane close or utility collapse.

Acceptance:

- [ ] Chat/Virtual initial graphs contain no Dev/xterm/CodeMirror/browser chunk.
- [ ] One authoritative `RuntimeSession` projection is shared by Dev and Chat;
      switching views never launches, stops, duplicates, or silently transfers it.
- [ ] Project/session/node selection is scope-validated; stale, archived,
      revoked, and cross-project IDs recover visibly without data crossover.
- [ ] Split insert/remove/resize/move/collapse/restore invariants pass property
      and Muxy/bb-derived fixture tests; maximum depth/leaves are enforced.
- [ ] Left and right utility slots operate independently, preserve their own
      active pane/collapse/size/full-width state, and persist placement/order.
- [ ] Corrupt/unknown persistence, quota failure, storage loss, and V1 values
      fall back without deleting unread data; focus targets normalize to leaves.
- [ ] Loading/empty/offline/unavailable/stale/error states do not collapse UI.
- [ ] Split, move, duplicate, close, undo-close, collapse, expand, focus, and
      restore behave deterministically and preserve the one-session invariant.
- [ ] URL/deep-link project/session selection is deterministic and invalid IDs
      recover visibly while preserving unknown query keys.
- [ ] Boundary tests prove Dev UI never reads `window.__adeaDesktop` or imports
      shell/desktop modules directly.
- [ ] 320/768/1280/1920 px, 80/100/200% zoom, keyboard-only, focus restoration,
      and WCAG 2.2 AA checks pass.

## Task 3 — Worktree lifecycle service

Issue: [#397](https://github.com/adea-ai/adea/issues/397)
May start after: #394, #395, and M10 #33/#34/#185. Must use those authorities to close.

Deliverables:

- authorized discovery/adoption/create/bootstrap/lease/archive/merge/cleanup;
- per-repo mutation ownership/cross-process lock and durable journal;
- CoW-first `.worktreeinclude` bounded plan/copy (native file clones, never
  stream loops) and the per-project dependency-template cache: one immutable,
  lockfile-digest-validated template per project, package-manager-aware,
  cloned into new worktrees, promoted only from an approved successful
  bootstrap;
- expected-SHA merge/branch cleanup and quarantine trash with continuation.

Acceptance:

- [ ] Creation never resets or mutates the primary checkout unexpectedly.
- [ ] Every side effect revalidates repo/root/gitdir/path identity and generation.
- [ ] Bootstrap/teardown is approved argv/cwd/env digest, never shell text.
- [ ] Include copy rejects escapes, symlinks, special files, overwrites, budget
      excess, identity races, and unapproved secret-like files.
- [ ] `.worktreeinclude` and dependency-template materialization are CoW-first
      (native file clones, no stream loops) and pass the measured 50k-file
      fixture on APFS within bounded time and disk; templates are immutable,
      digest-validated, never mutated in place, and one build runs at a time
      per project.
- [ ] Archive is lossless and distinct from complete-and-clean.
- [ ] Dirty/unpushed/conflicted/leased/external/protected/dangerous/nested or
      unproven state blocks destructive cleanup.
- [ ] Crash at every transition resumes idempotently or leaves explicit
      quarantine/recovery; no deletion error is ignored.
- [ ] PID/PGID/path replacement and concurrent-process tests prove unrelated
      worktrees/processes survive.
- [ ] Folder repositories, local bases, detached/remote bases, name/path
      collision, and known external-worktree adoption have deterministic tests.
- [ ] Multi-process lock contention/stale-owner recovery and duplicate
      idempotency keys are tested across real processes, not one promise queue.
- [ ] Trash pagination persists/resumes beyond one sweep cap and restart.

## Task 4 — Project registry and sidebar

Issue: [#398](https://github.com/adea-ai/adea/issues/398)
Depends on: #394, #395, #397; consumes M10 RuntimeConnection inventory #30/#37.

Deliverables:

- groups/projects/repos/worktrees/sessions and paged archive shelf;
- add/recent/picker/clone/GitHub/monorepo/external-worktree flows;
- bounded KiroCrew-derived scanner and fingerprint cache;
- visible-row-priority status/watch scheduler;
- one transactional new-session flow;
- per-project dependency-template default and template status
  (hit / stale / building / absent / failed) with explicit rebuild/clear
  controls.

Acceptance:

- [ ] IDs and relationships remain separate and runtime-node scoped.
- [ ] Scanner honors workspace declarations/ignores, prunes before descent,
      never follows symlinks, enforces every budget, cancels, and reports partial
      results explicitly.
- [ ] Add/import shows canonical identity, authorization, node, duplicate, and
      adoption status before mutation.
- [ ] 0, 1, and 1,000 row/group/tree/drag/keyboard-navigation fixtures pass;
      1,000 rows virtualize without per-row processes or polling storms.
- [ ] Status rollups use deterministic source precedence plus provenance,
      confidence, freshness, unknown, and degraded markers.
- [ ] Scanner fixtures cover supported repository/language/workspace manifests,
      ignores, malformed metadata, duplicate packages, and budget exhaustion.
- [ ] Watcher overflow/permission loss/offline node degrades to bounded refresh.
- [ ] Any new-session failure leaves a visible retryable transaction and no
      silent orphan or destructive rollback.
- [ ] The per-project dependency-template default is settable, shows template
      state, and rebuild/clear never runs automatically during scan/import.

## Task 5 — Terminal runtime

Issue: [#396](https://github.com/adea-ai/adea/issues/396)
May start after: #394, #395, and M10 #33/#34/#185. Closure also requires #397 and M10 #30–#32 runtime-node routing.

Deliverables:

- Bun 1.4 byte-preserving PTY adapter and detached versioned sidecar;
- authenticated full-duplex attach/input transport;
- bounded output/replay/checkpoints/backpressure and sidecar adoption/update;
- owner-only shell wrappers/history and generation-bound input authority;
- lazy `@xterm/xterm` renderer with WebGL-to-DOM recovery.

Acceptance:

- [ ] Fragmented/invalid UTF-8 and callback-before-wrapper fixtures preserve all
      source bytes and correct exit order.
- [ ] Replay is exactly once by sequence; old coverage returns checkpoint plus
      `resync_required`; slow subscribers cannot block PTY draining.
- [ ] Attach requires endpoint credential, executable/protocol identity, scope,
      session, nonce, and generation; PID/port files grant nothing.
- [ ] App/window close detaches; explicit terminate acts only on still-owned
      process group after identity recheck.
- [ ] OSC/title/link/clipboard/paste attacks, oversized frames, stale channels,
      replayed tokens, and input-transfer races fail closed.
- [ ] Packaged macOS runs a real Bun PTY smoke covering spawn, bytes, resize,
      signal, exit, detach/adopt, sidecar update/drain, and unsupported platform
      capability behavior; fixture-only tests cannot close the issue.
- [ ] Network flap, checkpoint corruption, WebGL loss/DOM fallback, resize storm,
      IME/composition, paste, alternate-screen TUI, and flow-control tests pass.
- [ ] 24-hour/high-output soak stays within measured memory/disk/fd/listener/
      process budgets and terminal input-to-paint meets the spec.

## Task 6 — Files, editor, search, and local source control

Issue: [#399](https://github.com/adea-ai/adea/issues/399)
Depends on: #394, #395, #397 and M10 #33 filesystem/process authority.

Deliverables:

- Terax-derived Solid file tree, CodeMirror editor, diff/review surfaces;
- authorized host filesystem adapter and streaming `rg`;
- local status/history/stage/unstage/diff/commit/checkpoint/restore;
- external editor capability.

Acceptance:

- [ ] Absolute/traversal/symlink-parent/special-file/cross-worktree and TOCTOU
      fixtures fail before side effect.
- [ ] Save is compare-and-swap atomic and preserves BOM, encoding, per-line
      mixed EOL, final newline, and reviewed permissions.
- [ ] Binary/unsupported/large files use explicit read-only/bounded fallback.
- [ ] Search is argv-only, streamed, cancellable, budgeted, and reports partial.
- [ ] Git parsing is NUL/option-safe for hostile filenames and uses plan/commit
      for discard/restore.
- [ ] 100,000-file tree, concurrent external/editor write, worker cancellation,
      10,000-line file, and 10,000-hunk diff fixtures pass without >50 ms tasks.
- [ ] Checkpoint refs have documented retention/GC and restore conflict tests.
- [ ] External-editor launch validates executable capability, argv/path, runtime
      node, and unavailable behavior.
- [ ] Remote URLs redact credentials and retain nested namespace paths.

## Task 7 — Harness/runtime sessions

Issue: [#400](https://github.com/adea-ai/adea/issues/400)
Depends on: #394, #396, #397, M10 #30–#32/#34/#185, and M11 #36–#41/#43.

Deliverables:

- separate AgentProfile, HarnessInstallation, preferences, RuntimeSession, and
  HarnessRun types;
- discovered installation health/model/command registry and precedence;
- automatic default-harness launch and guarded prompt delivery;
- native/ACP → authenticated hook → terminal fallback reducer;
- shared Dev/Chat projection, history/archive/status.

Acceptance:

- [ ] Disabled/missing/unauthenticated/incompatible/stale-unverified/unhealthy
      harnesses never auto-launch.
- [ ] Launch is idempotent and leaves worktree/terminal recoverable on failure.
- [ ] Initial prompt follows structured-first precedence; ambiguous delivery is
      visible and never blindly duplicated.
- [ ] Lower-confidence input cannot overwrite higher-authority events or create
      semantic tool/approval truth.
- [ ] Dev ↔ Chat switch preserves one session/process/input owner and launches
      nothing.
- [ ] Pi, Claude Code, Codex, and OpenCode fixture matrices cover discovered,
      missing, disabled, auth-required, version/model/command, launch, resume,
      cancellation, and degraded transcript behavior.
- [ ] History is paged, searchable, jumpable to source/session, and displays
      provenance/freshness without relying on terminal scrolling.
- [ ] Any required M11 contract change lands in the same commit with its spec.
- [ ] Sequence gaps, duplicate/out-of-order events, disconnect/revoke/resume,
      generation crossover, and forged OSC/hook tests pass.

## Task 8 — Browser & Devices

Issue: [#422](https://github.com/adea-ai/adea/issues/422)
Depends on: #394, #395, M10 #33/#34/#185, and RuntimeConnection #30/#37. #422 may close before #400; agent-event attachment stays explicitly unavailable until #400, and #426 requires both.

Deliverables:

- human embedded, task-owned Bun.WebView, and external user-context/CDP lanes;
- preview/target/port discovery, screencast/input/takeover, screenshots and
  annotations;
- atomic origin-scoped cookie import and profile reset;
- responsive emulation plus iOS/Android inventory/launch/attach.

Acceptance:

- [ ] Profiles, credentials, cookies, generations, and automation authority
      cannot cross lane/session/workspace/node boundaries.
- [ ] Every navigation/redirect passes scheme/DNS/IP/SSRF policy; loopback
      exception requires an Adea-owned service proof.
- [ ] Browsed pages cannot call privileged desktop routes.
- [ ] Frame backpressure, stale input, viewport generation, disconnect/resume,
      crash/recovery, and human Escape release pass.
- [ ] Cookie failure/cancel rolls back all writes and leaks no values.
- [ ] Element picking, console/network diagnostics, screenshots/annotation, port
      preview, movable mini-preview, responsive presets, and external-browser
      takeover all have local/remote authorization and stale-generation tests.
- [ ] Device commands use verified inventory IDs/fixed argv and stop only
      Adea-launched still-matching processes.
- [ ] Packaged CEF/Bun.WebView/CDP tests pass; browser fixtures alone do not
      satisfy completion. A 30-minute navigation/resize/takeover soak and
      measured frame/input/CPU/memory budgets pass.

## Task 9 — GitHub source control

Issue: [#423](https://github.com/adea-ai/adea/issues/423)
Depends on: #394, #397, #398, #399 and M10 #33. Task/event links consume M11 #36/#38/#39; M11 remains execution authority.

Deliverables:

- provider-neutral remote source contract and GitHub adapter;
- issues/milestones/PR/check/review presentation;
- safe push, update branch, draft PR, and merge plan/commit flows;
- caching, pagination, rate limits, enterprise-host trust, reconciliation.

Acceptance:

- [ ] Provider objects/credentials do not enter UI state or wrong hosts.
- [ ] Pagination, ETag/cursor, rate-limit, offline/stale, auth-expired, enterprise,
      and ambiguous-timeout fixtures are deterministic.
- [ ] Force uses exact expected-SHA lease; protected/default branches and moved
      refs refuse.
- [ ] Update conflicts preserve recoverable refs/worktrees and never auto-reset.
- [ ] PR create reconciles duplicate/timeout and defaults to draft.
- [ ] Normal push/upstream setup, detached/no-upstream, auth expiry, non-fast-
      forward, and moved-ref behavior are covered before force is considered.
- [ ] Merge follows repository strategy/rules/checks/reviews/conversations with
      no admin bypass.
- [ ] Malicious remote text is sanitized and never becomes command/prompt input.
- [ ] At least one opt-in disposable integration repository exercises real API
      pagination, draft PR, checks, and cleanup without touching production.

## Task 10 — Resources, usage, and cleanup

Issue: [#424](https://github.com/adea-ai/adea/issues/424)
Depends on: #394, #396, #397, #398, #400, #422; consumes M10 #34/#185 and M11 #36/#39/#43 contracts, events, and external-session projections.

Deliverables:

- joined resource inventory and explicit ownership/provenance;
- bounded process/port/CPU/memory sampling and history;
- source/freshness/confidence-labeled usage adapters;
- Archive and separate proof-driven Complete-and-clean UI over #397;
- dependency-template caches in the retained-data breakdown and as explicit
  cleanup candidates (#397/#398).

Acceptance:

- [ ] Unknown/external resources remain visible without destructive actions.
- [ ] PID/PGID/name/cwd/port alone never grant stop; replacement races survive.
- [ ] Sampler honors active/idle/hidden schedules, timeout/concurrency/output and
      retention budgets; unsupported/denied/stale is not zero.
- [ ] Usage URLs/redirects/credentials obey host, HTTPS, DNS/IP, SSRF, caching,
      backoff, and terms policy; estimates are not billing truth.
- [ ] Telemetry is off by default and redaction tests cover all private fields.
- [ ] Cleanup plan exposes every blocker; changed facts invalidate commit;
      partial/crash recovery resumes without unrelated data loss. A restart
      after quarantine rolls back only with durable identity proof and reports
      per-step `rolled_back`/`pending` results; ambiguous later steps remain
      `recovery_required`.
- [ ] Automatic cleanup runs only under the versioned, previously approved
      project policy and exact safe predicates; unknown/stale facts request
      confirmation and policy edit/revoke/expiry are audited.
- [ ] Performance covers 100 sessions and 1,000 processes with no polling storm
      or >16 ms UI task; resource/cleanup soak proves bounded history.
- [ ] Dependency-template caches appear in the retained-data breakdown and as
      cleanup candidates; clearing one never touches worktrees or the primary
      checkout.

## Task 11 — Appearance and App Library

Issue: [#425](https://github.com/adea-ai/adea/issues/425)
Depends on: #394, #395

Deliverables:

- Zeron-derived live appearance popover and version-2 preference;
- coherent semantic tokens for UI/xterm/CodeMirror/charts;
- KiroCrew-derived App Library categories/search/detail/installed UX;
- safe rail hide/reorder/reset over existing verified plugin infrastructure.

Acceptance:

- [ ] Old preference migrates with no flash/data loss; corrupt/unknown versions
      retain raw data and fall back.
- [ ] System/light/dark, separate variants, accent, surface, OS/user reduced
      transparency, high contrast, reduced motion, and live changes pass.
- [ ] Terminal/editor update without remount/output/selection loss; browser page
      content is unchanged.
- [ ] Contrast/focus/selection/ANSI/syntax/diff/search token matrix passes.
- [ ] Only bundled first-party entry IDs activate; catalog metadata cannot
      execute downloaded JS, remote modules, eval, or postinstall.
- [ ] App Library preserves connector/skill/category/search/installed filters,
      catalog signature/digest/staleness, approval-required install plan, and
      activation denial behavior from the existing verified marketplace.
- [ ] Core navigation remains recoverable and resettable.
- [ ] `scripts/check-theme-colors.mjs` and component accessibility/visual
      regression matrices pass for every bundled theme.
- [ ] KiroCrew provenance and NOTICE rows are exact; imported theme license is
      never inferred from “User supplied.”

## Task 12 — Integration and release gate

Issue: [#426](https://github.com/adea-ai/adea/issues/426)
Depends on: every other M12 issue, M10 #33/#30–#34/#185, and M11 #36–#41/#43.

Deliverables:

- deterministic cross-subsystem fixture suite and packaged E2E owner journey;
- authorization/adversarial, performance, soak, accessibility, packaging,
  update/rollback, provenance, and documentation evidence;
- release report tying every acceptance item to a test/artifact.

Acceptance:

- [ ] Complete owner journey passes the local packaged desktop, including
      reconnect/resume and partial-failure recovery. M12 exercises the shared
      remote-ready adapter with authorized fake RuntimeConnection and revocation
      fixtures, but production remote-node certification is explicitly owned by
      M14 — Remote Runtime Integration (owner decision 2026-09-16).
- [ ] Account/workspace/node/resource/generation/channel/path/process/browser/
      credential crossover suite passes.
- [ ] Every adversarial and failure case in the Dev Runtime spec has evidence.
- [ ] Performance budgets and 24-hour soak pass without silent cap/truncation.
- [ ] 320/768/1280/1920, zoom, keyboard, screen-reader, reduced motion/
      transparency, and WCAG 2.2 AA matrix passes.
- [ ] Signed/notarized packaged desktop launches offline and after update;
      sidecar version migration/rollback retains recoverable sessions.
- [ ] Lazy bundle excludes Dev dependencies from Chat/Virtual and contains no
      React/Pierre/donor host runtime.
- [ ] Provenance ledger, headers, dependency licenses, NOTICE, Warp denylist,
      OpenGrok full-history/artifact denylist, manual similarity review, and
      attestation pass.
- [ ] Owner-journey and failure matrices retain screenshot/video plus machine-
      readable logs at named artifact paths; clean installs need no manual file,
      database, sidecar, or profile repair.
- [ ] Any deferred criterion points to a separately owner-accepted follow-up
      issue and states why M12 can safely ship without it.
- [ ] All required docs and routed specs are current and all predecessor issues
      are closed with current test evidence.

## Task 13 — macOS permissions onboarding

Issue: [#471](https://github.com/adea-ai/adea/issues/471)
Depends on: #394, #395; consumes M10 #33 capability reporting.

Deliverables:

- live TCC status page with per-permission purpose, exact System Settings deep
  links, and restart-free re-check;
- capability extension in the registry/spec when missing;
- dependent-feature degradation wired into the Dev View consumers.

Acceptance:

- [ ] Statuses reflect real TCC state on a packaged macOS build, including the
      owner's denied Accessibility/Screen Recording state.
- [ ] Deep links land on the correct pane; re-check updates without restart.
- [ ] Denied permissions visibly disable dependent features; nothing is
      auto-granted or nagged; the web lane renders unavailable truthfully.

## Task 14 — Computer use lanes

Issue: [#472](https://github.com/adea-ai/adea/issues/472)
Depends on: #394, #395, #400, #422, #471, and M10 #33. The planning slice
(spec operations, stream protocol, threat model, manifest) lands in one
commit before implementation.

Deliverables:

- session/generation-scoped computer-use grants executed through an
  authorized native helper (Orca-derived, public macOS APIs only);
- live-view pane with approval gates and instant human takeover;
- audit, redaction classification, and packaged macOS smoke coverage.

Acceptance:

- [ ] Grants die with the HarnessRun; takeover suspends agent input instantly
      and Escape releases; stale-generation input is inert.
- [ ] Threat-model additions (privileged-surface typing, secret capture,
      grant escalation) land with the planning slice and carry evidence.
- [ ] Packaged macOS smoke covers capture, input, takeover, revocation, and
      TCC-denied behavior; fixture-only work cannot close.

## Evidence artifacts and waivers

Local and CI evidence uses the same ignored/output convention:

```text
artifacts/dev-view/<git-sha>/<command>/summary.json
artifacts/dev-view/<git-sha>/<command>/junit.xml
artifacts/dev-view/<git-sha>/<command>/screenshots/**
artifacts/dev-view/<git-sha>/<command>/videos/**
artifacts/dev-view/<git-sha>/<command>/metrics.json
```

Each named Dev script creates its command directory atomically and records app,
sidecar, Bun, OS, runtime-node fixture, donor-manifest version, start/end,
thresholds, result, and redacted failures. CI uploads it as
`dev-view-<command>-<git-sha>` with at least 30-day retention; the 24-hour soak
artifact retains raw sampled metrics plus its bounded-resource summary.
Artifacts contain no terminal/file/prompt/cookie/credential bodies.

A waiver requires a linked owner-accepted issue plus same-commit ADR/spec/plan
change naming measured evidence, exact criterion/platform, safe fallback,
expiry, and follow-up owner. Authorization, isolation, lossless cleanup,
credential/browser-profile boundaries, accessibility essentials, provenance,
and prohibited-donor checks cannot be waived.

## Validation commands

Use the repository-declared Bun scripts below. The generic shared-runtime
commands in `AGENTS.md` apply only when `src/runtime.mjs` exists; it does not at
this repository revision, so they are not substitutes for these scripts:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run build
bun run test:unit
bun run test:integration
bun run test:e2e
bun test scripts/docs-boundary.test.ts

# These exact scripts must be introduced by their owning M12 slices:
bun run test:smoke:dev-view
bun run test:eval:dev-view
bun run test:performance:dev-view
bun run test:security:dev-view
bun run test:soak:dev-view
bun run test:packaged:dev-view
```

Run focused package/test commands during each slice, then the full applicable
set. #396/#422 own packaged smoke fixtures; #424 owns resource/cleanup
performance and soak; #426 composes the exact six named scripts above and
retains their artifacts. The issue adding each script MUST define platform,
fixture, timeout, output path, and pass thresholds in the same commit. #426
cannot close until every command exists and passes. A skipped check is not
passing evidence.

## Definition of done

An issue is done only when:

1. dependencies are closed or their required production authority is present;
2. the licensed donor unit was reused where directed and provenance is exact;
3. all issue acceptance criteria have current automated or explicitly required
   packaged/manual evidence;
4. spec/ADR/guide/plan changes land with behavior changes;
5. failures are typed, state is recoverable, and unavailable capability is
   truthful;
6. focused and broad applicable checks pass;
7. final diff has no unrelated, generated, secret, or prohibited donor material.

M12 is done only through #426. Do not close or archive dependent work
implicitly, and do not report the milestone complete while required validation,
review, packaging, or upstream authority remains pending.
