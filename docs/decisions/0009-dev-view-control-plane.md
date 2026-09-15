# Dev View Control Plane

- Status: Proposed for acceptance in #394
- Date: 2026-09-14
- Tracks: [M12 milestone](https://github.com/adea-ai/adea/milestone/23),
  [#394](https://github.com/adea-ai/adea/issues/394)
- Product authority: the owner's Apple Note **“Adea Dev View”**
- Research: [Dev View donor audit](../research/dev-view-donor-audit.md) and [exact source manifest](../research/dev-view-source-manifest.json)
- Normative contract: [Dev Runtime spec](../specs/dev-runtime.md) and [exact operation registry](../specs/dev-runtime-operations.json)
- Threat model: [Dev View threat model](../security/dev-view-threat-model.md)
- Implementation sequence: [M12 plan](../plans/m12-dev-view.md)

## Context

Adea needs a daily-driver developer control plane, not another chat wrapper and
not a second desktop client. The product must make projects, isolated worktrees,
terminals, agents, files, source control, browsers/devices, resources, and safe
cleanup available from one coherent workspace while preserving the Control
Plane and runtime-node authority established by M10/M11.

The existing app is one SolidJS UI served by `apps/web` and wrapped by
Electrobun 2.0.1 using Bun 1.4 and bundled CEF. ADRs
[0006](./0006-browser-lanes-and-desktop-shell.md),
[0007](./0007-solid-tanstack-start.md), and
[0008](./0008-build-bundler-vite-vs-bun.md) remain controlling. The existing
HTTP invoke/SSE desktop bridge is generic request/event plumbing; it is neither
a PTY transport nor an authorization boundary.

## Decision

Build Dev View as a lazy Solid package projected through the existing web UI.
Implementation is donor-first: copy or substantially adapt the cited coherent
MIT/Apache implementation units and their tests, preserve proven structure and
behavior, replace only incompatible UI/host seams, then add Adea's authority and
hardening. Novel implementation requires evidence that no licensed mapped unit
fits. Warp's relevant AGPL code and the unlicensed OpenGrok reconstruction are
the only clean-room/prohibited exceptions described below.

Dev and Chat display the same canonical `RuntimeSession`; neither owns a
separate harness process. Privileged operations are execution-host adapters
behind M10 authorization. M12 adds no competing runtime-node, credential,
approval, cancellation, or durable-task authority.

### Product composition

- Preserve the slim global rail and add **Dev** below Chat.
- Give Dev a full-height contextual sidebar:
  group → project → repository → active session/worktree, with a paged archived
  shelf pinned to the bottom.
- Display exactly one primary runtime session. Terminal/editor leaves may split
  within that session; do not create a permanent top-level tab forest.
- Use direct utility toggles:
  - left: Files / Source Control;
  - right: Browser / Devices and Agents / History.
- Allow utility panes to resize, collapse, restore, move where meaningful, and
  expand full-width. Focus mode hides surrounding chrome without destroying it.
- Define “new session” as one visible, durable transaction:
  authorize → update base → create worktree → bootstrap → terminal → default
  harness.
- Separate **Archive only** from **Complete and clean…**. Archive is lossless;
  cleanup is a proof-driven, recoverable operation.

### Technology choices

| Surface           | Decision                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| UI/runtime        | SolidJS in the existing `apps/web` client; Kobalte/corvu and existing `packages/ui` primitives per ADR 0007 |
| Dev package       | lazy `packages/dev-view`                                                                                    |
| UI state          | `packages/state` for ephemeral selection/layout only                                                        |
| Server state      | `packages/data` query/provider layer                                                                        |
| Shared contract   | `packages/types/src/dev-runtime.ts`                                                                         |
| Desktop adapter   | `apps/web/src/lib/desktop-dev-runtime.ts`                                                                   |
| Privileged host   | `apps/desktop/shell/src/dev-runtime/**` behind M10                                                          |
| Terminal          | Bun 1.4 runtime PTY adapter in a detached, versioned sidecar; Bun remains outside the app bundler role      |
| Terminal renderer | `@xterm/xterm`, lazy WebGL, DOM fallback                                                                    |
| Editor            | CodeMirror 6 with a thin Solid owner                                                                        |
| Search            | supervised argv-only `rg`, bounded fallback                                                                 |
| Browser           | ADR 0006 lane model; Bun.WebView for task-owned embedded lane                                               |
| Build             | Vite 8/Rolldown + Turborepo; Bun is runner/runtime, not app bundler                                         |

### Package and dependency rules

```text
packages/types/src/dev-runtime.ts
  ↑ shared DTOs, IDs, envelopes, schemas; no UI/host imports
packages/data/src/dev-runtime.ts
  ↑ Solid Query keys/providers; no desktop import
packages/dev-view/src/**
  ↑ UI only; consumes WorkspacePlatformServices
apps/web/src/lib/desktop-dev-runtime.ts
  ↑ maps platform contracts to authenticated desktop commands/channels
apps/desktop/shell/src/dev-runtime/**
  ↑ privileged adapters; delegates authorization to M10
```

Forbidden dependencies:

- `packages/dev-view` → `apps/desktop/**` or `window.__adeaDesktop`;
- UI packages → filesystem, process, PTY, CDP, keychain, or git implementations;
- `packages/state` → durable project/session/process truth;
- desktop shell → a second UI implementation;
- M12 host code → a second command server bypassing M10;
- any production client path → React, Electron, Tauri, GPUI, donor wrappers, or
  unverified downloaded JavaScript.

`WorkspacePlatformServices` is the only UI capability seam. The web/remote
implementation returns supported/degraded/unavailable capabilities truthfully;
it never attempts desktop APIs.

## Canonical runtime session

`RuntimeSession` binds account, workspace, runtime node, project, repository,
worktree, terminal, task, AgentProfile version, HarnessInstallation, and active
HarnessRun generation. Identity types remain independent:

- `AgentProfile`: persona/instructions/skills/policy;
- `HarnessInstallation`: executable/protocol/version/auth/capabilities on one
  runtime node;
- `HarnessPreference`: enabled/order/default/model/profile choices;
- `RuntimeSession`: durable cross-view session identity;
- `HarnessRun`: one launch or resume generation.

Event precedence is fixed:

1. native/ACP structured events;
2. an Adea-owned authenticated hook wrapper, authoritative only for event types
   it owns;
3. bounded PTY transcript projection, visibly degraded and never promoted to
   semantic tool/approval truth.

Changing view cannot launch, stop, duplicate, or adopt another process.
Generation-bound input authority has one owner at a time and fences terminal
keys, Chat sends, automatic prompt delivery, and browser/device takeover.

## Worktree and process authority

A session worktree belongs to its execution host. Durable facts and lifecycle
journals live there; the Control Plane exposes authorized read models and
commands. Repository mutations serialize through one authoritative owner or a
cross-process lock with stale-owner recovery.

No path is authorized by string prefix. Every operation binds an authorized
root, canonical relative path, file/directory identity, runtime node, and
expected generation, then revalidates immediately before the side effect.
Symlinks, special files, replacement races, dangerous paths, external
provenance, active leases, dirty/unpushed/conflicted state, and protected refs
are explicit cases.

No process is owned because of cwd, executable name, port, PID, or parent alone.
Destructive action requires a launch record and PID start identity plus
process-group/session generation, rechecked before every signal. Unknown
processes and ports may be displayed as external but have no stop action.

## Browser decision

ADR 0006 remains normative:

- human embedded and task-owned agent lanes use different profile/process
  identities;
- Electrobun's bundled CEF renders the Adea shell and human embedded lane;
- M12's separate task-owned agent lane uses Bun 1.4 `Bun.WebView`, supervised by
  the authorized execution host. Per ADR 0006, Bun.WebView may drive macOS
  WebKit or a dedicated local Chromium over CDP; it is not a replacement shell,
  not the shell's CEF context, and never shares the human profile;
- external user-context browsing defaults to dedicated Chromium over CDP with
  per-origin consent and mirrored takeover;
- a real-browser extension is a separately permissioned future adapter, not an
  M12 alternative;
- browsed pages have no privileged bridge and loopback presence is never
  authentication.

## Appearance and App Library

Replace the single theme preference with a versioned appearance model:
system/light/dark mode, separate light/dark theme IDs, accent, surface, and
reduced-transparency preference. OS Reduce Transparency forces opaque fallback.
Terminal/editor roles derive from the same semantic token manifest.

Evolve the existing verified Plugins surface into one App Library. In M12 only
bundled first-party app entry IDs may activate. Catalog-only entries may install
metadata/connectors but cannot execute UI code. No `eval`, arbitrary module URL,
downloaded JS, or unsandboxed postinstall is introduced.

## Security boundary

M10 issues #30–#34 and #185 are the sole runtime-node, process/filesystem,
credential, channel, harness-discovery, health, and local-supervision authority.
M11 #36–#41 and #43 own durable execution, approval, cancellation, resume,
profile versioning, and external-session read models. These are required
contracts, not claims that current HEAD already implements them: in particular,
`apps/desktop/shell/src/commands.ts` still uses the transitional file-backed
local-content store documented at the top of `docs/specs/local-content.md`.
M12 waits for the owning M10 acceptance evidence rather than treating the
planned OS credential-store/SQLite design as available.

At current HEAD, `/__adea/invoke` and `/__adea/events` must not carry privileged
M12 operations merely because they are loopback. Before any privileged Dev
command lands, M10 #33 must authenticate the command/channel and bind account,
workspace, runtime node, object ID, operation, generation, nonce/token expiry,
and capability. Browsed pages, stale windows, old channels, and replayed tokens
must fail closed.

## Persistence ownership

| Data                                     | Owner                                       | Store                             |
| ---------------------------------------- | ------------------------------------------- | --------------------------------- |
| pane visibility/size/focus, selected IDs | local UI                                    | versioned scoped preferences      |
| project/repo/worktree/session lifecycle  | execution host + Control Plane read model   | host durable store/events         |
| terminal bytes/checkpoints               | terminal sidecar                            | owner-only bounded runtime data   |
| canonical events                         | execution host/Control Plane event contract | bounded append log                |
| credentials/cookies                      | M10 vault/local-content authority           | never UI/localStorage             |
| browser profiles                         | execution host                              | owner-only lane directories       |
| process/port identity                    | execution host supervisor                   | launch/exit/lease records         |
| usage cache                              | authorized adapter                          | bounded, source/freshness labeled |

Unknown versions and corrupt local UI preferences fall back without erasing the
unread value. Durable mutations are idempotent and crash-recoverable.

## Dependency DAG

```text
M10/M11 substrate ───────────────┐
                                v
#394 architecture/spec/audit → #395 shell
             │              ├→ #399 files/local git ─→ #423 GitHub
             │              ├→ #422 browser/devices
             │              └→ #425 appearance/App Library
             └→ #397 worktrees ─→ #398 registry/sidebar
                         └──────→ #396 terminal ─→ #400 harness/session
#396 + #397 + #398 + #400 + #422 ───────────→ #424 resources/cleanup
all M12 issues ─────────────────────────────→ #426 release gate
```

Start and closure dependencies are distinct; fixture work may begin earlier,
but an issue cannot close before its production authority is present.

| Issue | May start after                | Must close after / consume                                                                                                                                                             |
| ----- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #394  | none                           | records M10/M11 ownership without duplicating it                                                                                                                                       |
| #395  | #394                           | #394; real integrations may not close on fixtures                                                                                                                                      |
| #397  | #394, #395, M10 #33/#34/#185   | same; all filesystem/process/git operations use those authorities                                                                                                                      |
| #398  | #394, #395, #397               | same; consume M10 RuntimeConnection inventory #30/#37                                                                                                                                  |
| #396  | #394, #395, M10 #33/#34/#185   | #394, #395, #397, M10 #30–#34/#185                                                                                                                                                     |
| #399  | #394, #395, #397               | same plus M10 #33 filesystem/process authority                                                                                                                                         |
| #400  | #394, #396, #397               | same plus M10 #30–#32/#34/#185 and M11 #36–#41/#43                                                                                                                                     |
| #422  | #394, #395                     | same plus M10 #33/#34/#185 and RuntimeConnection #30/#37. It does not wait on #400 to close; agent-event attachment remains explicitly unavailable until #400, and #426 requires both. |
| #423  | #394, #397, #398, #399         | same plus M10 #33; task/event links consume M11 #36/#38/#39 without taking execution authority                                                                                         |
| #424  | fixture work may start earlier | #394, #396, #397, #398, #400, #422; M10 #34/#185; M11 contracts/events/external-session projections #36/#39/#43                                                                        |
| #425  | #394, #395                     | same; extends existing theme/plugin authority                                                                                                                                          |
| #426  | all other M12 work             | every prior M12 issue; M10 #33/#30–#34/#185; M11 #36–#41/#43                                                                                                                           |

The `TerminalInputAuthority` interface is defined/tested with fixtures in #396;
#400 binds real harness ownership downstream. This avoids a dependency cycle.

## Rejected alternatives

- **Second desktop UI:** violates the single-UI rule and doubles behavior/tests.
- **Desktop APIs imported by Dev UI:** breaks web/remote and trust boundaries.
- **PTY text as canonical chat:** cannot prove tools, approvals, or delivery.
- **One shared human/agent browser profile:** leaks credentials and authority.
- **Permanent top tabs:** conflicts with the one-primary-session owner workflow.
- **Generic pane-type dropdown:** hides primary controls.
- **Work directly in the primary checkout:** prevents safe concurrent sessions.
- **Kill by name/cwd/port:** cannot prove ownership and is vulnerable to reuse.
- **Automatic force push, reset, cleanup, or merge:** destructive and ambiguous.
- **React wrappers/Pierre UI:** violates Solid-only client and bundle policy.
- **Warp AGPL translation:** prohibited by the license boundary.
- **`hexuria/opengrok` reuse:** no source license grant.
- **Unsigned remote App Library code:** violates the verified activation model.

## Consequences

- M12 is contract-first and can be delivered in dependency-ordered slices.
- Every privileged feature has one authority and one provider seam.
- The UI remains useful in unavailable/degraded states without fabricating data.
- Session continuity between Dev and Chat is structural, not a synchronization
  afterthought.
- Security and cleanup requirements are implementation acceptance criteria, not
  post-release hardening.
- Behavior changes to this decision land with updates to
  [the Dev Runtime spec](../specs/dev-runtime.md), the M12 plan, and affected
  tests in the same commit.
