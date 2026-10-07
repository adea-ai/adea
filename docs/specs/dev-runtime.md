# Spec: Dev Runtime

The normative contract for Dev View projects, worktrees, terminals, files/git,
harness sessions, browser/device lanes, resources, usage, archive, and cleanup.
Read this page before touching any routed Dev Runtime path in `AGENTS.md`.

- Status: Proposed normative contract for acceptance in #394
- Decision: [ADR 0009](../decisions/0009-dev-view-control-plane.md)
- Browser authority: [ADR 0006](../decisions/0006-browser-lanes-and-desktop-shell.md)
- Runtime-node identity: [runtime nodes](./runtime-nodes.md)
- Private local storage: [local content](./local-content.md)
- Durable workspace events: [workspace events](./workspace-events.md)
- Donor boundary: [source audit](../research/dev-view-donor-audit.md)
- Exact command registry: [Dev Runtime operations](./dev-runtime-operations.json)
- Browser caller and frame-transport boundary: [browser caller gaps](../research/dev-browser-caller-gaps.md)
- Threat model: [Dev View threat model](../security/dev-view-threat-model.md)
- Delivery order: [M12 implementation plan](../plans/m12-dev-view.md)
- Redesign in progress: [ADR 0011](../decisions/0011-unified-workspace-projects.md).
  The sections below stay normative until each change lands with its
  amendment. The device workspace scope (the Dev scope bound to the selected
  cloud workspace), the primary checkout worktree record, and the removal of
  project groups (v2 project bindings keyed by the cloud project id) have
  landed; see "Durable project/session authority" and scope admission below.

**Changelog discipline:** behavior described here and its tests change in the
same commit. M12 code cannot weaken an M10/M11 authority; if this page and an
upstream authority differ, the stricter fail-closed rule applies until the specs
are reconciled explicitly.

**Limit policy:** numeric values below are conservative, normative M12 initial
defaults chosen to bound untrusted work, memory, disk, descriptors, network
queues, and UI latency before implementation. #426 MUST measure them on the
reference packaged desktop and remote-node fixtures. An implementation may
tighten a limit safely; relaxing one or changing user-visible behavior requires
an owner-reviewed spec/test update in the same commit. “Configurable” never
means unbounded.

## Normative language

**MUST**, **MUST NOT**, **SHOULD**, and **MAY** have their RFC 2119 meanings.
“Host” means the authorized local device or remote runtime node that owns the
operation. “Client” means the Solid UI, whether packaged, web, or remote.
“Generation” is a monotonically increasing ownership epoch, not a timestamp.

## Scope and ownership

M12 projects existing authorities into Dev View:

| Concern                                                | Sole authority            | M12 responsibility                              |
| ------------------------------------------------------ | ------------------------- | ----------------------------------------------- |
| user/workspace permission                              | Control Plane             | request the named capability and render refusal |
| runtime-node identity/eligibility                      | M10 runtime-node contract | bind every host command to an eligible node     |
| process/filesystem/credential admission                | M10 #33                   | provide typed Dev operations behind the gate    |
| harness discovery/ACP and health                       | M10 #30–#34/#185          | preferences, launch orchestration, projection   |
| durable tasks/approvals/cancel/resume/profile versions | M11 #36–#41/#43           | consume, never duplicate                        |
| Dev View layout/selection                              | M12 client                | versioned ephemeral preference                  |
| worktree/session/terminal/browser lifecycle            | execution host            | durable state and authorized projections        |

The existing `/__adea/invoke` and `/__adea/events` endpoints are not authority.
No privileged Dev command may use them until M10 authenticates the channel and
every request. Loopback address, same origin, hidden URL, CEF embedding, or
knowledge of an object ID MUST NOT grant permission.

Pane placeholders use the shared Empty composition and concise domain guidance:
files point to the Files panel, while terminals distinguish unavailable runtimes
from sessions without an open terminal. Transport implementation details are not
presented as terminal output.

## Package boundary

- `packages/types/src/dev-runtime.ts`: IDs, enums, request/response/event DTOs,
  versioned decoders; no UI or host imports.
- `packages/data/src/dev-runtime.ts`: query keys, provider context, cache and
  invalidation; no desktop imports.
- `packages/dev-view/src/**`: Solid UI only, through `WorkspacePlatformServices`.
- `apps/web/src/lib/desktop-dev-runtime.ts`: desktop provider adapter only.
- `apps/desktop/shell/src/dev-runtime/**`: privileged host adapters behind M10.
  These sources are also the canonical adapter implementation loaded by an
  authorized remote runtime-node host; the node host exposes the same registry
  over an authorized `RuntimeConnection`, never a second wire contract.
- `packages/state`: ephemeral selected IDs, collapsed sections, layout/focus;
  never durable entity truth, output, content, credentials, or process IDs.

Web/remote providers implement the same contract and return explicit capability
states. `packages/dev-view` MUST NOT import `apps/desktop`, desktop bridge
modules, or read `window.__adeaDesktop`.

## Execution location policy (M11 #186)

Execution location is an explicit, durable choice on an execution attempt. It
is not a different Task, Agent, Profile, or conversation product. The pure
contract is implemented in
[`packages/types/src/execution-location.ts`](../../packages/types/src/execution-location.ts)
and consumes a normalized RuntimeNode read model; it does not discover nodes,
authorize transport, mint entitlements, or move work.

- When no preference or per-task override is present, the policy selects the
  paired `local_device` identified by `localRuntimeNodeId`. A `remote_host`
  selection always names its registered `runtimeNodeId` explicitly.
- The policy evaluates only the selected location. It MUST NOT silently use a
  different local node, self-hosted node, or Agent HQ Cloud location when the
  selected location is unavailable.
- An `offline` or `stale` selected node produces a queued decision with a
  reconnect/refresh remediation. A `revoked`, `incompatible`, missing, or
  capability-mismatched selection produces a blocked decision with typed
  remediation. Unknown or malformed availability is blocked. These decisions
  retain the selected location for the caller to persist and display.
- A node read model MUST include an observation timestamp. An `available` node
  MUST also include a fresh proof timestamp. Observations or proofs older than
  the bounded five-minute admission window queue as `location_stale`; missing,
  invalid, or future timestamps block as `location_unknown`. A retry performs
  this freshness and availability admission again against the current read
  model; a prior `available` result is never reused as authority.
- `agent_hq_cloud` is reserved behind an explicit feature gate. A disabled
  gate blocks the request; the policy never treats cloud as a fallback for a
  local or self-hosted selection. A future enabled gate may evaluate cloud
  capabilities without changing this location contract.
- Retries retain the prior attempt's selected location. A changed location is
  accepted only with a non-empty opaque `authorizationProof` bound to the
  attempt's account/workspace/task/actor scope, attempt number, and exact
  target location. A valid proof still requires current location admission.
  A changed location is represented as a new attempt decision; a retry does
  not mutate the previous attempt's provenance. A raw authorization boolean
  is not an admission proof.

Execution availability and conversation/content availability are separate
dimensions. The policy carries these read-model states independently:
`channelMessageMetadata`, `synchronizedHistory`, and `localOnlyContent`.
Consequently, a selected host may be offline while channel metadata and
authorized synchronized history remain available, while local-authority
bodies remain explicitly unavailable. RuntimeNode availability MUST NOT be
used as a substitute for ContentSyncDevice or content-key authorization.

The M11 Control Plane integration still owns persisted Task/attempt history,
actual execution admission, ContentSyncDevice authorization, and transport.
Those integrations MUST record the selected location and, after admission,
the actual RuntimeNode provenance rather than inferring it from UI state.

## Stable identifiers

All externally visible IDs are opaque lowercase UUIDs unless an upstream
contract already supplies an opaque stable ID. IDs are never paths, PIDs,
branch names, URLs, or array indexes.

| ID                      | Identity                                                     |
| ----------------------- | ------------------------------------------------------------ |
| `projectId`             | cloud project id a local binding is keyed by                 |
| `repoId`                | canonical repository/common-dir identity on one runtime node |
| `worktreeId`            | never-reused checkout identity                               |
| `runtimeSessionId`      | canonical Dev/Chat session                                   |
| `bookmarkId`            | M10-minted authorized root grant                             |
| `credentialRefId`       | vault-held credential reference, never the secret            |
| `accountProfileId`      | reusable device-wide harness account profile (ids only)      |
| `shellProfileId`        | named host-admitted shell configuration                      |
| `profilePolicyId`       | named browser lane-permission policy                         |
| `terminalId`            | one PTY lifecycle within a session                           |
| `harnessInstallationId` | discovered harness on one runtime node                       |
| `harnessRunId`          | one launch/resume generation                                 |
| `leaseId`               | ownership lease for a runtime resource                       |
| `browserLaneId`         | one browser/profile lifecycle                                |
| `deviceSessionId`       | one responsive/simulator/device attachment                   |
| `processRecordId`       | Adea launch identity, not PID                                |
| `cleanupJobId`          | durable cleanup transaction                                  |
| `requestId`             | one command attempt                                          |
| `idempotencyKey`        | one logical mutation across retries                          |

Records containing both ID and path MUST prove they resolve to the same
canonical object. A mismatch is `identity_mismatch`; neither value wins.

## Core domain model

The shared type module MUST express at least the following fields. Names may be
split into smaller interfaces, but meaning and required bindings cannot change.

```ts
type ProjectState = 'importing' | 'cloning' | 'scanning' | 'ready' | 'archived' | 'failed'
type RepoState = 'authorizing' | 'ready' | 'unavailable' | 'stale' | 'refreshing'
type WorktreeState =
  | 'discovered'
  | 'authorizing'
  | 'creating'
  | 'bootstrapping'
  | 'ready'
  | 'archived'
  | 'merging'
  | 'conflicted'
  | 'cleanup_planned'
  | 'quiescing'
  | 'teardown'
  | 'quarantined'
  | 'unregistered'
  | 'deleting'
  | 'branch_cleanup'
  | 'cleaned'
  | 'blocked'
  | 'partial'
  | 'recovery_required'
  | 'failed'

type StepState = 'not_started' | 'running' | 'completed' | 'failed' | 'cancelled'
type RuntimeSessionState =
  'preparing' | 'ready' | 'active' | 'disconnected' | 'completed' | 'failed' | 'cancelled'
type HarnessRunState =
  | 'resolving'
  | 'starting'
  | 'working'
  | 'awaiting_input'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'disconnected'
  | 'unknown'
type TerminalState = 'creating' | 'running' | 'detached' | 'terminating' | 'exited'
type BrowserLaneState =
  | 'provisioning'
  | 'ready'
  | 'navigating'
  | 'suspended'
  | 'closing'
  | 'closed'
  | 'crashed'
  | 'recovering'
type DeviceSessionState =
  'discovering' | 'available' | 'starting' | 'attached' | 'suspended' | 'stopping' | 'stopped'
type CleanupJobState =
  | 'draft'
  | 'preflighted'
  | 'approved'
  | 'running'
  | 'quiescing'
  | 'teardown'
  | 'quarantined'
  | 'unregistered'
  | 'deleting'
  | 'branch_cleanup'
  | 'rolled_back'
  | 'completed'
  | 'blocked'
  | 'partial'
  | 'recovery_required'

type DevCapability =
  | 'dev.project.read'
  | 'dev.project.manage'
  | 'dev.repo.read'
  | 'dev.repo.manage'
  | 'dev.worktree.read'
  | 'dev.worktree.manage'
  | 'dev.terminal.attach'
  | 'dev.terminal.input'
  | 'dev.terminal.manage'
  | 'dev.session.read'
  | 'dev.session.manage'
  | 'dev.summary.read'
  | 'dev.files.read'
  | 'dev.files.write'
  | 'dev.git.read'
  | 'dev.git.write'
  | 'dev.browser.read'
  | 'dev.browser.control'
  | 'dev.browser.cookies'
  | 'dev.device.read'
  | 'dev.device.control'
  | 'dev.github.read'
  | 'dev.github.write'
  | 'dev.resources.configure'
  | 'dev.resources.read'
  | 'dev.resources.stop'
  | 'dev.resources.stopForeign'
  | 'dev.cleanup.approve'
  | 'dev.appearance.read'
  | 'dev.appLibrary.manage'

type Scope = {
  accountId: string
  workspaceId: string
  runtimeNodeId: string
}

// A local repository binding for one cloud project. `id` is the cloud
// project id the client supplies; names, order, and grouping belong to the
// cloud project record, never to the register.
type Project = {
  id: string
  scope: Scope
  repoIds: string[]
  repos?: ProjectRepoBinding[]
  preferredRuntimeNodeId?: string
  defaultBaseRef?: string
  bootstrapWorkflowId?: string
  defaultHarnessId?: string
  lifecycle: ProjectState
  version: number
}

type RedactedRemote = {
  provider: 'github' | 'gitlab' | 'other'
  host: string
  ownerPath: string
  displayUrl: string
}

// An import binds a repository to the bookmark that proves it; a remote-only
// project (`dev.project.clone`) binds a managed bare clone, which no user
// bookmark covers.
type ProjectRepoBinding =
  | { repoId: string; rootBookmarkId: string; canonicalRoot: string }
  | { repoId: string; canonicalRoot: string; layout: 'bare_managed' }

type Repo = {
  id: string
  scope: Scope
  kind: 'git' | 'folder'
  lifecycle: RepoState
  canonicalRoot: string
  // Absent for an ordinary checkout; `bare_managed` for a managed bare clone
  // (no primary working tree; its canonical root is also its git common dir).
  layout?: 'bare_managed'
  gitCommonDirIdentity?: FileIdentity
  remote?: RedactedRemote
  defaultRef?: string
  projectIds: string[]
  version: number
}

type Worktree = {
  id: string
  scope: Scope
  // primary = the repository's own checkout (ADR 0011); managed = created by
  // Adea; external = adopted after gitdir proof.
  kind: 'primary' | 'managed' | 'external'
  repoId: string
  projectId: string
  canonicalRoot: string
  rootIdentity: FileIdentity
  gitDirIdentity?: FileIdentity
  provenance: 'adea' | 'external'
  branchRef?: string
  title?: string // local display title; workspace private, never leaves the device
  taskId?: string // opaque cloud task id link
  baseRef?: string
  baseSha?: string
  headRef?: string
  headSha?: string
  lifecycle: WorktreeState
  bootstrap: StepState
  archived: boolean
  generation: number
  version: number
}

type RuntimeSession = {
  id: string
  scope: Scope
  projectId: string
  repoId: string
  worktreeId: string
  displayName?: string
  terminalId?: string
  taskId?: string
  agentProfileId?: string
  agentProfileVersion?: number
  harnessInstallationId?: string
  activeHarnessRunId?: string
  lifecycle: RuntimeSessionState
  archived: boolean
  projection: 'structured' | 'authenticated_hook' | 'terminal_fallback'
  generation: number
  version: number
}

type Lease = {
  id: string
  scope: Scope
  worktreeId: string
  ownerKind: 'terminal' | 'harness' | 'browser' | 'device' | 'server' | 'editor'
  ownerId: string
  generation: number
  state: 'active' | 'suspect' | 'expired' | 'released'
  acquiredAt: string
  heartbeatAt: string
  expiresAt?: string
}

type RuntimeEventKind =
  | 'session.created'
  | 'session.starting'
  | 'session.ready'
  | 'session.disconnected'
  | 'session.resumed'
  | 'session.completed'
  | 'session.failed'
  | 'session.cancelled'
  | 'run.created'
  | 'run.starting'
  | 'run.ready'
  | 'run.disconnected'
  | 'run.resumed'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'turn.user_input'
  | 'turn.assistant_delta'
  | 'turn.assistant_message'
  | 'turn.result'
  | 'tool.requested'
  | 'tool.started'
  | 'tool.progress'
  | 'tool.completed'
  | 'tool.failed'
  | 'approval.requested'
  | 'approval.resolved'
  | 'approval.expired'
  | 'question.requested'
  | 'question.resolved'
  | 'question.expired'
  | 'file.observed'
  | 'checkpoint.observed'
  | 'subagent.observed'
  | 'usage.observed'
  | 'terminal.command_started'
  | 'terminal.command_finished'
  | 'terminal.cwd_changed'
  | 'terminal.transcript_reference'
  | 'capability.degraded'
  | 'capability.restored'

type FileIdentity = {
  device?: string
  inode?: string
  birthtimeNs?: string
  mtimeNs: string
  size: string
  contentSha256?: string
}

// A RootBookmark is a durable grant that a directory or repository root has
// been authorized by the owner. The host mints bookmarks through
// `dev.project.authorizeRoot` (the add-project authorize dialog over the
// scope-bound channel; the roots authority records its own single-use
// issuance so no caller supplies an approval reference) and revokes them;
// every other slice only consumes the resulting grants.
type RootBookmark = {
  id: string
  scope: Scope
  label: string
  kind: 'directory' | 'repository'
  canonicalRoot: string
  rootIdentity: FileIdentity
  state: 'active' | 'stale' | 'revoked'
  generation: number
  version: number
}

// A CredentialRef identifies vault-held credential material without exposing
// it. The secret never enters a command body, reply, event, or log.
type CredentialRef = {
  id: string
  scope: Scope
  label: string
  host: string
  kind: 'git_https' | 'github_token' | 'ssh_key' | 'other'
  state: 'ready' | 'expired' | 'revoked' | 'unknown'
  version: number
}

// A ShellProfile is a named, host-admitted shell configuration offered to
// dev.terminal.create. Hosts mint builtin profiles; user profiles live under
// the runtime data directory.
type ShellProfile = {
  id: string
  scope: Scope
  label: string
  argv: string[]
  envAllowlistKeys: string[]
  builtin: boolean
  version: number
}

// A ProfilePolicy is a named lane-permission policy: which lane permissions
// (downloads, uploads, clipboard, camera, microphone, geolocation,
// notifications, popups, certificate exceptions) lanes created under it allow
// by default. Hosts mint policies; lanes record which one they used.
type ProfilePolicy = {
  id: string
  scope: Scope
  label: string
  allowedPermissions: string[]
  version: number
}

// A CleanupJobRecord summarizes one cleanup attempt for listing and
// rediscovery after a restart; the full CleanupPlan/CleanupResult records
// remain authoritative.
type CleanupJobRecord = {
  id: string
  scope: Scope
  worktreeId: string
  state: CleanupJobState
  createdAt: string
  observedAt: string
  generation: number
  version: number
}

type AgentProfileRef = {
  id: string
  version: number
  displayName: string
  capabilityPolicyVersion: number
}

type HarnessInstallation = {
  id: string
  scope: Scope
  executableIdentity: string
  executableLabel: string
  protocol: 'native' | 'acp' | 'pty'
  version?: string
  auth: 'ready' | 'required' | 'expired' | 'unknown'
  health: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  capabilities: string[]
  models: HarnessModel[]
  observedAt: string
  generation: number
}

type HarnessPreference = {
  scope: Scope
  harnessInstallationId: string
  enabled: boolean
  sortKey: string
  projectId?: string
  default: boolean
  agentProfileId?: string
  modelId?: string
  version: number
}

type HarnessRun = {
  id: string
  scope: Scope
  runtimeSessionId: string
  installationId: string
  agentProfile: AgentProfileRef
  modelId?: string
  /** Present when launched with the attachTerminal intent (#400). */
  terminalId?: string
  terminalGeneration?: number
  state: HarnessRunState
  generation: number
  startedAt?: string
  finishedAt?: string
  version: number
  /** Typed launch diagnostics, counts only (ADR 0012 memory preamble). */
  diagnostics?: Array<{
    code: 'memory_truncated'
    includedEntries: number
    omittedEntries: number
    limitBytes: number
  }>
}

type ProcessRecord = {
  id: string
  scope: Scope
  runtimeSessionId?: string
  worktreeId?: string
  ownerKind: 'terminal' | 'harness' | 'server' | 'browser' | 'device' | 'bootstrap' | 'git'
  ownerId: string
  pid: number
  startIdentity: string
  executableIdentity: string
  processGroupIdentity?: string
  generation: number
  state: 'starting' | 'running' | 'stopping' | 'exited' | 'unknown'
}

type ResourceIdentity = {
  kind: 'file' | 'repo' | 'process' | 'port' | 'sidecar' | 'browser_profile' | 'device'
  value: string
  observedAt: string
}

type PortRecord = {
  id: string
  scope: Scope
  protocol: 'tcp' | 'udp'
  host: string
  port: number
  owner: 'adea' | 'external' | 'unknown'
  processRecordId?: string
  runtimeSessionId?: string
  generation?: number
  // Present only when the host matched the service to a ready task-owned lane.
  preview?: {
    browserLaneId: string
    url: string
  }
  state: 'observed' | 'stale' | 'gone'
  observedAt: string
}

type TerminalRecord = {
  id: string
  scope: Scope
  runtimeSessionId: string
  worktreeId: string
  sidecarId: string
  processRecordId: string
  state: TerminalState
  health: 'healthy' | 'degraded' | 'replay_required' | 'faulted'
  lastSeq: string
  generation: number
}

type BrowserLane = {
  id: string
  scope: Scope
  runtimeSessionId: string
  kind: 'human_embedded' | 'task_owned' | 'user_context'
  profileId: string
  state: BrowserLaneState
  automationOwner: 'none' | 'agent' | 'human_takeover'
  generation: number
}

type DeviceSession = {
  id: string
  scope: Scope
  runtimeSessionId: string
  inventoryId: string
  kind: 'responsive' | 'ios_simulator' | 'android_emulator' | 'physical'
  state: DeviceSessionState
  processRecordId?: string
  generation: number
}

type HarnessModel = {
  id: string
  displayName: string
  capabilities: string[]
}

type CleanupBlocker = {
  code: DevErrorCode
  resourceId?: string
  message: string
}

type CleanupStepKind =
  | 'stop_owned_resource'
  | 'run_teardown'
  | 'quarantine_worktree'
  | 'unregister_worktree'
  | 'delete_quarantine'
  | 'delete_branch'
  | 'prune_retained_data'

type CleanupStep = {
  id: string
  kind: CleanupStepKind
  targetId: string
  expectedIdentity: string
  expectedGeneration?: number
  dependsOn: string[]
}

type CleanupStepResult = {
  stepId: string
  state: 'pending' | 'running' | 'completed' | 'blocked' | 'failed' | 'rolled_back'
  errorCode?: DevErrorCode
  observedAt: string
}

type CleanupRecovery = {
  action: 'resume' | 'restore_from_quarantine' | 'manual'
  nextStepId?: string
  instructions?: string
}

type CleanupPlan = {
  id: string
  cleanupJobId: string
  scope: Scope
  worktreeId: string
  worktreeGeneration: number
  factVersions: Record<string, string>
  blockers: CleanupBlocker[]
  selectedOwnedResourceIds: string[]
  steps: CleanupStep[]
  digest: string
  expiresAt: string
}

type CleanupResult = {
  cleanupJobId: string
  state: CleanupJobState
  stepResults: CleanupStepResult[]
  recovery?: CleanupRecovery
  observedAt: string
}

type PaneLease = {
  id: string
  scope: Scope
  runtimeSessionId: string
  paneId: string
  resource: { kind: 'terminal' | 'editor' | 'browser' | 'device'; id: string }
  resourceGeneration: number
  state: 'active' | 'suspect' | 'released'
  acquiredAt: string
  heartbeatAt: string
}

type ArchiveRecord = {
  id: string
  scope: Scope
  runtimeSessionId: string
  worktreeId: string
  state: 'archived' | 'restoring' | 'restored'
  archivedAt: string
  archivedBy: string
  reason?: string
  generation: number
  restoredAt?: string
}

type CleanupPolicy = {
  id: string
  scope: Scope
  projectId: string
  version: number
  state: 'draft' | 'approved' | 'disabled' | 'expired' | 'superseded'
  approvedBy?: string
  approvedAt?: string
  expiresAt?: string
  predicates: Array<
    | { kind: 'clean' }
    | { kind: 'pushed' }
    | { kind: 'pull_request_merged' }
    | { kind: 'no_active_leases' }
    | { kind: 'no_active_owned_resources' }
    | { kind: 'archived_for'; seconds: number }
  >
  allowedSteps: CleanupStepKind[]
}

type PaneLeaf = { kind: 'leaf'; id: string; pane: 'terminal' | 'editor'; resourceId?: string }
type PaneSplit = {
  kind: 'split'
  id: string
  direction: 'row' | 'column'
  ratio: number
  children: readonly [PaneNode, PaneNode]
}
type PaneNode = PaneLeaf | PaneSplit

type DevUtilityPane = 'files' | 'source_control' | 'browser' | 'devices' | 'agents' | 'history'
type DevUtilityPreference = {
  pane: DevUtilityPane
  side: 'left' | 'right'
  order: number
  visible: boolean
  size: number
  lastNonzeroSize: number
  fullWidth: boolean
}

// V1 is the foundation format merged by #447. It remains readable only so the
// client can migrate it without losing an unread value.
type DevLayoutPreferencesV1 = {
  schemaVersion: 1
  scope: Scope
  projectId: string
  runtimeSessionId: string
  center: PaneNode
  utility: Array<{
    pane: DevUtilityPane
    side: 'left' | 'right'
    visible: boolean
    size: number
    lastNonzeroSize: number
  }>
  focusMode: boolean
  focusTargetId?: string
}

// V2 is the first implementation-complete format. The six utility panes are
// present exactly once. At most one pane is visible per side; both sides may be
// visible simultaneously. No utility field confers runtime authority.
type DevLayoutPreferencesV2 = {
  schemaVersion: 2
  scope: Scope
  projectId: string
  runtimeSessionId: string
  center: PaneNode
  utility: readonly [
    DevUtilityPreference,
    DevUtilityPreference,
    DevUtilityPreference,
    DevUtilityPreference,
    DevUtilityPreference,
    DevUtilityPreference,
  ]
  focusMode: boolean
  focusTargetId?: string // MUST identify a leaf in center, never a split node
}

type TaskProjection = {
  taskId: string
  runtimeSessionId: string
  state:
    | 'queued'
    | 'running'
    | 'awaiting_input'
    | 'awaiting_approval'
    | 'completed'
    | 'failed'
    | 'cancelled'
  approvalIds: string[]
  observedAt: string
  version: number
}

type WorkspacePath = {
  worktreeId: string
  rootIdentity: FileIdentity
  relativePath: string // normalized slash-separated, no empty/. /.. /NUL/absolute prefix
}
type LeaseOwnerKind = Lease['ownerKind']
type RedactedRemoteInput = {
  provider: RedactedRemote['provider']
  host: string
  ownerPath: string
  repository: string
}
type ProjectMutableFields = Partial<
  Pick<
    Project,
    'preferredRuntimeNodeId' | 'defaultBaseRef' | 'bootstrapWorkflowId' | 'defaultHarnessId'
  >
>
type CapabilitySnapshot = {
  scope: Scope
  granted: DevCapability[]
  unavailable: Array<{ capability: DevCapability; reason: DevErrorCode }>
  channelGeneration: number
  observedAt: string
}
type MutationPlan = {
  id: string
  operation: DevOperation
  scope: Scope
  resource: { kind: string; id: string; generation: number }
  factVersions: Record<string, string>
  steps: Array<{ id: string; kind: string; targetId: string; dependsOn: string[] }>
  blockers: CleanupBlocker[]
  requiredApprovalIds: string[]
  digest: string
  expiresAt: string
}
type ProjectScanPage = {
  items: Project[]
  nextCursor?: string
  fingerprint: string
  truncated: boolean
  observedAt: string
}
type RepoInspection = {
  repo: Repo
  rootIdentity: FileIdentity
  headRef?: string
  headSha?: string
  dirty: boolean
  observedAt: string
}
type WorktreeOperation = {
  operationId: string
  worktree: Worktree
  step: string
  state: StepState
  nextRetryAt?: string
}

type FileEntry = {
  path: WorkspacePath
  identity: FileIdentity
  kind: 'file' | 'directory' | 'symlink' | 'special'
  size: string
  observedAt: string
}
type FileReadResult = {
  entry: FileEntry
  offset: string
  bytes: Uint8Array
  eof: boolean
  eol: 'lf' | 'crlf' | 'mixed' | 'none'
  encoding: 'utf8' | 'binary'
}
type FileWriteResult = { entry: FileEntry; previousIdentity: FileIdentity; atomic: true }
type FileMutationResult = { path: WorkspacePath; previousIdentity: FileIdentity; state: 'deleted' }
type SearchMatch = {
  path: WorkspacePath
  identity: FileIdentity
  line: number
  column: number
  preview: string
  ranges: Array<{ start: number; end: number }>
}
type ExternalOpenResult = { accepted: true; path: WorkspacePath; applicationLabel?: string }

type GitStatus = {
  worktreeId: string
  headRef?: string
  headSha?: string
  indexSha: string
  entries: Array<{ path: WorkspacePath; staged: string; unstaged: string; untracked: boolean }>
  observedAt: string
}
type GitCommit = {
  sha: string
  parents: string[]
  authorName: string
  authoredAt: string
  subject: string
  body?: string
}
type DiffHunk = {
  path: WorkspacePath
  oldPath?: WorkspacePath
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: Array<{ kind: 'context' | 'add' | 'delete'; text: string }>
}
type GitFetchResult = {
  remoteName: string
  before: Record<string, string>
  after: Record<string, string>
  observedAt: string
}
type GitCheckpoint = {
  id: string
  worktreeId: string
  baseSha?: string
  treeSha: string
  createdAt: string
  label?: string
}
type GitPushResult = {
  remoteName: string
  ref: string
  beforeSha?: string
  afterSha: string
  forcedWithLease: boolean
}

type BrowserTarget = {
  id: string
  browserLaneId: string
  type: 'page' | 'frame' | 'worker'
  url: string
  title: string
  generation: number
}
type BrowserNavigation = {
  browserLaneId: string
  targetId: string
  finalUrl: string
  status?: number
  generation: number
  observedAt: string
}
type BrowserAnnotationInput = {
  targetId: string
  kind: 'point' | 'rect' | 'text'
  x: number
  y: number
  width?: number
  height?: number
  text?: string
}
type BrowserAnnotation = BrowserAnnotationInput & {
  id: string
  screenshotId: string
  createdAt: string
}
type BrowserInspection = {
  targetId: string
  nodeId?: string
  role?: string
  name?: string
  bounds?: { x: number; y: number; width: number; height: number }
  observedAt: string
}
type BrowserDiagnostic = {
  id: string
  level: 'info' | 'warning' | 'error'
  category: 'console' | 'network' | 'crash' | 'policy'
  message: string
  observedAt: string
}
type ScreenshotRef = {
  id: string
  scope: Scope
  ownerId: string
  laneKind: 'human_embedded' | 'task_owned' | 'user_context' | 'device'
  profileId?: string
  origin: string
  viewport: { width: number; height: number; deviceScaleFactor: number }
  redacted: boolean
  contentType: 'image/png' | 'image/jpeg' | 'image/webp'
  byteLength: string
  width: number
  height: number
  sha256: string
  expiresAt: string
}
type CookieImportResult = {
  browserLaneId: string
  imported: number
  skipped: number
  rolledBack: boolean
  observedAt: string
}
type DeviceInventoryItem = {
  id: string
  kind: DeviceSession['kind']
  name: string
  platform: string
  state: 'available' | 'busy' | 'offline' | 'unauthorized'
  generation: number
  observedAt: string
}
type DevicePlatformCapability = {
  platform: 'ios' | 'android'
  state: 'available' | 'unavailable'
  missingPiece?: 'xcrun_simctl' | 'adb' | 'android_emulator'
  observedAt: string
}
type DeviceCapabilityReport = {
  items: DevicePlatformCapability[] // exactly one row for each platform
  observedAt: string
}

type GitHubAccount = {
  id: string
  host: string
  login: string
  scopes: string[]
  observedAt: string
}
type GitHubRepository = {
  id: string
  repoId: string
  host: string
  owner: string
  name: string
  defaultBranch: string
  permissions: string[]
  generation: number
  observedAt: string
}
type GitHubIssue = {
  id: string
  number: number
  title: string
  state: 'open' | 'closed'
  url: string
  labels: string[]
  milestoneId?: string
  generation: number
  updatedAt: string
}
type GitHubMilestone = {
  id: string
  number: number
  title: string
  state: 'open' | 'closed'
  dueAt?: string
  generation: number
  updatedAt: string
}
type GitHubCheck = {
  id: string
  name: string
  state: 'queued' | 'running' | 'success' | 'failure' | 'cancelled' | 'neutral'
  url?: string
  generation: number
  updatedAt: string
}
type GitHubPullRequestMutableFields = Partial<{
  title: string
  body: string
  draft: boolean
  baseRef: string
}>
type GitHubPullRequest = {
  id: string
  number: number
  repoId: string
  title: string
  body: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  headRef: string
  headSha: string
  baseRef: string
  mergeable: 'yes' | 'no' | 'unknown'
  url: string
  generation: number
  updatedAt: string
}

type ResourceMetric = {
  ownerId: string
  cpuPercent?: number
  residentBytes?: string
  readBytes?: string
  writeBytes?: string
  observedAt: string
  confidence: 'authoritative' | 'measured' | 'estimated'
  processRecordId?: string
  runtimeSessionId?: string
  worktreeId?: string
  generation?: number
}
type UsageRecord = {
  id: string
  ownerId: string
  provider: string
  quantity: string
  unit: string
  costMicros?: string
  source: 'official_api' | 'harness_protocol' | 'local_transcript_estimate'
  confidence: 'authoritative' | 'measured' | 'estimated'
  observedAt: string
  accountLabel?: string
  period?: { from: string; to: string }
  remaining?: string
  capturedAt?: string
  expiresAt?: string
  failure?: { code: DevErrorCode; message: string }
}
type RetainedDataRecord = {
  id: string
  ownerId: string
  kind: 'terminal' | 'checkpoint' | 'screenshot' | 'browser_profile' | 'log' | 'dependency_template'
  byteLength: string
  protected: boolean
  expiresAt?: string
  observedAt: string
  scope?: Scope
  label?: string
}
type ResourceSnapshot = {
  processes: ProcessRecord[]
  ports: PortRecord[]
  metrics: ResourceMetric[]
  retainedData: RetainedDataRecord[]
  // Present only under the `machine` resource coverage; see
  // "Machine-wide inventory and foreign stop".
  foreign?: ForeignProcessRecord[] // at most 512
  machine?: MachineResourceSummary
  observedAt: string
}
// A process Adea did not launch. Never carries a ProcessRecord id and never
// rides the Adea-owned stop path.
type ForeignProcessRecord = {
  id: string // host-derived from PID + start identity + executable identity
  observationGeneration: number // the pull that first observed this identity
  pid: number
  startIdentity: string
  executableIdentity: string
  label: string // executable basename, bounded
  commandPreview?: string // redacted, at most 160 characters
  cwdLabel?: string // home-relative, bounded
  worktreeId?: string // registered worktree whose root contains the cwd
  attribution:
    | { kind: 'harness'; harness: string } // a recognized harness ancestor
    | { kind: 'automation'; label: string } // automation flags or app name
    | { kind: 'adea_terminal' } // below a shell inside an Adea terminal
    | { kind: 'unknown' }
  listeningPorts: number[] // loopback/wildcard listeners only, at most 64
  childCount: number
  residentBytes?: string // process tree, decimal string; absent when unknown
  cpuPercent?: number // absent on the first observation
  residentHistory: string[] // at most 30 points over the last 10 minutes
  protection: 'none' | 'protected_list' | 'system' | 'other_user'
  stoppable: boolean // true only when protection is 'none' and owner is the Adea user
  observedAt: string
}
type MachineResourceSummary = {
  memoryTotalBytes?: string
  memoryUsedBytes?: string
  cpuPercent?: number
  diskFreeBytes?: string
  diskTotalBytes?: string
  observedAt: string
}
type ForeignStopResult = {
  foreignProcessId: string
  outcome: 'stopped' | 'forced' | 'already_gone' | 'still_running'
  signalledPids: number[] // children first
  observedAt: string
}
type WorktreeStorageRecord = {
  worktreeId: string
  sourceBytes?: string // outside dependency and build roots
  buildBytes?: string // dependency and build output roots
  state: 'measured' | 'measuring' | 'stale' | 'unreadable'
  measuredAt?: string
}
// `scope` is a reserved authority field, so the setting is named `coverage`.
type ResourcePreferencesInput = {
  coverage: 'adea' | 'machine'
  includeAutomationApps: boolean
  recognizedHarnesses: string[] // names of shipped matchers, at most 32
  portRange: { from: number; to: number }
  alerts: {
    residentBytesAbove: string
    growthBytes: string
    growthWindowSeconds: number
    notify: 'badge' | 'badge_and_notification' // stored; not yet acted on
    snoozeSeconds: number // stored; not yet acted on
  }
  cleanup: {
    mode: 'off' | 'ask' | 'automatic' // 'automatic' is not offered yet
    serverIdleSeconds: number
    suggestMergedWorktreesAfterSeconds: number // stored; not yet acted on
    quarantineRetentionSeconds: number // stored; not yet acted on
    retainedDataRetentionSeconds: number // stored; not yet acted on
  }
  protectedExecutables: string[] // basenames or `prefix*`, no `/`, at most 32
  sampling: { visibleSeconds: number; backgroundSeconds: number }
}
type ResourcePreferences = ResourcePreferencesInput & {
  version: number // optimistic-concurrency revision
  updatedAt: string
}
type CleanupPredicate = CleanupPolicy['predicates'][number]
type CleanupPolicyEvaluation = {
  policyId: string
  worktreeId: string
  matched: boolean
  facts: Record<string, string>
  blockers: CleanupBlocker[]
  evaluatedAt: string
  executesNothing: true
}
type TerminalCheckpoint = {
  id: string
  terminalId: string
  generation: number
  throughSequence: string
  segmentSha256: string
  byteLength: string
  createdAt: string
}
type TerminalSearchMatch = {
  terminalId: string
  generation: number
  sequence: string
  byteOffset: string
  preview: string
}
```

`AgentProfileRef` refers to the M11-owned immutable AgentProfile version; M12
MUST NOT duplicate its body, approval policy, or credential record. Likewise,
M10 remains authoritative for installation discovery and process admission;
these DTOs are scoped projections required for Dev View and do not transfer
ownership.

Integer byte counts and all unbounded offsets, lengths, and sequence numbers
use canonical unsigned decimal strings on the wire. Numeric values
are allowed only when the registry gives them an explicit safe upper bound.
Timestamps are UTC ISO-8601. Paths use host-native form only inside authorized
host DTOs; remote clients receive policy-redacted labels unless granted path
detail.

## State machines

Unknown stored states are never coerced to success. Decoders return
`unsupported_version` or `corrupt_state` and retain the unread record for
export/recovery.

Project and repository records follow:

```text
project: importing|cloning|scanning → ready ↔ archived; any setup step → failed
repo:    authorizing → ready ↔ unavailable; ready → stale → refreshing → ready
```

A project setup transaction persists its current stage and retry metadata. A
repository becoming unavailable never deletes its project/worktree/session
records. Reauthorization must prove the same canonical identity or create a new
repo record; it cannot retarget an existing ID.

Lease, process, port, and pane ownership follow:

```text
lease:      active → suspect → active|released|reconciled
pane lease: active → suspect → active|released
process:    starting → running → stopping → exited; any observation may → unknown
port:       observed → stale → observed|gone
pane:       mounted ↔ hidden ↔ full_width; mounted → closed → restored
archive:    archived → restoring → restored
```

Lease expiry/suspect, process `unknown`, and port `stale` grant no destructive
authority. Pane state is ephemeral and never alters resource ownership. Closing
a pane records its leaf in a window-local reopen stack; reopening restores that
pane's layout and binding while the stack exists. This stack is not persisted,
and reopening after a reload or session change is not promised. Closing or
reopening a terminal pane only disposes or recreates its local renderer and
stream attachment. It does not stop, archive, or recreate the native terminal
or runtime session; a reopened pane may attach to the same selected live
terminal and replay whatever history the runtime retains. Closing a terminal
process is a separate privileged command. The center layout is a strict binary
tree with a hard M12 cap of 8 leaves and depth 8; split/duplicate refuses with `limit_exceeded`
when either cap would be exceeded. Ratios are finite and clamp to `[0.1, 0.9]`.
Leaf IDs are unique, utility panes do not count as center leaves, and closing the
last leaf restores one terminal placeholder. The center model and stable ID-keyed
renderer are consumed from the published `@adea-ai/ui` split-layout entries.
A fresh session starts with one terminal leaf. Selecting a file creates an
editor beside the focused pane when no editor exists, and later files reuse
that editor. Explicit splitting retains the focused pane's kind and an editor's
file target. The toolbar's automatic split adopts the shared balanced reflow
(`splitPaneBalanced`): the new pane joins the focused pane in reading order
while the center rebuilds as a balanced row-major grid — one row up to two
panes, then two rows of at most four — recomputing ratios and recycling split
IDs across rebuilt branches. Adding a pane can therefore redistribute existing
pane widths, and resize actions resolve against the current tree. A new terminal
leaf receives a new owner and does not inherit a live
terminal resource binding; opening its process still requires the runtime's
normal authority. Saved split layouts — including band-shaped layouts stored by
earlier builds — restore unchanged; the initial view does
not reserve an empty editor pane.
Adea injects terminal/editor leaf payloads, the final terminal placeholder,
scoped preference decoding/storage, keyboard move commands, and 5% resize
snapping. Shared UI owns constrained separators, internal pane drag payloads,
the balanced automatic reflow, owner cleanup, and close focus return. Splitting,
moving, or resizing surviving
leaves must preserve their terminal/editor DOM owners and local interaction
state; none of these visual transitions grants runtime authority.
The central renderer loads through its own boundary while the sidebar,
selection, and layout preference model remain mounted in the shell. Delayed
loading must leave session selection usable and preserve that selection when
the panes appear; the loading boundary must not reset surviving pane owners.
The web client groups only seven shared navigation glyph modules to avoid
tiny individual requests. Feature components and heavy dependencies retain
their automatic lazy boundaries. The unchanged Dev byte limit applies to the
entry and immediately mounted central renderer together; splitting that
implementation into multiple chunks does not expand its allowance.
Utility slots are independent:
left and right may each show one pane or be collapsed, and a change on one side
cannot hide the other side. Utility order, side, visibility, size, collapse,
and full-width state are local preferences only. A persisted focus target must
identify a center leaf; a split-node target is corrupt and falls back to the
first valid leaf.

The workspace shell owns one scoped V2 layout controller and utility-selection
state across Dev, Chat, and Virtual. The Dev entry consumes that owner and
remains the only mount for the Dev center, projection, capability snapshot,
and session selection. Chat and Virtual mount a lazy right
utility host on first open; it reuses the Browser, Devices, Agents, and History
panes without mounting a second Dev entry or creating another layout writer.
The shared archive-shelf owner serves the Dev footer and the existing shared
workspace navigation footers in Chat and Virtual. Desktop Chat's direct
project/session sidebar uses that same owner and shelf. These surfaces continue
to use the published shared navigation and its existing domain renderers for
general project, room, and session navigation.

Archive command construction, pagination, and response validation load on demand;
the shell owner retains shelf state, request revisions, and context fences.
A pending load MUST capture existing authority before runtime readiness or code
loading and revalidate it before dispatch, so a scope or view roundtrip cannot
revive an old operation. Reactive scope transitions advance a synchronous,
monotonic owner revision, including transitions with no intervening pane read.
The first scope published by readiness is accepted only if there was no owner
view/binding transition and no additional scope transition. An unchanged scope
may move from unavailable to ready without being treated as a new authority.
The archive shelf reads pages of up to 500 sessions and follows cursors for at
most 20 pages. Every row on every page MUST be archived and match the active
runtime scope. A malformed row, a mismatched scope, an invalid or repeated
cursor, or reaching the page cap with another cursor MUST report an incomplete
load; it MUST NOT present the partial rows as a complete listing. A restore
must find the selected row in that scope's current shelf, retain its listed
generation, read the exact RuntimeSession with that generation and a nonempty
worktree binding, and unarchive with the same expected generation. List, get, and unarchive results are fenced
by the active view and runtime scope; switching views or changing scope while
an operation is pending MUST discard its result. The same shelf state and
restore path back each Chat, Virtual, and Dev footer; room and channel IDs
never supply a session identity for archive operations.

Session identity is explicit and view-local. Dev publishes only the current
projection-validated selection. Desktop Chat publishes
`conversation.runtimeSessionId` only after the selected canonical conversation
has attached and its scope, project, session, and generation match the
projection. A desktop presentation hint is not runtime authority. Virtual
room, channel, and route IDs MUST NOT be converted into or used as a fallback
for a RuntimeSession ID. Without an authoritative binding, Devices MAY read
runtime-scope inventory and capability state, while Browser lanes, device
sessions and mutations, Activity, Agents, and History MUST report their
session-bound surface unavailable and MUST NOT issue session-bound commands.

Every contextual runtime read or action captures the active view, runtime
scope, project, RuntimeSession ID, generation, worktree, and runtime status
before dispatch. It MUST discard a result or follow-up action when that
identity changes or its host is disposed. Returned session resources MUST
match both scope and RuntimeSession ID before rendering or mutation. A view
switch invalidates pending work even when the user later returns to the same
session. Sessionless utility visibility may be changed in Chat or Virtual, but
it is not written to a session document until a canonical binding exists; an
open right utility may then carry forward into that session's V2 document.

The shell utility owner advances a durable context epoch synchronously on view and canonical binding transitions. Returning to the same view or session does not revive a request fence captured before an intervening transition, even when no pane reads the intermediate context. Repeated publication of the unchanged canonical binding does not invalidate active work.

Utility icon actions use the shared `ActionButton` with accessible names and explanatory
tooltips. Resources refresh stays disabled until the runtime is ready and explains the
connection requirement in its tooltip. File rename and copy use shared ghost icon
actions; pending tree copy uses the same confirmation label in its tooltip and accessible
name. Labelled delete and overwrite confirmations use the shared destructive button
variant. These presentation controls retain the existing runtime fences and plan/commit
authority; a tooltip or visual variant does not authorize an operation.

The shared utility owner and Dev center import structural pane preferences without loading
pane icon components. Side and title lookups use the data-only pane catalogue; icon projection
belongs to the utility host. Scoped layout storage, decoding, and migration load on
demand after a canonical session binding exists. Utility defaults and user
edits remain synchronous while that code loads. Pending utility or center/focus
edits merge over the saved document by pane and field; loading MUST preserve
saved fields the user did not change. Explicit actions retain their intent even
when the requested value matches the default before hydration. Each load belongs
to its captured scope, project, and session.
Changing identity or disposing the owner MUST prevent a late load from publishing
into the current view; pending edits flush only to their captured storage key.
A pending edit is also journaled under its captured V2 storage key with a
`pending-patch.v1` suffix and an owner-specific sequence/nonce. Recovery validates
the complete document and exact identity through the V2 decoder, then applies
only the allowlisted fields recorded as changed. A journal is removed only after
a successful V2 write and an exact raw-value match; failed writes remain
retryable. Invalid or future journal envelopes remain available for recovery
without being applied. Storage adapters provide the CRUD methods and key
enumeration used to recover these journals.
A failed load retains those edits and exposes an unavailable state with an
explicit retry in the shared utility sidebar. If the storage backend also rejects
the initial journal write, edits remain in the live owner but cannot be guaranteed
after disposal until a write succeeds. Successful hydration publishes preferences,
load state, and revision together for the active identity, with listener cleanup
already registered; synchronous observers that switch or dispose the owner MUST
NOT permit stale publication or leave a visibility listener attached. Hydration
advances the layout revision once for the active identity. Scoped persistence imports the published read-only
split-layout tree entry for limits and traversal, keeping pane-editing code
behind the Dev entry's boundary. Client bundle attribution includes lazy pane imports
from shared utility hosts under the Dev shell, excluding unrelated startup
routes; moving a pane into the common host cannot hide its download cost.

### Worktree

```text
discovered → authorizing → creating → bootstrapping → ready
     │             │           │             │          ├→ archived ↔ ready
     │             │           │             │          ├→ merging → ready|conflicted
     │             │           │             │          └→ cleanup_planned
     └─────────────┴───────────┴─────────────┴→ failed (retry from durable step)
cleanup_planned → quiescing → teardown → quarantined → unregistered
  → deleting → branch_cleanup → cleaned
any cleanup state → blocked|partial|recovery_required
```

`external` worktrees cannot transition to managed deletion unless the user runs
a distinct adoption operation that proves repository, gitdir, path identity,
and ownership. Archive does not stop or delete anything. A `primary` worktree
record (the repository's own checkout) stays `ready` for as long as the
repository is registered: it never enters `archived`, `merging`, or any
cleanup state (see "The primary checkout record").

### Terminal

```text
creating → running ↔ detached → exited
                     └→ terminating → exited
```

Orthogonal health: `healthy | degraded | replay_required | faulted`.
Detaching a window/client does not terminate the PTY. A user terminate command
acts on the recorded process group/session after identity revalidation.

A session may own several terminals through splits.
`RuntimeSession.terminalId` names only the session's primary terminal;
`dev.terminal.list` enumerates every terminal a session or worktree owns,
including split leaves and terminals re-created after a restart.

The desktop workspace projection preserves the session's optional primary
`terminalId` and canonical session generation. A terminal pane resolves its
explicit primary or split-leaf terminal ID through `dev.terminal.list`, filtered
by the selected session and worktree. It requires exactly one matching record
with the same account/workspace/node scope, session, and worktree; it never
selects the first unrelated terminal or creates a PTY as recovery. Session
and terminal generations are separate identities: stream grants use the resolved
terminal record's generation. Resolution scans at most 64 pages of 500 records,
rejects duplicate IDs, off-scope/session/worktree rows, repeated cursors,
oversized pages, ended/faulted terminals,
and retires pending results when the selection's abort signal is cancelled.
The production `DevWorkspaceEntry` mounts this resolver through the lazy
`RuntimeTerminalPane`, after the current scope's attach and input capabilities
are verified. Explicit split-leaf bindings take priority; only the first
unbound terminal leaf may use the session's projected primary terminal. Stable
identity prevents focus and ratio changes from reattaching the stream. Failed
resolution exposes a retry that repeats lookup without creating a terminal.
Mounted entry tests qualify that composition; packaged native stream delivery
remains a separate acceptance lane.

The renderer's terminal connection adapter captures an exact `TerminalRecord`,
never the first item returned by a session query. Each attach mints distinct
read and input grants with matching scope, terminal identity and generation;
both authenticated stream headers must arrive before output is presented.
Read streams send ACKs and accept host heartbeats; input byte offsets are owned
by the adapter and continue only within the same terminal generation. Reconnect
revalidates the captured terminal across the session-filtered terminal pages,
with at most 64 pages of 500 records. A larger page or continuing cursor after
that bound fails closed with `limit_exceeded` before stream grants are minted.
Closing or replacing its socket retires that attempt: a late page reply cannot
request another page or mint grants, and late frames cannot reach the new pane.

### Runtime session and harness run

```text
session: preparing → ready → active ↔ disconnected → completed|failed|cancelled
run:     resolving → starting → working ↔ awaiting_input|awaiting_approval
         → completed|failed|cancelled|disconnected|unknown
```

`stale` is metadata with `source` and `observedAt`, not a replacement success
state. Resume creates a new `HarnessRun` generation under the same compatible
`RuntimeSession`; it does not silently reuse stale write authority.

`dev.session.archive` and `dev.session.unarchive` produce the `ArchiveRecord`
that drives `archived → restoring → restored` and set/clear
`RuntimeSession.archived`. Session archive is navigation/history metadata: it
removes the session from the active list, never stops a terminal, harness,
browser, device, or process, and never deletes worktree data. Worktree archive
(`dev.worktree.archive`) remains a separate decision.

### Dev provider and canonical session projection

The Dev UI consumes an authorized typed projection, not a fixture-shaped copy of
runtime data. A provider projection MUST include the active `Scope`, its source
and freshness/generation metadata, and the project bindings, repositories,
worktrees, and `RuntimeSession` records returned by the corresponding registry
operations. The provider may expose loading, stale, offline, unavailable, and
partial states, but it MUST NOT turn any of them into fabricated success data.
The project projection is flat: one entry per register binding, in register
order, keyed by the cloud project id with its repository ids, default base ref,
version, and sessions. No binding is dropped for lacking a parent. The register
carries no project names; hosts inject display names keyed by cloud project id
(`projectNames`), and a binding without a supplied name renders the short form
of its project id (the first UUID group).

The following invariants are mandatory:

1. `selectedRuntimeSessionId` MUST resolve to a session in the selected project,
   workspace, account, and runtime node. An archived, revoked, missing, or
   generation-mismatched selection is cleared or rendered as an explicit
   recovery state.
2. Dev and Chat MUST subscribe to the same `runtimeSessionId` and authoritative
   session query/event cursor. A route or pane change cannot create, stop,
   resume, duplicate, or implicitly transfer a run.
3. Input ownership is changed only by the authorized `dev.session.transferInput`
   operation. Renderer focus is a presentation hint, not ownership proof.
4. The provider MUST expose the authenticated preference scope separately from
   runtime records. Until that scope exists, Dev may render unavailable state
   and pure local fixtures in development/E2E only, but MUST NOT persist a
   production layout under a guessed or synthetic scope.
5. Changing workspace or runtime node cancels in-flight private queries before
   removing the old scope's cache. No projection, selection, path label, or
   preference from the old node may be used for the new node.

The M13 Chat model projects the canonical session and project registry
pages. It resolves those registries before creating or attaching a visible
conversation, and a complete unfiltered session refresh removes records absent
from the canonical list. A missing project must remain unresolved; Chat must
not synthesize a project to make a session appear. A projected event window
without an authoritative retention cursor cannot claim its full history was
loaded. `dev.session.create` records the scoped, hashed idempotency key, body
fingerprint, and canonical session ID in the same durable authority snapshot
as the new session. Within the seven-day result window, a matching retry
returns that session after a process restart; a changed body refuses with
`idempotency_conflict`. Chat's `runtime-events-v1` consumer returns read credit
only after accepting a frame. Replay delivered during stream attach queues
the acknowledgement until the socket is available; a decode error, sequence
gap, conflict, or stale generation never acknowledges the rejected frame.
The Chat surface closes its transcript stream when the selected session or
generation changes or the view unmounts. A late stream-open response must close
its own handle without installing a poller or replacing the newer session's
transcript; session-local answer state resets on selection. Composer drafts are
owned by the current authenticated scope's desktop Chat host: a Chat remount
and a new generation under the same `runtimeSessionId` reuse that draft, while
a workspace, account, or runtime-node change replaces the host. An async send
may clear a draft only when its session, generation, and host draft revision
still match; late success from an old composer is ignored, and a failed send
leaves the draft intact. The explicit host callback and the Chat model fallback
use the same session, generation, and revision fence.
Send, Steer and Stop are available only when the host supplies their authorized
operation (or the model supplies send/cancel). Missing handlers cannot clear a
draft or report delivery; unsupported Steer remains disabled with a visible
reason. Authority, connectivity and approval gates apply to Stop as well.
The runtime composer mounts the published `@adea-ai/ui` AtomicChatComposer.
Adea's scoped desktop Chat host owns one in-memory `{ text, blocks }` draft per
canonical session; the shared editor reports both fields in one synchronous
change. Paste block IDs are allocated by the current model only for its current
session generation. Before Chat's existing text-only `chat_user` transport,
the host expands every backed paste marker to its original text, rejects an
unresolved marker, and applies the existing 65,536-character prompt limit to
the expanded value. The block sidecar is never added to a runtime command,
event, local storage record, or new persistence authority. Same-session
remounts and resume preserve the in-memory pair; failure, stale identity, or a
newer revision cannot clear it. Async delivery captures the expanded text and
paired blocks before awaiting and clears only the still-current matching draft.
Shared UI owns input, IME handling, pending presentation, paste editing and
action-row composition. Agent/profile, Auto/Customize pins, resolved location
and authorized Stop/Steer/launch controls are host slots. This host has no
queue operation, so it does not advertise one.
Desktop Chat retains a bounded presentation-only reading-position snapshot per
session and generation in the active authenticated model host. Scope replacement
clears these snapshots and rejects late writes from the previous scope. A
snapshot records the scroll offset and whether the reader was following live
output; it does not create another transcript or session authority.
Inline approval/question and terminal-jump controls use published shared Button
and Input primitives; runtime event projection and authorized response callbacks
remain application-owned.
The mounted transcript uses the published shared ConversationSurface to restore
that snapshot and report native scrolling and cleanup through the host callback,
carrying the immutable mounted session identity. Shared follow intent stops on
upward reader movement even inside the jump-control visibility threshold; new
events preserve the parked offset until the reader explicitly resumes following.
The jump control returns to the latest event and focuses the native transcript.
During append-only streaming, existing transcript row DOM nodes stay mounted so
the live region adds only the new row instead of replaying prior announcements.
The published shared TranscriptComposition owns keyed row rendering, with the
canonical session/generation as its explicit reset scope. The host clears local
question answers on scope reset and retains response-authority checks. Current
opaque runtime payloads provide no validated call phase, interaction eligibility,
synthesis or final-answer boundary; rows therefore stay visible and unfolded.
Payload hints and run completion cannot authorize grouping or hide an action.

Adea's persisted appearance IDs are the complete published `@adea-ai/themes`
0.8.1 catalogue. Every editor projection clears the host's 4.5:1 syntax floor;
the generator refuses unexpected exclusions and records the package's actual
version. A removed or unknown stored ID resolves to the appearance default
without deleting the stored preference.
Solid destructive actions carry a separate generated fill/foreground pair from
`shadcnDestructiveProjection`; theme switching and the pre-paint provider apply
and clear those tokens with the rest of the palette. Canonical status hues,
terminal ANSI colors, and editor roles retain their published projections.

### Desktop Chat presentation notifications

The canonical `test:e2e` gate includes returning-session and first-run Chat
component journeys. Returning-session coverage observes the actual component
through a synthetic bridge and verifies presentation clearing while attaching
and on disposal; this is separate from native notification delivery.

The desktop shell derives notification intents from the canonical
`RunHistoryStore.list()` snapshot. It seeds a baseline after host composition
and compares snapshots only after the harness has durably recorded a
`run.status` transition, published as `dev.harness.updated` with
`kind: 'run.status'`. The store targets 200 retained records by dropping old
terminal runs; active runs are never evicted, so this is not a hard snapshot
size ceiling. The notification path owns no second run index or event watcher. It advances
the baseline even when focus suppresses a request or the native request fails,
so a transition is never replayed later as a new alert.

Only the mounted desktop Chat host may report its canonical conversation
session, and the Dev surface may report its currently selected canonical
session. Conventional workspace/team Chat does not imply a RuntimeSession. The
shell validates either presentation hint against the current scoped,
non-archived session projection. Window focus comes from the native window's
focus/blur events. These signals suppress presentation only: selection and
focus never grant command or input authority, and the notification path leaves
`authoritySessionId` unset until a separately typed input-owner projection
exists.

The native boundary receives only the fixed title `Adea` and body
`A conversation needs your attention.` Run IDs, session IDs, display names,
prompts, tool output, and paths never reach the OS notification request. A
successful `Utils.showNotification` call returns no delivery receipt, so the
shell records only that the API call returned. An absent or throwing API is a
silent typed unavailable outcome. This lane does not probe notification
permission or claim OS delivery.

Chat attaches an existing session by walking the legal paged
`dev.session.list` body and its opaque cursors; the list body has no
`runtimeSessionId` filter. Since the host may start a bounded replay at the
newest retained frame, it emits a `resync` frame with
`reason: 'checkpoint_required'` and the actual retained floor before replaying
data. Chat accepts the first data frame only at that disclosed checkpoint; a
data frame that jumps past the requested cursor without the checkpoint, or a
later sequence jump, requires resync and is never acknowledged. Remembered
events are admitted only for their canonical runtime session and are capped at
the global 1,000-event retention bound using generation-aware ordering, with the
newest generation preserved when sequence numbers restart. The client keeps
create request fingerprints/results only through the same seven-day replay
window as the host authority, including pending requests. After that window a
same-key retry may safely replay the host's durable create; only the current
request may update the projection or continue to launch, so a late response
from an expired request cannot overwrite newer session state or duplicate the
run side effect. Expired initial prompts therefore cannot remain in an
unbounded cache.
If a Chat create request loses its transport response, the client retains the
key/body fingerprint but clears its rejected in-flight promise. Retrying the
same request then reaches the host's durable result replay; reusing the key for
a changed body still refuses before dispatch.
M13 first-run onboarding consumes identity and model-access facts from the
owning desktop composition. Identity never gates the conversation: a guest and
a signed-in owner traverse the same stages, because the desktop's model path
is the user's own harness under BYOK (the default model-access decision) —
onboarding projects `byok` for both and never shows a sign-in wall to start a
conversation. Onboarding never invents cloud-provided model access or displays
a raw credential field; a typed `none` projection still carries one safe
recovery action, and a future CP-provisioned entitlement (#552's client-facing
projection) is additive — it may grant cloud models, never a gate. Managed-Pi install state is a
separate visible status while identity is resolving. Typed driver errors map to
one safe action (retry the install or update the app), and raw diagnostic
details do not render. An unresolved project or AgentProfile remains a visible
setup gate rather than a fabricated default. Once ready, onboarding creates a
canonical Chat conversation with the initial prompt and a stable idempotency
key across transport retries. It sends no harness or model pin, leaving the
root-default policy and the existing staged launch transaction authoritative.
The adapter exposes `dev.harness.preferenceReset` for explicit reset-to-
discovered; the host's effective projection then returns managed Pi first.
The initial UI projection and adapter are implemented in
`packages/dev-view/src/chat/onboarding/`. The desktop Chat entry mounts that
surface only after the authenticated runtime projection, ready worktree list,
and workspace `AgentProfile` list resolve from their owning authorities;
missing records leave the existing Chat surface in place and never create a
synthetic launch context. Returning desktop Chat instead attaches the selected live canonical session
from the authenticated runtime projection and paged session registry. It shares
Dev's project/session selection and the donor contextual hierarchy, including
its common collapse state. It does not require first-run worktrees, workspace
AgentProfiles or managed-Pi install facts to read an existing conversation.
Selection, scope replacement and unmount fence every deferred attachment;
failures keep a visible canonical retry state rather than silently substituting
team chat. View switches use read/stream operations only and cannot create,
launch or resume a session. First-run creation refreshes that same hierarchy.
The desktop API exposes no Control Plane model-entitlement projection, so
onboarding does not consult one: model access is the harness's own (BYOK),
identity is the device-local guest or the cloud-bound account, and neither
gates the launch. A CP-provisioned entitlement would arrive as an additive
projection, not a precondition. Packaged first-run certification remains an
M13.4 acceptance gate.

The Dev↔Chat switch proof drives the model from the Chat side through repeated
Dev projection and Chat attach cycles. Each cycle must observe the same
`runtimeSessionId`, generation-qualified event sequence and retained window,
draft, and transcript scrollback; the only allowed operations during a switch
are authenticated, mutation-free canonical hierarchy and generation-fenced
session reads. A switch never invokes create, launch, resume, cancel, archive,
or an event-log write.

Inline approval and question controls are fail-closed. The Chat transcript may
render an `approval.requested` or `question.requested` event, but it MUST keep
the corresponding response controls disabled with a visible reason until the
host supplies an authorized, generation-bound response operation through the
`DevRuntimeService` integration. A missing callback is not an invitation to
send a best-effort event, type into a PTY, or report success. The current
runtime operation registry has session lifecycle and event-read commands but no
approval/question response command; adding one requires an M11 contract that
binds account/workspace/runtime-node/session/generation, event identity, input
owner, capability, single-use/idempotency, and canonical resolved/expired
events. Until that contract exists, Chat's disabled state is the truthful
projection; a host may direct the user to another separately authorized
control surface when one exists, but Chat must not invent that route.

`packages/data` owns the scoped query keys and cancellation/invalidation seam;
`packages/state` owns only ephemeral selected IDs and presentation state. The
`DevRuntimeService`/provider adapter maps registry replies into this projection
and never creates a second session, event, approval, credential, or runtime-node
authority.

### Chat composer decision-layer consumer (M13 #533)

The Chat composer consumes control-plane `decision-resolution.v1` from
control-plane#558. The Adea-side request and reply types live under
`packages/dev-view/src/chat/composer/decision-layer.ts` and mirror the pinned
contract version `{ major: 1, minor: 0 }`: objective, AgentProfile, available
runtimes, entitlements, required capabilities, cost/latency preference,
project/profile defaults, and explicit pins are submitted as one request. The
reply contains the eight resolved outputs (harness, model, skills,
capabilities, runtime, sandbox, context package, and delegation), precedence
trace, diagnostics, and digest.

Auto mode always sends an empty `explicitPins` object. Customize mode forwards
the user's explicit pins; the composer never applies precedence or chooses a
harness/model locally. The response's logical `harnessId` is not treated as a
local `harnessInstallationId`: the authenticated host adapter must map the
resolved selection into the existing #400 `dev.session.create` plus
`dev.session.launchDefault`/`launchHarness` transaction with the same
idempotency key. If that adapter, the decision contract, or model entitlement
is unavailable, the consumer returns `auth_required` or `unavailable` with one
recovery action and does not launch a default.

Composer mode, agent, favorites, and recents may be persisted only under the
authenticated `(accountId, workspaceId, projectId)` preference key. Preference
records contain IDs and presentation choices only; credentials and credential
values are never persisted by the Chat package. No new Dev Runtime wire
operation is introduced by this consumer.

### Durable project/session authority (desktop host)

The desktop shell's project/session register is the host-side canonical
authority for local project bindings, runtime sessions, and the archive
journal — not a projection of other state. Its v2 authority record is
`{ scope, projects: ProjectBinding[], sessions, archiveRecords, sessionCreates? }`
with `ProjectBinding { projectId, repoIds, repos?, preferredRuntimeNodeId?,
defaultBaseRef?, bootstrapWorkflowId?, defaultHarnessId?, lifecycle, version }`.
A binding is keyed by the **cloud project id** (an opaque lowercase UUID the
client supplies) and holds only local facts; the cloud project record owns the
name, order, and grouping, so the register stores none of them and has no
groups. The wire `Project` is the binding projected with `id = projectId` and
the scope. One versioned snapshot payload commits bindings, sessions, and
`ArchiveRecord`s together in the WAL-backed per-scope
`dev-runtime/project-session/authority-v2-<sha256(scope)>.sqlite3` store
(schema version 2), so `dev.session.archive`/`dev.session.unarchive` persist
the session flip and its durable record in one SQLite transaction. The store
enables `journal_mode=WAL`, `synchronous=FULL`, and foreign keys on every
open, uses a format-version guard, and binds its single row to the
`(accountId, workspaceId, runtimeNodeId)` scope key before returning records.
For a device workspace scope the `workspaceId` is the selected cloud workspace
(the account and runtime node stay the local ones), so each cloud workspace
owns its own partition; the earlier device-local guest partition is left on
disk, never read, migrated, or deleted by a selection. Each scope has an
independent database and ledger, so switching workspaces never makes one scope
open or overwrite another scope's file. The one sanctioned cross-scope read is the
counts-only `dev.summary.workspaces` operation (see "Cross-workspace run
summary"): it folds the shared harness run registry
(`dev-runtime/harness/runs.json`, which already holds every scope's runs) and
opens no other authority partition, ledger, or per-scope file; it counts only
scopes with the active scope's `accountId` and `runtimeNodeId`; and it returns
nothing beyond each counted `workspaceId` and two integers.

**v1 records are left unread (owner decision, no migration).** The v2 file
name differs from every v1 name (`authority.sqlite3`,
`authority-<sha256(scope)>.sqlite3`, their migration ledgers, and the legacy
`authority.json`/`projection.json` sources), so opening the v2 register never
opens, reads, rewrites, migrates, or deletes a v1 database or JSON source; those
files stay byte-identical on disk and the v2 partition starts empty. A stored
v2 record that carries `groups`, a project `name`, or `groupIds`, a scope
mismatch, a malformed payload, or an unsupported format/schema version fails
closed with `corrupt_state` and retains an unread database copy for recovery;
the original database is never replaced by a recovery copy. Each partition has
an owner-only sidecar ledger (`authority-v2-<sha256(scope)>.sqlite3.migration.json`)
that records the database identity and survives SQLite loss: a first open
creates a native-state ledger before accepting a save, and if the SQLite
metadata survives alone a missing ledger is regenerated before records are
returned. Deleting both files is a complete local state loss with no surviving
identity; external backup or recovery protection must cover that trust
boundary.

The register serves `dev.project.import`/`clone`/`create`/`get`/`list`/
`update`/`archive`/`unbind` and `dev.session.create/get/list/archive/unarchive`. There
are no `dev.group.*` operations and no `dev.project.reorder`: order comes from
the cloud project list. `dev.project.create`, `dev.project.import`, and
`dev.project.clone` (both its `checkout` and `managed` modes; see "Clone sources
(`dev.project.clone`)") take the client-supplied `projectId`; a second binding for an already-bound project id,
or a non-UUID id, is refused with `identity_mismatch`. `dev.project.import`
binds a project to an **authorized root bookmark**: the canonical root is
resolved fail-closed through the roots authority inside the host — a
client-supplied path never reaches the register — and a second binding for the
same bookmark is refused with `identity_mismatch` instead of silently
duplicating. `dev.project.update` patches only binding fields (preferred
runtime node, default base ref, bootstrap workflow, default harness); a `name`
or `groupIds` key is an unknown key the body decoder refuses.
`dev.project.unbind { projectId, expectedVersion }` (`dev.project.manage`,
`project` resource binding) removes the binding record and publishes
`project.unbound`; it never stops a process and never touches repository or
worktree files, and like project archive it refuses with `invalid_state` while
any non-archived session on the project is still live. `dev.session.create`
binds the session to an in-scope binding and rejects a `repoId` outside its
bound repositories with `identity_mismatch`. Every mutation enforces the scope
triple (`unauthorized`), the ownership epoch (`stale_generation`), and
optimistic concurrency (`stale_version`); a stored record that fails structural
decode fails closed with `corrupt_state` and is retained unread. Other Dev
Runtime authorities remain on the existing JSON store until an independently
reviewed migration slice covers their schema and rollback contract.

On the client, project/session selection resolves only inside the active
scope's projection and enforces archive state, explicit revocation, generation
binding, and observation freshness; a stale projection renders a visible
staleness state instead of silently trusting the stored selection. Deep-link
selection (`devProject`/`devSession` query params) is deterministic: an
unknown query key survives, and a stale, archived, revoked, generation-stale,
or cross-scope link recovers to the closest live selection with a visible,
announced banner while the URL converges on the corrected selection.

**Shared workspace sidebar (ADR 0011).** The Dev contextual sidebar is the
shared `@adea-ai/workspace-nav` `WorkspaceNav` with the `dev` adapter, mounted
by `packages/dev-view/src/sidebar/dev-workspace-sidebar.tsx` in both the Dev
view and the desktop runtime Chat. Its hierarchy is workspace › project ›
leaf: only the active workspace is expanded; other workspaces are one row
each with running, needs-you, mention and unread chips, and selecting one
switches through the host's authorized workspace switch. The pure projection
is `buildDevNavSource` in `sidebar/dev-nav-model.ts`:

- **Projects** come from the cloud project list (names and order, active
  lifecycle only), joined by project id with the register's local bindings
  (`DevWorkspaceProjection`); the host's names also feed `projectNames`. A
  cloud project with no binding on this device renders as source `none` with
  an "Add repository…" menu item; a binding with no cloud row is hidden and
  logged once (`hiddenBindingIds`). Without a cloud list (fixtures, direct
  integrations) the bindings render in projection order with their host
  names. The sidebar offers no reorder affordance. A bound project's source
  is the projection's `source` as given (`local_repo`, `remote_only`,
  `none`): a remote-only project (managed bare clone) shows the cloud icon
  and never a checkout row; a `none` binding asks for a repository first.
- **Leaves** come from `dev.worktree.list`: the `primary` record is the
  checkout leaf (house row, labelled with the `headRef` it actually has checked
  out, never archived or deleted from here); `managed` and `external` records
  are worktree leaves, labelled with their branch and local title. Archived
  records are omitted. A live session bound to a worktree the list did not
  report keeps a session-derived leaf, so a refused or failed list never hides
  a session. Worktree records carry no timestamps, so list order stands in for
  recency within a project; the checkout leads.
- **Status** is observed, never a session field: `leafActivity` over the
  `dev.harness.runs` of the leaf's live sessions gives needs you, running or
  idle; an idle leaf whose `taskId` names a cloud task in `in_review` is in
  review. **Diff counts** come from one `dev.worktree.diffSummary` batch for
  the worktree rows on screen (expanded projects only, checkout and
  session-derived rows excluded, at most 50 ids).
- **Counts** for collapsed workspaces and the "Needs you" strip add the
  desktop `dev.summary.workspaces` counts (polled by the desktop lane every
  30s while the document is visible and again when it becomes visible) to the
  cloud account summary's mentions and unread channels.

Runtime reads are bounded and fail closed: one scope-wide worktree list and
one harness-run read (each at most 4 pages of 500) per refresh — on mount,
scope or projection change, when the document becomes visible, and on a 30s
poll while visible — and one diff batch whenever the visible worktree set
changes, after a refresh, or (debounced 500ms) when `git.statusInvalidated`
names a visible worktree. Typing, hovering or selecting never issues a read.
A refused or malformed reply keeps the last observed rows instead of guessing
an empty list. A refresh that changes nothing keeps the rendered rows (the
tree reuses unchanged workspace, project and leaf objects, and counts-only
changes keep the expanded workspace mounted), so polling never drops keyboard
focus or an open menu. The one `stabilizeNavTree` in
`@adea-ai/workspace-nav/model` does this for Dev, Chat and Virtual alike, and
the desktop summary poll keeps its previous array when a read observed the
same counts.

Selecting a leaf selects its worktree's most recent live session (the current
selection when it is already on that leaf) and reports it through
`onSelectionChange`, which keeps `?devProject`/`?devSession` deep links and
`resolveDevSelection` authoritative; the top-bar breadcrumbs follow the
selected leaf's project and checked-out branch. A leaf with no session starts
one with `dev.session.create` on that worktree and selects it once the
projection reloads. A project's "+" is "New worktree" (`dev.worktree.create`
with an inline branch name, based on the binding's default base ref, else the
checkout's branch) when it has a repository and "New session" otherwise, which
first asks for a repository. Worktree menus offer Rename (`dev.worktree.rename`,
local title), Copy link (the leaf's Dev deep link), Open in Finder
(`dev.files.openExternal` on the worktree root), Archive (`dev.worktree.archive`)
and Delete (`dev.worktree.cleanupPlan`, then a destructive confirmation listing
every planned step and any blocker before `dev.worktree.cleanupCommit`). The
checkout menu offers Copy path and Open in Finder only; Share stays out until
leaf sharing ships and "Switch branch…" stays behind its flag. Project menus
offer Rename (cloud project update), Project settings (the cloud name and, for
a bound project, the repository registry), Add repository… (unbound projects;
the import binds that project's id) and Archive/Delete (cloud archive or soft
delete, then `dev.project.unbind` when bound — files are never touched). The
active workspace header's "New project" names a cloud project and then offers
the repository step. Mutations load on first use; refusals are shown inline
and announced, never swallowed.

The sidebar's shell is the published `@adea-ai/ui` `ContextualSidebar` and
`PixelResizeHandle` composition, shared with the Chat/Virtual
`WorkspaceNavSidebar`: landmark "Workspace navigation", one stored width
(`adea:workspace-sidebar-width`, 208–448px, owned by the one
`@adea-ai/workspace-nav/sidebar-width` module) projected into the workspace
frame, the archive shelf in the footer. Shared UI owns the responsive
desktop/mobile shell, heading, scrolling and footer slots, collapse semantics,
edge resize handle, tree keyboard model and focus treatment; Adea owns the
data, the controlled open state and the width preference. Hosts pass the
initial `wideViewportAtLoad` seed and update the same host state through
`onOpenChange`; a desktop-open state is cleared when a wide-loaded view enters
the mobile breakpoint, while an intentional open at narrow boot is retained.
Closing the mobile sheet returns focus to the global sidebar opener through
`restoreFocusRef`. Selecting a leaf or another workspace closes the mobile
sheet; expanding or collapsing a project is disclosure only and keeps it open.
Row menus use the context's `portalMount()` so they remain inside the mobile
dialog's accessibility tree, and the sheet drops focus tooltips so Escape
dismisses it. The archive shelf uses shared row, action, scrolling,
empty-state, alert and focus-managed destructive confirmation components.
Failed archive reads name their error and preserve previously loaded rows;
absent archive timestamps are labeled unavailable rather than implying
recency. A successful restore returns focus to the persistent shelf control if
its removed button still held focus. Restore calls the authenticated unarchive
contract, and deletion still requires confirmation and reports the missing
host contract rather than fabricating success. An unavailable runtime shows
"No runtime projects available." above the tree; it never authorizes mock
data. Dev focus mode and full-width utility surfaces suppress conflicting
contextual navigation while the shared owner remains mounted; the global rail
remains visible.

### Browser lane

```text
provisioning → ready → navigating ↔ ready → suspended → ready → closing → closed
                          └→ crashed → recovering|closed
```

Automation ownership is `none | agent | human_takeover`. Transfer increments
generation and invalidates old input. Browser lane kind and profile identity are
immutable for the lane lifetime.

### Device session

```text
discovering → available → starting → attached ↔ suspended → stopping → stopped
```

A physical device additionally requires paired/authorized state. Adea may stop
only simulator/emulator processes it launched and still owns.

`dev.device.capabilities` is a read-only, host-probed report with one row each
for iOS and Android. The iOS probe uses the fixed `xcrun simctl list devices
-j` command. Android requires successful `adb devices -l` and `emulator
-list-avds` probes; a successful probe with no devices or AVDs means the
toolchain is available with an empty inventory. A missing executable, nonzero
exit, or malformed inventory response is `unavailable` and identifies the
fixed `missingPiece` where known. The report never includes command output,
stderr, or host paths. Device inventory MUST only be built from successful,
validated probes, so a missing tool cannot masquerade as an empty inventory.

### Cleanup job

Every transition is journaled before its side effect:

```text
draft → preflighted → approved → running → completed
          └→ blocked             ├→ partial → running
                                 └→ recovery_required → running|rolled_back
```

The plan contains immutable observed facts and their versions. Commit refuses
if any fact changed. Retrying the same idempotency key resumes; it does not
repeat a completed side effect.

A reusable `CleanupPolicy` is `draft → approved → disabled|expired|superseded`.
Only an authenticated user with the cleanup-policy capability may approve it.
Approval binds project, policy version, exact predicates, allowed step kinds,
and optional expiry; editing any field creates a new draft/version. An automatic
policy MUST include `clean`, `pushed`, `pull_request_merged`,
`no_active_leases`, and `no_active_owned_resources`; implementations may require
additional predicates but may not omit these five. It MUST reread every
predicate and ordinary cleanup proof at execution time.

Automatic execution may perform only `quarantine_worktree`,
`unregister_worktree`, `delete_quarantine`, `delete_branch`, and
`prune_retained_data`, and only when each appears in `allowedSteps`. It MUST NOT
run teardown or stop any process, terminal, harness, server, browser, or device;
`run_teardown` and `stop_owned_resource` always require confirmation on the
current run. Automatic execution proceeds only when every predicate is
authoritative and true and there are no blockers. `unknown`, `stale`, missing
PR/push/lease/process truth, or any owned/external resource requests
confirmation instead. Each evaluation and run emits a secret-free audit record.
Disabling/superseding is immediate for runs that have not committed their first
destructive step; expiry is checked again before every step.

## Command envelope and authorization

All privileged commands use a versioned authenticated channel:

```ts
type DevOperation =
  | `dev.capability.${'snapshot'}`
  | `dev.project.${'list' | 'get' | 'import' | 'clone' | 'scan' | 'create' | 'update' | 'archive' | 'unbind' | 'bookmarks'}`
  | `dev.repo.${'list' | 'inspect' | 'refresh' | 'authorize' | 'adopt' | 'remove' | 'credentialRefs'}`
  | `dev.connections.${'get' | 'setGitHosting' | 'setHarnessAccount'}`
  | `dev.worktree.${'list' | 'create' | 'retryBootstrap' | 'lease' | 'releaseLease' | 'mergePlan' | 'mergeCommit' | 'archive' | 'unarchive' | 'cleanupPlan' | 'cleanupCommit' | 'cleanupResume' | 'cleanupJobs'}`
  | `dev.terminal.${'create' | 'attach' | 'detach' | 'input' | 'resize' | 'signal' | 'terminate' | 'checkpoint' | 'search' | 'historyDelete' | 'list' | 'shellProfiles'}`
  | `dev.session.${'create' | 'get' | 'list' | 'launchDefault' | 'launchHarness' | 'resumeHarness' | 'cancelHarness' | 'events' | 'transferInput' | 'archive' | 'unarchive'}`
  | `dev.harness.${'managedPiStatus' | 'managedPiInstall' | 'acpConnect' | 'acpConnections' | 'acpClose' | 'preferences' | 'preferenceUpdate' | 'preferenceReset' | 'runStatus' | 'runs'}`
  | `dev.harness.accountProfiles.${'list' | 'create' | 'delete'}`
  | `dev.files.${'list' | 'stat' | 'read' | 'write' | 'create' | 'rename' | 'delete' | 'copy' | 'search' | 'openExternal' | 'readStream' | 'writeStream' | 'renameOverwritePlan' | 'renameOverwriteCommit' | 'deleteTreePlan' | 'deleteTreeCommit' | 'copyTreePlan' | 'copyTreeCommit'}`
  | `dev.git.${'status' | 'history' | 'diff' | 'stage' | 'unstage' | 'discardPlan' | 'discardCommit' | 'commit' | 'fetch' | 'checkpoint' | 'restorePlan' | 'restoreCommit'}`
  | `dev.browser.${'laneCreate' | 'laneClose' | 'lanes' | 'attach' | 'navigate' | 'targets' | 'viewport' | 'screenshot' | 'annotate' | 'inspect' | 'diagnostics' | 'takeover' | 'release' | 'input' | 'cookieImportPlan' | 'cookieImportCommit' | 'cookieSources' | 'profileReset' | 'profilePolicies'}`
  | `dev.computeruse.${'capabilities' | 'lanes' | 'laneCreate' | 'laneClose' | 'consent' | 'attach' | 'input' | 'takeover' | 'release'}`
  | `dev.device.${'capabilities' | 'list' | 'sessions' | 'start' | 'attach' | 'input' | 'screenshot' | 'stop'}`
  | `dev.github.${'account' | 'repository' | 'issues' | 'milestones' | 'pullRequest' | 'pullRequests' | 'checks' | 'pushPlan' | 'pushCommit' | 'createPullRequest' | 'updatePlan' | 'updateCommit' | 'mergePlan' | 'mergeCommit'}`
  | `dev.github.${'pullRequestSummaries' | 'pullRequestSummary' | 'timeline' | 'commits' | 'files' | 'checkLog' | 'labels' | 'assignableUsers' | 'branches' | 'compare' | 'comment' | 'threadReply' | 'threadResolve' | 'metadataUpdate' | 'submitReview' | 'rerunFailedJobs' | 'autoMergePlan' | 'autoMergeCommit' | 'syncBranchPlan' | 'syncBranchCommit'}`
  | `dev.resources.${'snapshot' | 'processes' | 'ports' | 'metrics' | 'usage' | 'stopPlan' | 'stopCommit' | 'retainedData' | 'restartPlan' | 'restartCommit' | 'foreignStopPlan' | 'foreignStopCommit' | 'janitorScan' | 'janitorMeasure' | 'janitorPlan' | 'janitorCommit' | 'worktreeStorage' | 'preferences' | 'preferencesUpdate'}`
  | `dev.cleanupPolicy.${'list' | 'createDraft' | 'approve' | 'disable' | 'evaluate'}`

type DevCommand<K extends DevOperation, T> = {
  schemaVersion: 1
  operation: K
  requestId: string
  nonce: string
  idempotencyKey?: string
  issuedAt: string
  expiresAt: string
  scope: Scope
  capabilities: readonly DevCapability[]
  resource?: { kind: string; id: string; generation: number }
  body: T
}

type DevReply<K extends DevOperation, T> =
  | { schemaVersion: 1; operation: K; requestId: string; ok: true; value: T; observedAt: string }
  | { schemaVersion: 1; operation: K; requestId: string; ok: false; error: DevError }

type AuthorizedDevFrame<K extends DevOperation, T> = {
  channelId: string
  clientCredentialId: string
  command: DevCommand<K, T>
  proof: string // M10 signature/MAC over the canonical command digest and channel binding
}
```

The only control-plane transport method names are
`dev.runtime.handshake.v1` (negotiate versions/capabilities and obtain a
channel), `dev.runtime.execute.v1` (one `AuthorizedDevFrame`/`DevReply`),
`dev.runtime.events.v1` (cursor-resumable event stream), and
`dev.runtime.stream.attach.v1` (terminal/browser/device/computer-use bulk
stream negotiated from an authorized execute reply).

Scope admission is identity-first and account-optional: the shell mints a
durable device-local identity on first boot (a guest scope triple persisted
owner-only; see [desktop authentication](./desktop-auth.md)), so the whole
catalog serves a signed-out, offline machine with no prompt. The trusted
window selects a device workspace scope (`desktop_identity_select_workspace`)
for each cloud workspace the presented desktop session or guest temporary
credential is a verified member of: `{ local accountId, cloud workspaceId,
local runtimeNodeId }`, kind `device`. Membership is proven against the cloud
workspace listing and cached per credential digest for 24 hours, so offline
selection reaches only already-verified workspaces; a non-member, an
unverifiable workspace, or a lapsed membership fails closed with a typed error
(`unauthorized`, `workspace_unavailable`). A scope change revokes every channel
and the host recomposes under the new scope. A paired cloud bind takes
precedence over the device selection until sign-out returns to the device
selection or the device-local identity; the renderer can never self-assert any
of them. `dev.capability.snapshot`
projects the ACTIVE identity's availability surface: the shell's own window —
guest or cloud-bound — holds the machine's FULL capability catalog, because
the real authorization lives in scope admission and the command providers
(path containment, owner approvals, generation fences), not in this
projection; `unavailable` is empty for the local owner. Scoped capability
subsets arrive with remote callers (M14 runtime nodes), which authenticate as
a different identity class than this trusted local channel. The normative
[`dev-runtime-operations.json`](./dev-runtime-operations.json) registry provides
all 232 operation names, exact body shapes, exact reply types, complete required
capability sets, resource requirement/kind, and stream protocol/direction. Code
generation and decoders use that registry; prose or a handler cannot add or
weaken an operation. `apps/web/src/lib/desktop-dev-runtime.ts`
constructs typed commands but cannot read credential secret material; the
injected desktop bridge sends them through the authenticated M10 channel and
keeps the channel secret in its closure while binding `channelId`,
`clientCredentialId`, and `proof`. The host rejects a bare `DevCommand`.

Every registry operation has a strict unknown-key-rejecting request decoder in
`packages/types/src/dev-runtime.ts`. The foundation decoder accepts typed error
replies and fails closed for every success reply until the operation-owning
provider slice adds that reply DTO's strict decoder and tests before registering
a handler. No generic object fallback is permitted. The registry's `body` field
is the sole request-shape DSL: braces denote the
entire flattened object; every named field is required unless marked `?`; `|`
denotes an exact closed union; `[]<=N`, string/number ranges, and byte units are
inclusive limits; `sha` is lowercase hexadecimal Git object ID accepted only at
the repository's object format; `sha256` is 64 lowercase hexadecimal digits;
`timestamp` is UTC RFC 3339; `uint64-string` is canonical unsigned decimal
for every unbounded uint64 value; named types resolve to the exact DTO in this
spec and reject unknown keys.
`reply` is the complete success value; `Page<T>` is
`{ items: T[]; nextCursor?: string; observedAt: timestamp }`. The registry is
machine checked against the catalog. No prose wrapper, alternate nesting, or
implicit extra field is allowed.

Browser-safe command-construction metadata is generated from this same registry
in `packages/types/src/dev-runtime-operation-metadata/`. Each operation has its
own pure module, and `@adea-ai/types/dev-runtime-operation-metadata` is the
tree-shakeable barrel for eager callers and the unavailable-provider capability
list. `@adea-ai/types/dev-runtime-metadata` preserves the dynamic-client
compatibility aggregate by importing those same generated definitions. Eager
callers bind their exact operation entry; the shared builder uses the operation
carried by that entry together with its capability and resource requirements.
These generated forms carry the same registry facts and do not create a second
authorization source.
The dynamic map projects each named binding through one shared helper, retaining
exactly `capabilities` and `resource` with their literal types. This avoids
repeating the projection code for every operation while keeping per-operation
imports independent and the wire/registry contracts unchanged.

No body accepts `unknown`, an open record, a shell command string, an absolute
path where a `WorkspacePath` is required, or identity/capability/channel
authority. `resource` is absent only where the operation registry says `null`; otherwise
it is mandatory, its `kind` is the registry prefix before `:`, and its `id`
duplicates the body's target ID for confused-deputy rejection. A paired commit
is only an operation for which the registry also contains the same stem ending
in `Plan` (for example `cleanupPlan`/`cleanupCommit`, `pushPlan`/`pushCommit`, or
`discardPlan`/`discardCommit`). Its body intentionally contains only
`planId`/`planDigest`; the host loads the immutable unexpired plan, and envelope
resource kind/ID/generation MUST equal that plan's bound target before digest or
side effects are evaluated. `dev.git.commit` is not paired with a plan; its body
therefore includes `worktreeId` and must duplicate the envelope resource ID. Its numeric
generation is the record's `generation` when present, otherwise the record's
`version`; provider snapshots expose a monotonic cache generation; file/root
operations use the owning Worktree generation. The host returns these values in
read models and rejects a value it did not issue or that no longer matches.
Concrete aliases and success DTO decoders are generated/transcribed exactly
from the operation registry and written with decoder/property tests before their
handler in the manifest-owning slice; implementations do not choose different
fields. The
envelope's sorted `capabilities` MUST equal the registry set exactly; the M10
gate independently derives the same set from `operation` and rejects missing,
extra, duplicated, or differently ordered values. Canonical order is ascending
Unicode code-point order over the ASCII capability strings. `resource` presence, kind,
and ID/generation binding MUST equal the registry entry.

The M10 gate MUST verify, in this order:

1. channel credential/signature and trusted client/webview identity;
2. expiry, nonce/replay status, schema, payload size;
3. authenticated user and account/workspace capability;
4. eligible runtime node and RuntimeConnection route;
5. resource belongs to scope and expected generation;
6. operation-specific root, lease, credential, and state preconditions;
7. idempotency record before mutation.

`nonce` is base64url without padding, contains at least 128 bits from a
cryptographic RNG, and is generated for one request by the authenticated client
channel. The channel signature/MAC binds nonce, request ID, canonical command
digest, client credential ID, operation, sorted required capabilities, scope,
resource/generation when required, issued/expiry times, and idempotency key. The M10 gate atomically stores the consumed nonce under
`(clientCredentialId, accountId, workspaceId)` through expiry plus 30 seconds;
a repeated nonce is `replay_rejected` even when the body matches. A logical
retry uses a fresh request ID and nonce but the same idempotency key. Nonces are
never reused after reconnect or credential rotation.

The in-process dispatch seam (`authority.dispatchLocal`, M12) lets trusted shell
code — today only the git watcher lane's `readStatus` seam — dispatch a
FULLY-FORMED `DevCommand` through the same terminal steps the socket path runs:
structural validation by the exact `decodeDevCommand` decoder the authorized
frame path reaches, the freshness/expiry window, scope admission through
`authorizeCommand` (which receives no channel identity on this lane), capability
derivation against the registry, registered-provider invocation, and the same
`DevReply`/audit/refusal machinery. The seam fails closed: it accepts only the
authority's module-private `INTERNAL_DISPATCH_MARKER`, and any other value
throws `channel_unauthenticated` before the command is examined. The marker
stands in for exactly the proofs an internal caller satisfies STRUCTURALLY,
because it authors the envelope in-process and holds no client-supplied bytes:
trusted origin (the shell process itself is the trust boundary the socket path
proves with loopback origin checks), channel credential and identity proof
(there is no channel to authenticate and no secret to verify), and replay
(the envelope is minted fresh per dispatch inside the trust boundary, is never
serialized onto a transport, and remains bounded by the freshness window). The
seam never accepts a raw frame, a proof, or any client-supplied bytes; resource
binding, the generation fence, and ready-lifecycle re-proofs stay with the
provider exactly as for an external caller. Audit records for this lane carry
no channel fields, which is what makes an internal dispatch distinguishable
from socket traffic; counters and typed refusals are shared with the socket
path.

A remote client never connects directly to an arbitrary host port. It uses the
authorized RuntimeConnection route, whose host repeats scope/generation checks.
A host refusal is not translated into local success.

Defaults:

- command expiry: 60 seconds; maximum accepted clock skew: 30 seconds;
- credential-vault master keys are held by the host OS credential store (macOS
  Keychain in the desktop lane), never by a `vault.key` file in app data;
  unavailable or denied stores fail closed. The packaged desktop bootstrap
  probes `Bun.secrets` only when the bundled Bun runtime is at least 1.4.0;
  when available, it reads the Bun slot, validates the 32-byte key, and uses
  the existing `/usr/bin/security` slot as the compatibility source. Migration
  writes the legacy key to Bun, reads it back, and requires an exact match
  before the vault opens. A fresh install or Bun-only state also seeds and
  verifies the legacy slot before opening, so a downgrade cannot fabricate a
  different key. The legacy slot is retained for rollback and every Bun or
  legacy read, write, or verification failure fails closed without generating
  or replacing a key. A runtime below the floor or without `Bun.secrets` keeps
  the existing `security` adapter unchanged.
- vault metadata uses `dev-runtime/vault/credentials.sqlite3` with WAL and
  full-sync durability. The SQLite row contains only strictly decoded
  `CredentialRef` metadata; sealed credential files remain separate, and
  plaintext, sealed bytes, and any vault key material are refused before a
  record reaches SQLite. The prior `credentials.json` envelope is retained as
  a recovery source and is imported transactionally through an owner-only
  migration ledger that binds the source digest and SQLite database identity.
  Restart retries an interrupted migration from the untouched source;
  scope-mismatched, corrupt, or lost SQLite state fails closed and retains the
  unread database for recovery. The legacy source is never deleted; migration
  leaves it unchanged, while revocation writes a redacted metadata tombstone
  there after the sealed file is removed so an older runtime cannot resolve a
  revoked reference during a downgrade or crash recovery.
- attach/input tokens: single-use where possible, at most 60 seconds;
- control payload: 256 KiB; bulk operations use bounded streaming, not a larger
  control message;
- idempotency key: 1–128 printable ASCII characters, scoped to operation +
  account + workspace + node + resource;
- completed mutation result retention: 24 hours minimum, 7 days maximum;
- no automatic retry of destructive commands; the coordinator resumes them by
  idempotency key after rereading state.

### Bulk stream attach protocol

```ts
type DeviceGesture =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'swipe'; fromX: number; fromY: number; toX: number; toY: number; durationMs: number }
  | { kind: 'key'; code: string; action: 'down' | 'up' }
  | { kind: 'text'; text: string }

type DevStreamGrant = {
  schemaVersion: 1
  grantId: string
  protocol:
    | 'terminal-bytes-v1'
    | 'browser-frames-v1'
    | 'device-frames-v1'
    | 'desktop-frames-v1'
    | 'file-bytes-v1'
    | 'runtime-events-v1'
  channelId: string
  scope: Scope
  resource: { kind: string; id: string; generation: number }
  direction: 'read' | 'write'
  fromSequence: string
  expiresAt: string
  maxFrameBytes: number
}

type DevStreamAttach = {
  schemaVersion: 1
  grantId: string
  requestId: string
  nonce: string
  fromSequence: string
  proof: string
}

type DevStreamFrame =
  | {
      type: 'opened'
      protocol: DevStreamGrant['protocol']
      generation: number
      nextSequence: string
    }
  | { type: 'data'; sequence: string; bytes: Uint8Array }
  | {
      type: 'video'
      sequence: string
      timestampMs: number
      generation: number
      viewportSequence: number
      width: number
      height: number
      keyframe: boolean
      bytes: Uint8Array
    }
  | { type: 'input'; sequence: string; generation: number; bytes: Uint8Array }
  | { type: 'gesture'; sequence: string; generation: number; gesture: DeviceGesture }
  | { type: 'resize'; sequence: string; generation: number; cols: number; rows: number }
  | { type: 'ack'; throughSequence: string; availableCreditBytes: number }
  | { type: 'heartbeat'; observedAt: string; throughSequence: string }
  | { type: 'resync'; reason: 'sequence_gap' | 'checkpoint_required'; checkpointSequence: string }
  | { type: 'error'; error: DevError }
  | {
      type: 'close'
      code: 'normal' | 'expired' | 'revoked' | 'stale_generation' | 'backpressure' | 'incompatible'
      reason?: string
    }
```

The execute reply issues the grant; it is random, single-use, expires within 60
seconds, and is MAC-bound to client credential, channel, protocol, scope,
resource/generation, direction, sequence, and limits. Attach consumes it and
rechecks channel credential, nonce, scope, generation, and current capability.
Gesture coordinates are normalized 0–1, swipe duration is 10–10,000 ms, key
codes come from the versioned device allowlist, and text is at most 4 KiB.
Frames after `close`, frames in the wrong direction, mis-sequenced client
input, oversize frames, stale generations, or sequence wrap are rejected and
close the stream. The two directions sequence client frames differently, and
the validator enforces each per its grant: on `read` grants only client credit
(`ack`) rides inbound; on `write` grants byte-bearing `input` frames carry
byte-offset sequences — the first chunk lands exactly on the grant's
`fromSequence` and every later chunk on the running offset end (previous
offset + bytes length), so gaps, replays, and overlaps are all refused typed —
while byte-less `gesture`/`resize` frames keep strictly increasing event
sequences that never fall behind bytes already consumed. `data`/`input` bytes
on the authenticated WebSocket are never JSON/base64-transcoded. Browser/device
video uses `video`; terminal output uses `data`; control frames are canonical
CBOR with a 64 KiB maximum unless the grant's lower bound applies. Server output
pauses when credit is zero; client input never exceeds the grant and subsystem
queue caps. Reconnect obtains a new grant and starts from the last acknowledged
sequence/checkpoint; it never reuses attach proof or guesses continuity.
If a newly authenticated `opened` frame changes the terminal generation, the
client may continue reading from that frame's generation-scoped cursor, but it
MUST discard queued input from the old generation and report typed
`stale_generation`; later writes use only the newly authenticated generation.
If a client input send throws, delivery is ambiguous; the client MUST close the
stream, discard queued input, report typed `delivery_ambiguous`, and never retry
those bytes automatically. The pane presents safe copy derived from the error
code rather than rendering host-provided error text.

The real terminal pane routes both raw key input and composed drafts through
one bounded, generation-fenced transport queue. It clears a composed draft
only after that queue accepts it; a rejected draft remains editable. Fitted
PTY dimensions use that same authenticated transport, which sends changes
immediately when open and coalesces them until an authenticated reconnect.
Automatic PTY resizing can be disabled when manage capability is absent.
Native connections use server-only heartbeats.

The renderer's terminal adapter is constructed from the exact selected
`TerminalRecord` and never discovers a replacement by taking the first ready
terminal. The first commands use that captured record's scope and bind its
terminal ID and generation; the runtime session remains part of the selected
record identity. On reconnect, the adapter lists only that runtime session,
requires one exact terminal ID in the same scope, and mints fresh read and
write grants for its current generation. The read grant starts at the terminal
transport's current output cursor if its generation is unchanged; after a
generation change, it starts at that generation's `0` anchor. The write grant
has its own byte-offset cursor, initialized from its grant and advanced only
after the local write socket accepts a frame. The output cursor is never reused
for input. Larger renderer writes are split into frames no larger than the
write grant's `maxFrameBytes`. Each grant must match the requested protocol,
direction, scope, terminal resource, generation, and cursor; both grants must
use the same channel and distinct grant IDs. Each `opened` frame must match its
grant's protocol, generation, and cursor before the pane is told the socket is
open. The adapter routes ACKs only to the read stream and byte input only to
the write stream. Resize uses the registered `dev.terminal.resize` control
operation bound to the same terminal generation, never a read grant. The
adapter requires measured relay buffering and refuses a stream provider that
cannot report it; it does not assume an empty queue. While the paired grants
open, it retains at most 1 MiB and 256 read frames; overflow is retryable
backpressure, so the next read grant restarts from the unchanged output cursor.

The desktop relay exposes measured `bufferedAmount` for its locally retained
JSON-safe frames, including frames waiting for attach and in-flight invokes.
This value does not claim to measure the kernel socket or host input queue.
Each input snapshots the submitted bytes and obeys the grant frame bound;
terminal input retained by one relay is capped at 1 MiB, including a stricter
1 MiB encoded backlog and 4,096-frame bound covering ACKs and empty inputs.
Local subscriptions are removed immediately, before waiting for host cleanup.
Overflow returns
non-retryable `backpressure` and closes the relay. A terminal consumer whose
provider lacks this measurement must not substitute zero. Closing while proof,
event subscription, or host open is pending fences the eventual result,
releases listeners and queued input, and retires a late host bind. Invokes that
already began may have reached the host; subsequent queued invokes are dropped.

The desktop renderer's signed `desktop_file_stream` event bridge is a JSON
relay, so browser video crossing that leg is split into strict `video_chunk`
envelopes rather than sending a whole image through a command or event. Each
chunk carries the authenticated generation, monotonic frame sequence,
viewport sequence, timestamp, keyframe flag, pixel dimensions, total byte
length, index/count, byte offset, and canonical base64 bytes. Raw chunks are
at most 64 KiB; the complete frame is at most 8 MiB and 128 chunks; the
serialized envelope is at most 128 KiB; dimensions are at most 4096×4096.
Offsets and metadata must remain contiguous and stable. The web transport
holds at most one incomplete frame per attached stream and drops partial state
on timeout, close, or generation mismatch. A reassembly timeout reports a
retryable typed `timeout` and tears down the relay so the caller can obtain a
fresh grant and attach again. The consumer runs only after a complete frame
passes reassembly; partial chunks are never acknowledged. Input remains a
separate write-direction grant. This transport does not authorize pixels for
display: BrowserPane remains closed to image projection while host redaction
provenance is `redacted: false`.

Browser annotations respect the same boundary (#718). The pane's annotate
surface is the shared `AnnotationSurface`, displaying viewport geometry, never
page pixels: the user drags a region (or anchors a bounded note), or presses
Space for a centered mark before adjusting it with the keyboard, over a
frame-shaped box expressed in normalized
0..1 coordinates, and only `dev.browser.annotate` reaches the host, which
captures the screenshot at submit time and binds the reply's `screenshotId`
to the frame it captured. A draft is bound to one lane generation and page
target; any context change, Escape, or the discard control drops it without a
command. While submission is pending, pointer and keyboard geometry changes,
tool selection, note editing, and duplicate submits are disabled; Escape can
still discard the draft.
Completion or draft invalidation releases the pending gate so the next
annotation can be drawn and submitted. Runtime, account/workspace/session,
lane generation, target, and disposal changes retire pending replies and clear
obsolete annotation results; a late reply cannot restore them.
The annotate control is disabled with a stated reason whenever the
lane cannot serve a capture — service unavailable, no lane or page target, a
crashed/closing lane, an agent-owned lane, or the packaged human-embedded
lane whose CDP handle Electrobun does not expose. Element picking stays
selector-driven through `dev.browser.inspect`; the operation deliberately
provides no preview-pixel click picking.

On the desktop shell the channel rides one loopback WebSocket
(`/__adea/channel`) upgraded only for a request that passed the trusted-origin
gate. Its first text message completes `dev.runtime.handshake.v1`; later text
messages carry `{ method, frame | attach | payload }` for
`dev.runtime.execute.v1`, `dev.runtime.stream.attach.v1`, and
`dev.runtime.events.v1`. Every subsequent message is binary: one marker byte
followed by canonical CBOR of the control-frame object (`opened`, `ack`,
`heartbeat`, `resync`, `error`, `close`) or of the byte-frame metadata plus an
exact `byteLength` (`data`, `video`, `input`, `gesture`, `resize`) followed by
the raw bytes. `packages/types/src/dev-runtime.ts` owns the canonical-JSON and
proof-message builders and the canonical-CBOR codec so the client adapter and
the host MAC byte-identical inputs; the channel MAC is HMAC-SHA256 under a
256-bit per-channel secret returned exactly once by the handshake and never
persisted, logged, or exposed to renderer state.

## Command catalog

Exact transport method names are stable once shipped. M12 begins with these
families; adding a privileged command requires this spec, decoder, M10 policy,
audit classification, and deny-by-default tests in the same change.

| Family                       | Required operations                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev.capability`             | `snapshot`                                                                                                                                                                                                                                                                                                             |
| `dev.project`                | `list`, `get`, `import`, `clone`, `scan`, `create`, `update`, `archive`, `unbind`, `bookmarks`                                                                                                                                                                                                                         |
| `dev.repo`                   | `list`, `inspect`, `refresh`, `authorize`, `adopt`, `remove`, `credentialRefs`                                                                                                                                                                                                                                         |
| `dev.connections`            | `get`, `setGitHosting`, `setHarnessAccount`                                                                                                                                                                                                                                                                            |
| `dev.worktree`               | `list`, `create`, `retryBootstrap`, `lease`, `releaseLease`, `mergePlan`, `mergeCommit`, `archive`, `unarchive`, `rename`, `diffSummary`, `cleanupPlan`, `cleanupCommit`, `cleanupResume`, `cleanupJobs`                                                                                                               |
| `dev.terminal`               | `create`, `attach`, `detach`, `input`, `resize`, `signal`, `terminate`, `checkpoint`, `search`, `historyDelete`, `list`, `shellProfiles`                                                                                                                                                                               |
| `dev.session`                | `create`, `get`, `list`, `launchDefault`, `launchHarness`, `resumeHarness`, `cancelHarness`, `events`, `transferInput`, `archive`, `unarchive`                                                                                                                                                                         |
| `dev.summary`                | `workspaces`                                                                                                                                                                                                                                                                                                           |
| `dev.harness`                | `managedPiStatus`, `managedPiInstall`, `acpConnect`, `acpConnections`, `acpClose`, `preferences`, `preferenceUpdate`, `preferenceReset`, `runStatus`, `runs`, `accountProfiles.list`, `accountProfiles.create`, `accountProfiles.delete`                                                                               |
| `dev.memory`                 | `propose`                                                                                                                                                                                                                                                                                                              |
| `dev.files`                  | `list`, `stat`, `read`, `write`, `create`, `rename`, `delete`, `copy`, `search`, `openExternal`, `readStream`, `writeStream`, `renameOverwritePlan`, `renameOverwriteCommit`, `deleteTreePlan`, `deleteTreeCommit`, `copyTreePlan`, `copyTreeCommit`                                                                   |
| `dev.git`                    | `status`, `history`, `diff`, `stage`, `unstage`, `discardPlan`, `discardCommit`, `commit`, `fetch`, `checkpoint`, `restorePlan`, `restoreCommit`                                                                                                                                                                       |
| `dev.browser`                | `laneCreate`, `laneClose`, `lanes`, `attach`, `navigate`, `targets`, `viewport`, `screenshot`, `annotate`, `inspect`, `diagnostics`, `takeover`, `release`, `input`, `cookieImportPlan`, `cookieImportCommit`, `cookieSources`, `profileReset`, `profilePolicies`                                                      |
| `dev.computeruse`            | `capabilities`, `lanes`, `laneCreate`, `laneClose`, `consent`, `attach`, `input`, `takeover`, `release`                                                                                                                                                                                                                |
| `dev.device`                 | `capabilities`, `list`, `sessions`, `start`, `attach`, `input`, `screenshot`, `stop`                                                                                                                                                                                                                                   |
| `dev.github`                 | `account`, `repository`, `issues`, `milestones`, `pullRequest`, `pullRequests`, `checks`, `pushPlan`, `pushCommit`, `createPullRequest`, `updatePlan`, `updateCommit`, `mergePlan`, `mergeCommit`                                                                                                                      |
| `dev.github` (collaboration) | `pullRequestSummaries`, `pullRequestSummary`, `timeline`, `commits`, `files`, `checkLog`, `labels`, `assignableUsers`, `branches`, `compare`, `comment`, `threadReply`, `threadResolve`, `metadataUpdate`, `submitReview`, `rerunFailedJobs`, `autoMergePlan`, `autoMergeCommit`, `syncBranchPlan`, `syncBranchCommit` |
| `dev.resources`              | `snapshot`, `processes`, `ports`, `metrics`, `usage`, `stopPlan`, `stopCommit`, `retainedData`, `restartPlan`, `restartCommit`, `foreignStopPlan`, `foreignStopCommit`, `worktreeStorage`, `preferences`, `preferencesUpdate`                                                                                          |
| `dev.cleanupPolicy`          | `list`, `createDraft`, `approve`, `disable`, `evaluate`                                                                                                                                                                                                                                                                |
| `dev.appearance`             | client preference only; privileged host command only for capability snapshot                                                                                                                                                                                                                                           |
| `dev.appLibrary`             | existing verified catalog/install-plan authority; no new dynamic-code command                                                                                                                                                                                                                                          |

`dev.appearance` and `dev.appLibrary` intentionally have no operation in this
contract: `dev.capability.snapshot` is their only consumer — it reports each as
granted or typed-unavailable for the scope, and the client falls back to local
preference storage or the existing verified App Library surfaces accordingly.

Capability/resource binding is deny-by-default:

| Family        | Read operations                                                             | Mutation operations                                                                                                                                                                                                                    | Resource kind                                                       |
| ------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| capability    | authenticated channel; no feature capability (this snapshot reports grants) | none                                                                                                                                                                                                                                   | no resource                                                         |
| project       | `dev.project.read`                                                          | `dev.project.manage`                                                                                                                                                                                                                   | `project` except top-level list/create/import/clone                 |
| repo          | `dev.repo.read`                                                             | `dev.repo.manage`                                                                                                                                                                                                                      | `repository`                                                        |
| connections   | `dev.harness.read` + `dev.repo.read` (`get`)                                | git hosting `dev.repo.manage`; harness account `dev.harness.manage`                                                                                                                                                                    | no resource; optimistic `expectedVersion` on the binding document   |
| worktree      | `dev.worktree.read`; `diffSummary` additionally `dev.git.read`              | `dev.worktree.manage`; cleanup additionally `dev.cleanup.approve`                                                                                                                                                                      | `worktree`; `diffSummary` none (ids in the body)                    |
| terminal      | `dev.terminal.attach`                                                       | input requires `dev.terminal.input`; lifecycle/signal requires `dev.terminal.manage`                                                                                                                                                   | `terminal`                                                          |
| session       | `dev.session.read`                                                          | harness lifecycle/input transfer requires `dev.session.manage`                                                                                                                                                                         | `runtime_session`                                                   |
| summary       | `dev.summary.read` (counts only; same account + runtime node)               | none                                                                                                                                                                                                                                   | no resource                                                         |
| harness       | `dev.harness.read`                                                          | installation/connection/run/account-profile control requires `dev.harness.manage`                                                                                                                                                      | `acp_connection`, or `runtime_session` for `acpConnect`/`runStatus` |
| memory        | none (entries are read through the trusted `memory_*` shell commands)       | `propose` requires `dev.memory.propose` and an active harness run; it writes `pending` entries only                                                                                                                                    | `runtime_session`                                                   |
| files         | `dev.files.read`                                                            | `dev.files.write`                                                                                                                                                                                                                      | `workspace_path` plus current root identity                         |
| git           | `dev.git.read`                                                              | `dev.git.write`; commit/restore/discard additionally require their current M11 approval when policy says so                                                                                                                            | `repository` or `worktree` as named by request                      |
| browser       | `dev.browser.read`                                                          | `dev.browser.control`; cookie/profile additionally `dev.browser.cookies`                                                                                                                                                               | `browser_lane`                                                      |
| computeruse   | `dev.computeruse.read`                                                      | `dev.computeruse.control`; input additionally requires an active consent record                                                                                                                                                        | `computeruse_lane`                                                  |
| device        | `dev.device.read`                                                           | `dev.device.control`                                                                                                                                                                                                                   | `device_session`                                                    |
| github        | `dev.github.read`                                                           | `dev.github.write`; merge/push additionally require plan digest and current M11 approval/policy                                                                                                                                        | `repository` or `pull_request`                                      |
| resources     | `dev.resources.read`                                                        | stop and restart require `dev.resources.stop`; stopping a process Adea did not start requires `dev.resources.stopForeign`; settings updates require `dev.resources.configure`; destructive cleanup also requires `dev.cleanup.approve` | target process/port/worktree resource                               |
| cleanupPolicy | `dev.resources.read`                                                        | create/approve/disable requires `dev.cleanup.approve`; evaluate executes nothing                                                                                                                                                       | `cleanup_policy`                                                    |

An operation not present in this matrix is rejected at registration and dispatch.
Read operations still require scope and capability. “Plan” responses contain a
short-lived digest over exact facts; “commit” requires that digest and rejects
changed state.

## Event model

Canonical session events are append-only and sequence ordered:

```ts
type RuntimeEvent = {
  schemaVersion: 1
  eventId: string
  runtimeSessionId: string
  harnessRunId?: string
  generation: number
  seq: string
  occurredAt: string
  receivedAt: string
  source: 'native' | 'acp' | 'authenticated_hook' | 'terminal_fallback' | 'host'
  sourceEventId: string
  confidence: 'authoritative' | 'bounded_projection' | 'untrusted_hint'
  classification: DataClassification
  kind: RuntimeEventKind
  payload: unknown
}
```

Required kinds:

- session/run `created`, `starting`, `ready`, `disconnected`, `resumed`,
  `completed`, `failed`, `cancelled`;
- turn `user_input`, `assistant_delta`, `assistant_message`, `result`;
- tool `requested`, `started`, `progress`, `completed`, `failed`;
- approval/question `requested`, `resolved`, `expired`;
- file/checkpoint/subagent/usage `observed`;
- terminal `command_started`, `command_finished`, `cwd_changed`,
  `transcript_reference`;
- capability `degraded`, `restored`.

Precedence is native/ACP, then authenticated Adea hook for its owned event, then
terminal fallback. A lower source cannot overwrite a higher-source fact. Raw
PTY output, process names, titles, URLs, OSC, and JSON are untrusted input.
Terminal fallback MUST NOT synthesize tool calls, approvals, questions, or
successful prompt delivery.

Event constraints:

- the decoder receives source provenance out-of-band from the authenticated
  transport/adapter and rejects a JSON `source` that differs; terminal fallback
  cannot claim `authoritative` confidence and can emit only bounded assistant
  text or terminal-observation kinds;
- one monotonic `seq` per runtime session generation;
- `sourceEventId` is required on the canonical stored event. Native/ACP/hook
  adapters use the source protocol's stable ID. If the source lacks one, the
  host derives it before append from the source connection generation,
  frame/message digest, and monotonic receive ordinal; terminal chunks use
  terminal sequence. It is never derived from timestamp alone;
- dedupe by `(runtimeSessionId, generation, source, sourceEventId)`. The exact
  same canonical digest is an ignored duplicate; a different digest under that
  key is `idempotency_conflict`, is quarantined, and cannot update projections;
- unknown kinds/versions are retained as bounded opaque records but not
  projected as known success;
- JSON payload maximum 256 KiB, maximum nesting 32, maximum string 64 KiB;
- authenticated hook frame maximum 8 KiB; OSC payload maximum 2 KiB;
- parser rate maximum 1,000 frames/second/session before degradation;
- event page maximum 500; default 100;
- event metadata retention default 30 days, maximum 100,000 events/session;
  older terminal bodies are references to separately bounded terminal storage;
- gaps return `resync_required` with checkpoint anchor; clients never advance
  past an unexplained gap.

## Terminal protocol

### PTY adapter

The adapter uses Bun 1.4 as an execution-runtime API and emits `Uint8Array`;
this does not alter ADR 0008's Vite/Rolldown application build path. Host code
MUST NOT decode before storage or transport. Tests cover fragmented and invalid UTF-8 plus a data callback that
fires before the process wrapper assignment. Renderer decoding is incremental
and preserves split code points without replacing source bytes.

Spawn takes validated `argv`, `cwd`, dimensions, and sanitized environment.
The adapter exposes byte output, write, resize, signal, exit, and capability.
Unsupported platforms return `unsupported_capability`; no silent library or
shell fallback is selected.

### Output and replay

```ts
type TerminalChunk = {
  terminalId: string
  generation: number
  seq: string
  emittedAt: string
  bytes: Uint8Array
}
```

`TerminalChunk` is an in-memory/stream value, not JSON. Durable sidecar history
stores the same bytes in a versioned length-prefixed binary segment with
terminal ID/generation/sequence/timestamp metadata and a segment checksum;
indexes store offsets and lengths, never base64 payloads. Replay reads raw bytes
into `data` frames, preserving every value including invalid UTF-8.

Defaults:

- maximum source chunk before splitting: 64 KiB;
- memory ring: 4 MiB and 10,000 chunks/session, whichever comes first;
- durable terminal data: 256 MiB/session and 2 GiB/workspace, oldest eligible
  session first after retention protection; 4,096 sealed segments/session;
- subscribers: 8/session;
- queued input: 1 MiB/session, then reject with `backpressure`;
- per-subscriber high-water: 1 MiB; a slow subscriber receives
  `resync_required` and the newest checkpoint;
- heartbeat every 15 seconds; unhealthy after 45 seconds;
- reconnect backoff: 250 ms exponential with jitter, capped at 30 seconds;
- checkpoint at most every 5 seconds and at least every 1 MiB while active;
- owner-only directories/files, atomic metadata/checkpoint rename, checksum,
  quarantine on corruption.

For `terminal-bytes-v1` read streams, the host emits a canonical heartbeat only
after the authenticated sidecar answers a current terminal snapshot probe for
the same terminal generation. At most one probe may be outstanding per read
stream; close, resync, exit, generation change, sidecar disconnect, and runtime
disposal cancel its timer. The heartbeat cursor is the latest output chunk
sequence (the empty-stream anchor is `0`); it is not a byte offset and does not
claim that the PTY process is healthy. A read-grant client receives these host
heartbeats and sends only ACK frames; it MUST NOT send heartbeat frames on the
read grant. The generic 30-second SSE keepalive is not terminal liveness.

Attach supplies `sinceSeq`. Covered data replays exactly once in order. When
the memory ring cannot cover `sinceSeq`, a contiguous durable checkpoint chain
that bridges the gap to the ring replays seamlessly (also exactly once, in
order, with subscriber flow-control credit intact); a span that exists nowhere
— retention-pruned or quarantined segments included — never replays partially:
the reply is a resync anchored at the oldest covered sequence, deterministically
derived from live coverage, and the same anchor on every retry. Backpressure
never blocks draining the PTY itself.

The anchor rule covers live streams too: a subscriber that crosses the
per-subscriber high-water mid-stream — or whose cursor the ring has pruned
past — receives a `resync` notice on its live connection (sidecar control
frame `resync { terminalId, subscriberId, checkpointSequence }`; shell stream
frame `resync { reason: 'checkpoint_required', checkpointSequence }`), routed
to the connection that owns the subscriber, sequenced after the last chunk
that subscriber received, and emitted exactly once per gap (the subscriber is
latched until it re-attaches, so fresh credit or new output never produces
duplicate resync storms). The notice is an optimization hint, not a
correctness dependency: it never fabricates bytes, and a client that misses it
still recovers through the durable replay contract above — its next attach
resolves coverage or returns the current anchor exactly as attach time does.
Pinned by `apps/desktop/tests/terminal-manager.test.ts`,
`apps/desktop/tests/terminal-sidecar.test.ts`, and
`apps/desktop/tests/terminal-channel.test.ts`.

### Checkpoint retention and GC

The durable budgets are enforced by explicit GC at durable-write time, not
passive growth. After each atomic segment commit the sink runs one retention
pass: the per-session budget (256 MiB) and the sealed-segment count cap
(4,096/session, the M12 initial default — the byte cap cannot see degenerate
tiny-segment accumulation) evict the oldest sealed segments first, and the
per-scope budget (2 GiB/workspace) evicts the oldest eligible session whole
after retention protection. Caps are named constants exported for tests; a
tightening is allowed, a relaxation requires a spec change.

Eviction preserves the replay contract by construction. Sealed segments
partition a contiguous sequence range, eviction is oldest-first only, and the
newest surviving sealed segment is never removed, so the chain stays
contiguous from its oldest surviving segment forward; a span retention pruned
resolves through the deterministic resync above — the same anchor on every
retry — never a partial replay. A live replay window is protected: the
sidecar reserves the bridge span from `sinceSeq` while a durable bridge
replay is delivering, and a segment covering a live reservation (and
everything newer) is never evicted; eviction is oldest-first or nothing, so
a fully protected scope may stay over budget truthfully instead of breaking
a window.

Deletion is atomic per segment — re-prove containment in the session
directory, rename to a same-directory tombstone, then unlink — so a crash
between rename and unlink leaves a swept tombstone, never a half-visible
segment, and quarantined bytes under the session's `corrupt/` directory are
never GC'd (corruption recovery keeps its raw evidence). Pinned by
`apps/desktop/tests/terminal-retention.test.ts`.

### Sidecar transport writes

The framed unix-socket stream between the shell and the sidecar is a byte
stream: the framing tolerates no lost, duplicated, or reordered byte. Bun unix
`write()` accepts only what fits the kernel send buffer and silently discards
the remainder (it does not queue it), and `socket.buffered` is unusable on
unix sockets — a fire-and-forget write path therefore loses every burst larger
than the buffer and misaligns the framed stream (the M12 packaged evidence
lane reproduced this: 19,838 of 20,000 framed writes lost). Both directions of
the transport consequently write through one serialized, drain-aware pump per
connection:

- writes are FIFO and exactly-once. A write that is not fully accepted
  requeues its unaccepted remainder and pauses until the socket reports
  `drain`, with a bounded polling fallback so a missed wakeup can never stall
  the stream;
- an idle socket writes through synchronously: keystroke-sized interactive
  traffic takes no queueing path and its latency is unchanged;
- the pending queue is bounded (8 MiB per connection by default; the kernel
  send buffer is additional). Exhaustion is explicit, never a silent
  mid-stream drop — that would corrupt the framing: the writer stops
  accepting, reports `queue_overflow`, and closes the connection so the peer
  sees a clean close and can reconnect and resync from durable history;
- the wire format is unchanged. This is write scheduling, not framing;
  existing clients and hosts interoperate byte for byte.

Regression coverage (zero loss, exact order under multi-megabyte floods on the
real socket pair, on both the dev and packaged entries, plus the explicit
overflow behavior) is pinned by
`apps/desktop/tests/terminal-transport-backpressure.test.ts`.

### Sidecar adoption

The sidecar has an owner-only endpoint file containing protocol version,
executable identity, PID/start identity, and an endpoint credential. Adoption
requires credential authentication, expected signed/bundled executable,
protocol compatibility, account/workspace/node binding, nonce freshness, and
session generation. A PID/port file alone grants nothing.

Version handshake chooses exactly one:

- `adopt` for compatible versions;
- `drain_upgrade` for a compatible migration, retaining current sessions until
  detached/exited;
- `incompatible` with user remediation.

The shell's terminal lane adopts its sidecar through one typed seam
(`adoptShellTerminalSidecar` in
`apps/desktop/shell/src/bun/boot-supervision.ts`, plan in
`boot-sidecar-plan.ts`). A packaged boot's spawn belongs to the supervision
engine: the packaged manifest's sidecar command (the bundled Bun runtime
executing the bundled entry) is the engine adapter's argv, so the launch
journal records it for the next boot's reconcile, and the adoption verdict is
the engine's `evaluateAdoption` (name-and-major against the wire protocol).
A repo dev run keeps the dev fallback — the source-tree entry on the repo
toolchain in a positive-allowlist environment. A packaged boot never falls
back to a dev spawn: an unresolvable packaged command leaves the terminal
lane typed-unavailable, truthfully.

Restart loops allow 5 failures in 10 minutes, then stop and surface
`crash_loop`. Window/app close detaches; explicit termination signals only the
owned process group after start-identity recheck.

Entry-side ownership belt (test-infra hardening): a boot on a data dir whose
endpoint record names a live process with the same executable identity and a
matching `ps` start identity supersedes that predecessor — SIGTERM, bounded
grace, then SIGKILL — before binding, and unlinks the stale endpoint and
socket. A record naming a dead, recycled, or replaced process is unlinked and
never signalled. A signalled entry force-exits if its graceful checkpoint
flush exceeds a bounded grace (segment writes are atomic), and a live entry
whose endpoint file disappears (data dir removed under it — the unrecoverable
case: no future adoption can target it, and production cleanup never deletes
a live sidecar's data location) exits through the same graceful path, so a
leaked lane cannot park an unadoptable process — and its PTY children —
behind the test runner's end-of-run child reaping. The packaged macOS test
lanes rely on this belt: `bun test` runs every file on one shared thread, so
a real-process lane must bound its own readiness windows and never leave its
child behind.

### Local stack supervision

The desktop shell is the one supervisor for the bundled local stack (M10
#185): Control Plane, managed Pi, optional Cortana, local drivers, and the
Dev Runtime sidecar all register with the lifecycle below; M12 adapters never
supervise their own processes and M12 adds no second supervisor. The
bundled **component manifest** records, per component, the exact product
version, platform/architecture, artifact digest and signature, app-version
compatibility window, install and data locations, install kind, startup
phase, declared dependencies, health probe, registration protocol, explicit
rollback target, and required/optional flag. The install kind fixes how the
install label resolves: `bundled` labels are bundle-relative and the
packaging lane proves containment + existence + digest against the running
`.app` before the manifest is composed (a failed resolution fails the boot —
the manifest never describes an artifact the bundle does not contain), while
a `managed-data-dir` label is data-dir-relative under the owner-only data
root and resolves with truthful-absence semantics: the artifact is installed
at runtime by its owning lifecycle and may legitimately be absent before the
first ensure — absence is a typed resolution state, never a boot failure and
never fabricated as present (the managed Pi is the registered instance). Its
strict decoder returns
`unsupported_version`/`corrupt_state` instead of guessing; optional
components never gate baseline readiness; incompatible platform, arch, or
version-window combinations fail before execution with an actionable reason;
startup order is sequential by declared phase with dependency refinement, and
a dependency cycle is `invalid_state`.

Supervision rules:

- every start creates a launch record (`processRecordId`, PID start identity,
  executable identity, process group, generation) and is idempotent by key;
- a destructive action rechecks the launch identity immediately before every
  signal. A reused PID or replaced executable is never signalled — the
  supervisor reports `ownership_unproven` and leaves the unrelated process
  running (TM-004);
- a signal is never treated as an exit. Stop and restart wait for OBSERVED
  termination — the PID holds nothing, or holds an identity that no longer
  matches the launch record on start identity, executable identity, and (when
  observable) process group — inside a bounded window with SIGTERM→SIGKILL
  escalation. A stop that stays unconfirmed returns `stop_unconfirmed`, keeps
  the launch record, holds the component in `stopping`, and refuses to start a
  replacement; a later real exit event or operator retry reconciles truth. A
  supervisor restart that finds a persisted launch unadoptable journals the
  exit (`expected`, not a crash) so no launch record dangles adoptable
  forever, and never clobbers a launch it already owns;
- readiness derives health from the probe window at decision time — baseline
  readiness and snapshots compute current health, never a stored heartbeat
  flag;
- an unexpected exit counts against the crash-loop window: 5 failures in
  10 minutes stop automatic restarts and surface `crash_loop`; only an
  explicit operator restart clears it, and the verdict survives app restarts
  through the durable launch/exit records;
- health is orthogonal to state: probe heartbeat default 15 seconds, degraded
  at two missed intervals, unhealthy at `unhealthyAfterMs` (default
  45 seconds); an unresponsive owned process is signalled and recycled as a
  counted failure;
- a component starts only when its required dependencies are running and
  healthy; readiness of required components is the baseline — optional
  components (Cortana) may fail or be removed without breaking it;
- the registration protocol handshake chooses exactly `adopt`,
  `drain_upgrade` (same major version drift; current sessions are retained
  until detached), or `sidecar_incompatible`; there is no PID/port adoption
  fallback;
- launch/exit records persist owner-only under the supervisor's data
  location; corrupt or torn lines are quarantined with raw bytes retained,
  retention is bounded, and rollback/upgrade never deletes component data
  locations;
- every spawn, signal, exit, adoption, drain, and crash-loop decision appends
  to a bounded secret-free audit ring; the snapshot exposes exact packaged
  versions and digests for diagnostics;
- the engine's exit/unhealthy observations also surface as a LIVE typed
  shell-event surface (`supervision.componentEvent` on the shell event bus,
  the same path `git.statusInvalidated` rides): a supervised component's
  crash (`exit`, `expected: false`), restart (`start` with its cause),
  operator/upgrade stop, unresponsive recycle (`unhealthy`), and crash-loop
  verdict (`crash_loop`) are observable by consumers without polling. Every
  payload is engine-authored and secret-free (component id, generation, PID,
  ISO time, bounded detail, coalescing counter). The live surface is bounded
  against crash storms — the durable journal and audit ring are not: per
  component AND kind, at most 5 emissions per sliding 60 seconds
  (`SUPERVISION_EVENT_WINDOW_MS`/`SUPERVISION_EVENT_MAX_PER_KIND`); beyond
  that, events are coalesced (dropped from the bus, counted, and surfaced as
  `suppressed` on that component and kind's next emitted event, so a
  consumer reconciles from the snapshot and journal). The numbers align with
  the restart policy (5 failures / 10 minutes bounds an episode to 5 exits +
  5 replacement starts), so an engine-native crash storm is never coalesced
  while anything faster than the policy cannot flood the stream. The
  composition attaches the sink to the held engine right after every
  recomposition, strictly before the boot steps run any engine action;
- a component child's environment starts from a positive allowlist of host
  keys plus the packaging lane's declared additions — the shell process's
  whole environment is never inherited, so an injected or secret-shaped
  variable cannot smuggle itself into a supervised process — and the
  resolved argv array is handed to the OS verbatim, never as interpolated
  shell text;
- an update rollback is executed, not only planned: the failed artifact is
  quarantined with its raw bytes retained, the explicit staged previous
  install is restored to the bundle location only after it proves complete,
  a missing previous install refuses the rollback (never an implicit one),
  and a refused or failed rollback leaves the install layout unchanged;
  component data locations are never read, moved, or deleted.

This paragraph is pinned by `apps/desktop/tests/supervision-manifest.test.ts`,
`apps/desktop/tests/supervision-supervisor.test.ts` (including the live-event
emission and crash-storm bound tests),
`apps/desktop/tests/supervision-records.test.ts`,
`apps/desktop/tests/supervision-env-contract.test.ts`,
`apps/desktop/tests/supervision-failure-injection.test.ts`,
`apps/desktop/tests/dev-runtime-vault-key-roles.test.ts`,
`apps/desktop/tests/shell-injection-adversarial.test.ts`, and
`apps/desktop/tests/updater-rollback.test.ts`; the packaged supervision
smoke's proofs 5 and 6 prove the same bound and the managed-Pi registration
on real processes.

The one-supervisor wiring is the packaged shell entry's: it loads the bundled
component manifest at boot (strict packaging-lane resolution over the running
`.app`, never a hand-written copy) and composes the engine in through the
composition root's `componentManifest` input, so the shipped shell — not only
the packaged evidence lane — constructs and holds the one supervision engine
(the "Host provider policy (M12 #424)" composition bullet pins the degraded
contract when the manifest is absent). The wiring is pinned by
`apps/desktop/tests/dev-runtime-composition.test.ts` (fixture-bundle boot,
absent-manifest truthfulness, fail-closed install-resolution failures).

The boot reconciles. After the composition holds the engine, the shell entry
reconciles the durable launch journal (`reconcileSupervisionAtBoot` in
`apps/desktop/shell/src/bun/boot-supervision.ts`, serialized across
recompositions): a sidecar launch persisted by a previous app run is ADOPTED
through the full ownership re-proof — PID start identity, executable
identity, and the observable process group, never clobbering a launch the
engine already owns — or journaled as an unadoptable expected exit so no
launch record dangles adoptable forever. The boot step reports its outcome
from durable facts only (the engine's adoption audit joined against the
journal), never throws, and a composition without an engine (no component
manifest, or no verified scope yet) reconciles nothing. Pinned by
`apps/desktop/tests/supervision-boot-reconcile.test.ts` (adopt, unadoptable,
already-owned skip, no-manifest no-op, failure containment) and by the
packaged supervision smoke's proof 4 on real processes.

### Shell integration and input

Wrapper files are content addressed and owner-only. Commands are argv arrays,
never interpolated shell text. Environment starts from a positive allowlist,
then explicit reviewed project additions. Credential values never enter logs or
client DTOs.

OSC 133/7 are accepted as shell protocol observations only through an
Adea-installed authenticated wrapper. Wrapper authentication binds session,
terminal, generation, nonce, event kind, and payload digest. OSC 52 is denied
unless a user explicitly approves the exact clipboard action. Titles, links,
notifications, and cwd URLs are sanitized and bounded.

The terminal pane presents shell-integration truthfully across two separated
evidence channels ("Terminal pane experience"): host-declared wrapper features
and MAC-verified observations prove the authenticated channel — command
blocks, exit codes, and cwd labels render only on it — while standard
unauthenticated OSC 133/7 markers parsed from the display stream are tracked
as their own evidence and never upgrade the presentation. A shell without the
hook degrades to a typed `unavailable` status with its reason, never a silent
blank. The pane's interaction features are permissioned or locally scoped:
selection and copy run through the host's permissioned clipboard seam (#471
substrate) where denial is a typed outcome that degrades the affordance in
place; the search bar is a real in-pane surface with next/previous stepping
and a live match count (no window prompts); links open only through the
consented open path; multiline paste uses bracketed paste with the terminal's
newline confirmation; IME composition and TUI raw-mode key routing keep
full-screen applications in control of every key, with the pane intercepting
only its own explicit shortcuts. Fallback shell selection is typed and
confirmed: a missing or unusable `$SHELL` offers the host's advertised
profiles as an explicit choice — a fallback is never spawned silently, and a
profile without an installed wrapper is honestly marked as running without
shell integration. Pinned by `packages/dev-view/tests/terminal-pane-experience.test.ts`
and `packages/dev-view/tests/terminal-shell-events.test.ts`.

`TerminalInputAuthority` admits one source (`terminal_user`, `chat_user`,
`prompt_delivery`, `browser_takeover`) for one generation. Admission is repeated
after asynchronous yield and before each chunk, so a partial paste cannot cross
an ownership change.

Per-worktree shell history uses relative identifiers under the owner-only
runtime root. Persisted absolute history directories are never deletion
authority. Resolve and revalidate containment/file identity immediately before
history deletion.

Device inventory and harness preference rows use the published `ListRowControl`
composition; harness and activity state labels and dots use `StatusChip`. Device actions,
canonical run facts, preference resolution, and state-to-tone mapping stay in
Dev Runtime adapters.

The right utility pane uses one `SharedDevUtilityHost` in Dev, Chat, and
Virtual. Its rail, heading actions, resize surface, and lazy pane renderers
share the same component and shell-owned context; Dev does not retain a
separate copy of the right utility frame. Closing the panel returns focus to
the corresponding global toolbar opener in every view.

### Terminal UX

The terminal ships a styled default profile using theme tokens for font,
cursor, padding, opacity, and colors; a "system terminal" opt-out leaves the
host terminal untouched.

The mounted terminal surface uses the full width of its split-layout pane;
the surface wrapper adds no horizontal inset around xterm.

The mounted xterm renderer reads the canonical `--terminal-*` roles, including
all sixteen ANSI slots, from its surface. Palette changes update the existing
renderer and search decorations without reattaching its stream or replacing
its output, selection, focus, or editor draft. A bounded ancestor-attribute
observer batches updates into one animation frame and disconnects on disposal.
The same surface projects the shared Code font family and computed size into
xterm. A selected optional web font finishes loading before xterm measures its
characters and refits the existing pane; if that changes its measured columns
or rows, the pane sends the new dimensions through the same generation-bound
`dev.terminal.resize` path used for surface resizes (and only when resize/manage
is enabled). Failed font loads retain the declared system fallback. Replacing
a font choice or disposing the pane invalidates pending font completions.
Typography updates preserve the stream, output, selection, focus, and editor
draft.

A bottom editor supports multiline input, history search, palette sources, and
send-to-active-terminal; pasting multiline or control-character text requires
confirmation. Raw direct-keyboard mode remains available so full-screen TUIs
work without the editor intercepting keys.

When trusted wrapper hooks prove command boundaries (authenticated OSC 133/7),
prompt blocks show the command, cwd, duration, and exit code; a block can be
copied or exported locally. Command boundaries are never inferred from
unauthenticated screen text. Cloud/share links for terminal output are out of
M12 scope until a redaction/expiry policy exists.

Terminal splits use the shared layout tree. Closing a split never deletes its
worktree; closing a pane whose terminal has an active process requires
confirmation.

Warp's command-block implementation is AGPL and remains a prohibited source:
the block UI is implemented independently against the external OSC 133/7
protocol, with no copied hook names, DCS identifiers, payload schemas, parser
structure, fixtures, or UI strings.

## Project registry and scanner

A project binding expresses local intent/defaults for one cloud project; a repo
is an authorized source; a worktree is one checkout; a session binds execution.
None is an alias for another. The register has no project groups and no
project order: the cloud project record owns name, order, and grouping, and
the desktop binds local repositories to it by cloud project id. Project
collapse is `packages/state` UI state (`collapsedProjectIds`), not a host
command; Dev, Chat and Virtual render the same cloud project ids, so they
share that one collapse set.

The add surface supports recent/indexed folders, picker/import, clone URL,
authenticated GitHub selection, monorepo package, and known external worktree.
It displays host, canonical identity, duplicate state, and authorization before
mutation.

The Dev sidebar reaches the add surface from the active workspace header's
"New project" (name the cloud project, then optionally add its repository) and
from a project's "Add repository…" item; Project settings lists the bound
project's repositories through the repository registry. The dialog loads its
form and requests authorized roots only when it first opens. Closing it never
initiates project imports or bootstrap commands. Each confirmed import sends
`{ projectId, rootBookmarkId }`, where the dialog's `mintProjectId` seam
supplies the id of the cloud project being bound; a host without a cloud
project list falls back to a client UUID (the register never mints one). A
successful import records the cloud project's `sourceKind` as `repository`.

Scanner defaults:

- parse declared workspaces/config rather than every `package.json`;
- honor `.gitignore` and prune `.git`, dependency, build, cache, coverage, and
  binary/vendor directories before descent;
- do not follow symlinks;
- maximum depth 16, examined entries 100,000, discovered packages 10,000,
  manifest bytes 2 MiB/file, elapsed 10 seconds per root;
- concurrency 8, cancellation check at least every 100 entries;
- return partial results with `budget_exhausted`, never silent truncation;
- cache by repo/common-dir identity plus manifest/ignore fingerprints;
- recommendations are previews; scanning never executes install/bootstrap.

Watchers coalesce bursts for 250 ms, cap refresh concurrency at 4, prioritize
visible rows, and degrade to explicit refresh plus a 60-second minimum
fingerprint interval. There is no steady per-row subprocess polling.

The scan is providerized as `dev.project.scan` (#398): the canonical root
comes only from the bookmark's fail-closed recheck — the command names a
`rootBookmarkId`, never a path. Results are cached by bookmark identity plus
the manifest/ignore fingerprint; `force: true` rescans, and a changed
fingerprint invalidates the cache. Pagination rides an opaque cursor that
binds the cached fingerprint, so a scan that changed under a paginated client
refuses with `stale_version` instead of mixing pages from two scans. Budget
exhaustion and cancellation return a **successful partial page** whose
`partial: true` and `diagnostics` (`budget_exhausted`, `cancelled`,
`malformed_manifest:<path>`, `missing_workspace_member:<path>`,
`gitignore_negation_unsupported:<dir>`) carry the reason — never a silent
truncation and never a failed command for a successful partial scan. The
scanner parses declared workspaces (`workspaces` in `package.json`,
`pnpm-workspace.yaml`, `[workspace]` in `Cargo.toml`, `[tool.uv.workspace]` in
`pyproject.toml`) rather than assuming every `package.json` is a project,
never follows symlinks, treats a `[workspace]`-only root as a non-package, and
reports malformed manifests as per-entry diagnostics with fallback names.
Import/create/scan replies decode through strict provider-owned decoders
(`Project`, `ProjectScanPage`); a success DTO without its decoder
still fails closed. The sidebar's add surface renders scan results as previews
requiring confirmation — duplicates are flagged against live projects and the
register's bookmark-binding check remains authoritative — and the sidebar's
session rows render the canonical `RuntimeSession` lifecycle from the register
(states outside the historical `active`/`ready`/`archived` set render a
neutral dot with their own accessible name, never a coerced state).

### Clone sources (`dev.project.clone`)

`dev.project.clone { projectId, mode?: 'checkout' | 'managed', remote:
RedactedRemoteInput, credentialRefId?, destinationBookmarkId?, defaultBaseRef? }`
is one operation with two modes. The remote always arrives as redacted parts
(never a raw URL body) and the host rebuilds the URL from them (`github` and
`gitlab` are always https; an `other` host may carry its own `ssh://` scheme,
or `file://` behind the test flag below). The envelope carries no resource (a
binding refuses with `identity_mismatch`), it requires `dev.project.manage`
and `dev.repo.manage`, and the cloud `projectId` must be an unbound lowercase
UUID (`identity_mismatch`, checked again under the binding write). The reply
is the strict `Project`.

- **`checkout` (the default; #1061, #666).** A shallow working copy
  (`--depth 1`, 60 s git-child window) lands at
  `<destination>/clones/<repository>` inside the **authorized destination
  bookmark** `destinationBookmarkId` (required; `invalid_state` without it).
  An existing target refuses `invalid_state`; then the roots authority mints
  the clone's bookmark (labelled with the repository name) and the shared
  import path binds it, so the project gets a primary checkout record and the
  `local_repo` source. `credentialRefId` refuses `unavailable` until vault
  wiring ships for this mode, and `defaultBaseRef` refuses `invalid_state`
  (the checkout's own HEAD is the base). A runner that reports stderr gets
  the shared typed classification below; a bare non-zero exit is
  `spawn_failed`. A stopped clone that left a partial checkout in the user's
  root is reported as `cleanup_partial` and never deleted by Adea.
- **`managed` (remote-only projects).** A hidden bare clone in Adea's
  owner-only app data with worktrees only and no primary record (the
  `remote_only` source); see the next section. It takes no
  `destinationBookmarkId` (`invalid_state`), and a runtime without the
  managed clone authority answers `unavailable`.

**Shared transport policy.** Both modes admit, build, and run the remote
through one module (`projects/clone-policy.ts`):

- **Admission.** The rebuilt URL must be `https://`, `ssh://`, or scp-like
  `user@host:path` (ssh). `file://` remotes and local paths are refused in
  production: a local remote would let a caller copy any repository the user
  can read. Only a composition that passes the test-only
  `allowLocalCloneRemotes` flag admits `file://` (fixture origins); the
  shipped shell (`bun/index.ts`) never sets it, and a test pins that.
  `http://`, `ext::`/`fd::` and every other transport, bare paths, a leading
  `-`, whitespace/control characters, an embedded password, and https
  user-info tokens refuse too — all with `invalid_state` (the contract has no
  separate input-validation code) before anything touches disk. Credentials
  come from a vault reference, never the URL.
- **Argv.** `git -c protocol.allow=never -c protocol.<scheme>.allow=always
clone … -- <url> <target>` through the bounded argv-only runner, so git
  itself refuses any other transport and the URL can never be read as an
  option.
- **Nothing prompts.** Every network git child of either mode (and, for a
  managed clone, its later fetches and the `dev.repo.refresh` probe) runs
  with `GIT_TERMINAL_PROMPT=0`, askpass disabled (`GIT_ASKPASS`/`SSH_ASKPASS`
  empty, `SSH_ASKPASS_REQUIRE=never`), `GIT_SSH_VARIANT=ssh`, and
  `GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=30'`.
  `SSH_AUTH_SOCK` (a socket path) passes through for agent-held keys; secret
  material never enters git arguments, the environment, the registry, a
  reply, an event, or a log. A password or passphrase prompt fails at once
  as `auth_required`; an unknown or changed host key fails at once as
  `remote_unavailable`; a missing repository is `not_found`.
- **Reap before cleanup.** A timeout, cancellation, size, or output kill
  sends `SIGTERM` (so git stops its own helpers), escalates to `SIGKILL`
  after 1 s, and the runner then waits (bounded, 5 s) for the git child to be
  reaped before it rejects with the kill's typed error (never the child's
  exit status). (The reap covers the git process itself; after a `SIGKILL`
  its transport helpers — `ssh`, `git-remote-https` — lose their pipes and
  exit on their own.) Nothing a killed child was writing is cleaned up before
  that.

### Remote-only projects (managed bare clone)

`dev.project.clone` with `mode: 'managed'` creates a remote-only project
(ADR 0011): the code lives only in a hidden, Adea-managed bare clone, worked
on through worktrees, with no primary checkout.

- **Admission.** The shared policy above, plus: `credentialRefId` resolves
  fail-closed exactly like `dev.repo.authorize` (unknown `not_found`, not
  `ready` `invalid_state`, host mismatch `identity_mismatch`) and is recorded
  on the repository, so transport authentication uses the user's own git
  credential configuration. `defaultBaseRef` must be a plain ref name and
  must resolve in the clone (`base_not_found`).
- **Clone.** The clone runs `clone --bare` under the shared argv into a fresh
  owner-only staging directory inside the managed root, then configures the
  remote-tracking refspec `+refs/heads/*:refs/remotes/origin/*`, runs one
  bounded `fetch --prune origin`, and points `refs/remotes/origin/HEAD` at
  the remote default branch. Budgets (limits registry): 10 minutes per
  network child, 4 GiB on disk (a 500 ms size watchdog aborts the child;
  `limit_exceeded`), at most two clones in flight per node and one per
  project id. Failures are typed `auth_required`, `not_found`,
  `remote_unavailable`, `timeout`, or `limit_exceeded`.
- **Cleanup after exit.** Only a confirmed exit lets the failed clone remove
  its staging (or published) directory, through the quarantine/trash path.
  When the exit is unconfirmed, or the quarantine or deletion fails, the
  partial clone stays owner-only in the managed root or its trash
  (`managed-repos/.adea-worktree-trash`, with its provenance record for the
  sweep), the audit log records `repo.managed_clone_discard` `failed` with
  the cause and reason (`child_exit_unconfirmed` or `discard_failed`), and
  the command answers `cleanup_partial` — never a silently swallowed
  leftover. No registry record or binding survives any failed clone.
- **Managed roots.** The clone is published as
  `<dataDir>/dev-runtime/managed-repos/<repoId>.git`; its managed worktrees
  live under `<dataDir>/dev-runtime/managed-worktrees/<repoId>/<name>`. Both
  roots are owner-only (`0700`, current uid) real directories reached from
  the data dir without a symlinked component; neither is a user path, and
  neither is ever covered by a root bookmark.
- **Registration.** The repository registry records `kind: 'git'`,
  `layout: 'bare_managed'`, the raw configured remote (redacted in every
  DTO), `fetchRemote: 'origin'`, `defaultRef` from the clone's `HEAD`, and
  `gitCommonDirIdentity` equal to the root identity (a bare repository is its
  own common dir); it carries no `rootBookmarkId`. The project binding is
  `{ repoId, canonicalRoot, layout: 'bare_managed' }` with
  `defaultBaseRef` defaulting to `origin/<default branch>`, published as
  `dev.project.updated` kind `project.cloned`. **No primary worktree record
  is created** — `ensurePrimaryWorktree` and every repository proof's primary
  reconciliation skip a managed clone.
- **The managed proof.** Bare repositories are refused everywhere else. A
  record is admitted as a managed clone only when its layout is
  `bare_managed` AND the proof holds immediately before every use (worktree
  create/adopt, merge plan, cleanup plan/commit, `dev.repo.authorize`/
  `inspect { refresh: true }`/`refresh`, unbind): the managed root is
  owner-only; the repository is a direct child named `<repoId>.git` for this
  record's id, a canonical real directory (never a symlink, `symlink_rejected`)
  owned by the current user with mode `0700`; it carries a regular `HEAD`
  and `config`, real `objects/` and `refs/` directories, no `.git` entry, and
  `core.bare=true`; and its device/inode equals the record's root identity
  (`identity_mismatch`). A path outside the managed root, a non-managed name,
  or a `..` spelling refuses with `unauthorized_root`/`path_escape`; a
  widened or symlinked root with `dangerous_path`. Every other git record
  must still be a checkout with a `.git` directory (`not_git_repo`).
- **Worktrees.** `dev.worktree.create` derives the base dir for a managed
  clone as its owner-only `managed-worktrees/<repoId>` root (there is no
  user bookmark above it); the service refuses any other base with
  `unauthorized_root`. Fetch, `worktree add`, gitdir backlink proof,
  discovery (the bare entry lists first), merge (ref-level operations in the
  bare repository), and cleanup (`worktree prune`, admin-entry checks, branch
  CAS) all run against the bare directory as both repository and common dir.
  `.worktreeinclude` copying has no primary working tree to read from: the
  step copies nothing and reports `skipped: 'no_primary_working_tree'`.
- **Unbind.** `dev.project.unbind` of a remote-only project runs the usual
  refusals (version, live sessions), then refuses with `cleanup_blocked`
  while any of the clone's worktree records is not `cleaned` or git still
  lists a registered worktree, re-runs the managed proof, and quarantines the
  bare clone into the managed root's owner-only trash
  (`managed-repos/.adea-worktree-trash`, identity-proven on both sides of the
  rename). Only after the binding removal is durable is the proven trash
  entry deleted and the registry record dropped (an empty
  `managed-worktrees/<repoId>` goes too); a failed binding write restores the
  clone. A deletion failure after the commit is `cleanup_partial`: the
  record stays as `unavailable` retained data and the entry keeps its
  provenance record for the trash sweep. Nothing outside the managed roots
  is ever touched; ordinary bindings still never touch files.
- **Classification.** The remote URL, the managed paths, and branch names are
  `workspace_private`: they stay in the device-local registry and never leave
  the device; DTOs carry only the redacted remote. The client projection's
  `source` is `remote_only` for a managed binding, `local_repo` for any other
  bound repository, and `none` for a binding without repositories.

### Root authorization

`dev.project.authorizeRoot` is the production mint path for the authorized
roots the add-project surface consumes. The body names an absolute host path
(and an optional label); the reply is the re-read `RootBookmark`. The roots
authority observes the kind (`repository` when the canonical root contains
`.git`, `directory` otherwise), defaults the label to the canonical
basename, canonicalizes symlinked spellings, and stays idempotent for an
already-active root. Owner consent is proven host-side: the authority records
its own fresh, single-use, action-bound issuance (60-second window) through
the owner-approval ledger immediately before `mint` consumes it, so a caller
can never supply or replay an approval reference and every authorization
leaves durable evidence. The presented path is validated before the issuance
so a refused authorization never strands a ledger entry; the command
capability is `dev.project.manage`.

## Project archive/update and the repository registry

`dev.project.update`, `dev.project.archive`, and `dev.project.unbind` are
served by the durable project/session register. All carry the `project`
envelope resource whose generation must equal the record's optimistic
`version` (projects carry no `generation` field). `update` patches only
`ProjectMutableFields` (preferred runtime node, default base ref, bootstrap
workflow, default harness) under the expected version — names and grouping
are not binding fields — and an archived project is frozen: `update` refuses
with `invalid_state` until the project is unarchived. `unbind` removes the
binding under the expected version and refuses with `invalid_state` while any
non-archived session on the project is live, exactly like archive; it never
touches files — except that a remote-only project's managed bare clone is
removed through the quarantine path once all of its worktrees are cleaned
(see "Remote-only projects (managed bare clone)").
`archive` is a navigation-lifecycle flip only: `archived: true` refuses with
`invalid_state` while any non-archived session on the project is still live
(`preparing`, `ready`, `active`, `disconnected` — archive never stops or
deletes anything), refuses a flip to the current state, bumps the version,
and `archived: false` restores `ready`. All three publish a
`dev.project.updated` shell event (`unbind` with kind `project.unbound`); their
replies decode through the strict `Project` decoder.

`dev.repo.adopt`, `dev.repo.authorize`, `dev.repo.inspect`,
`dev.repo.refresh`, `dev.repo.remove`, and `dev.repo.list` form the
repository registry (a
companion register owning `dev-runtime/repos/registry.json` with the same atomic fsync+rename store,
single-scope validation, and corrupt-state fail-closed behavior as the
project/session authority). A repoId becomes known through the
`Project.repos` binding an import mints; the binding names
`(repoId, rootBookmarkId, canonicalRoot)` and proves nothing on disk. The
canonical root never comes from a command body — it is the binding's or the
durable record's root, and containment is re-proven through the roots
authority's fail-closed bookmark recheck immediately before every proof and
every git read (unknown, revoked, drifted, or replaced bookmarks refuse;
`unauthorized_root` when the root does not cover the repo path). Adopt-time
proof re-derives kind exactly like the #397 registrar (`.git` directory is a
repository, a `.git` file is a linked worktree and refuses, bare `HEAD`
refuses, anything else is a folder), re-stats the replacement-proof directory
identity, and reads canonical git facts locally only: the remote from
`remote.origin.url` config (the configured URL, never `remote get-url`, so
insteadOf rewrites cannot mask the true origin) and the default ref from the
origin HEAD symbolic ref with local `init.defaultBranch` as fallback.

- `adopt { repoId, rootBookmarkId, expectedVersion }` re-proves the binding
  under the named authorized bookmark (a managed bare clone refuses with
  `invalid_state` — `dev.project.clone` registers it and no bookmark covers
  it; its later proofs use the managed proof, see "Remote-only projects")
  and persists the durable record
  (`kind`, identities, redacted remote, `defaultRef`, project ids) with
  lifecycle `ready`. A not-yet-materialized binding adopts at version 1 (the
  initial version every registry record carries); an existing record requires
  the exact current version and persists at version + 1.
- `authorize { repoId, credentialRefId, expectedVersion }` runs the same
  proof, then resolves the vault reference fail-closed (unknown refs are
  `not_found`), requires it `ready`, requires a git repository with a
  configured origin remote, and refuses with `identity_mismatch` unless the
  credential's host equals the remote's proven host. The binding is recorded
  durably on the repo record; secret material never enters the registry, a
  reply, an event, or a log.
- `inspect { repoId, refresh? }` is read-only and network-free: fresh facts
  (`rootIdentity`, `headRef`/`headSha`, `dirty`) are computed from the
  canonical root with bounded local git reads; a vanished checkout reports
  lifecycle `unavailable` in the reply without mutating the record.
  `refresh: true` additionally runs the full proof and persists the canonical
  facts — but only when they actually moved (a proof that changes nothing is
  not a mutation and does not bump the version).
- `refresh { repoId, expectedVersion }` re-proves containment and canonical
  identity and probes the remote offline-safe with a bounded
  `git ls-remote origin HEAD` (10 s/1 MiB; git transport applies any
  insteadOf rewrite itself, exactly like the #397 fetch and #423 remote
  probes). A probe failure is typed truth — the durable record degrades to
  lifecycle `stale` — never a crash and never a fabricated success; a
  vanished checkout persists `unavailable`. A refresh that proves nothing new
  keeps the version. The envelope resource for every repo operation binds
  `repository:<repoId>` at the record's current `version` (a `Repo` carries
  no `generation` field), so a stale client loses before the record is read.
- `remove { repoId, expectedVersion }` is the owner's undo for an unwanted
  adoption (auto or manual): it drops exactly the durable registry record —
  never the project, its bindings, a worktree record, or a byte on disk —
  under the same scope/version/resource discipline as `refresh` (`not_found`
  when absent, `stale_version` on a moved record) and replies with the record
  as it was when dropped. A managed clone refuses `invalid_state`: its
  record is owned by its project binding, and `dev.project.unbind`
  quarantines the clone and drops the record itself. Because adoption runs
  on import/creation only — never as a reconciler — the project falls back
  to the honest binding-only state and stays there until a manual Adopt (or
  a fresh import of a new binding); existing worktree records keep existing
  but their operations refuse `not_found` until the repository is adopted
  again.

The registry is the ONE repository authority (ADR 0011): the worktree
service reads its records (and its test/script `registerRepo` seam writes
them), so a repository adopted here is immediately a source for
`dev.worktree.create` and for the GitHub/GitLab providers. The former
worktree-private `dev-runtime/worktrees/repos.json` is left unread — no
migration. Records also carry `fetchRemote`, the remote name new worktrees
fetch their base from (`origin` for adopted repositories); it never appears
in a DTO. After every proof that persists or re-proves a record (`adopt`,
`authorize`, `refresh`, `inspect` with `refresh: true`) the composition
reconciles the repository's primary checkout worktree record (see "The
primary checkout record").

Replies decode through the strict provider-owned `Repo`/`RepoInspection`
decoders (and the `Repo` page for `dev.repo.list`); a success DTO without its
decoder still fails closed. Git children run through the bounded, argv-only
#397 runner (`LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`,
fixed time and output budgets) — never a shell, never credential material in
arguments or environment.

**Auto-adoption on import and creation.** Binding a project —
`dev.project.import`, `dev.project.create`, or the checkout clone's shared
import path — fires a best-effort, non-blocking adoption of each minted
binding through the exact `dev.repo.adopt` proof (the binding's own
bookmark, initial version 1, the primary checkout reconciliation included).
The command reply never waits on the adoption and never fails with it: a
refused proof (vanished checkout, drifted root, stale race) leaves the
honest binding-only state for the panel's manual Adopt. An archived project
is skipped entirely — this path never mints a registry record for one.
Auto-adoption runs once per binding event; it is not a reconciler and never
re-runs on load or sync, so a removed registry record is never silently
re-adopted — only an explicit import/creation or a manual Adopt proves the
repository again. A repository that already has a durable record is left
untouched (no re-proof, no version bump, no loop).

The Dev View sidebar is the registry's client surface and adds no authority
of its own. The repository panel rides a lazy chunk inside the Dev boundary
and reads the authoritative state through the authenticated command path only
(`dev.project.list`, `dev.repo.list`, `dev.project.bookmarks`,
`dev.repo.credentialRefs`); every reply item passes the strict
`Project`/`Repo`/`RootBookmark`/`CredentialRef` decoders before rendering, and
a success value that fails strict decode fails closed as a registry error
instead of rendering a guessed row. Mutations are explicit user actions:
`dev.repo.adopt` names an owner-picked authorized bookmark (the binding's own
bookmark is the default — a client never supplies a path),
`dev.repo.authorize` binds a vault `CredentialRef` chosen from the refs the
runtime already serves, so secret material never enters the client, and
`dev.repo.inspect`/`dev.repo.refresh` surface the typed lifecycle verbatim
(`stale` and `unavailable` render as states, not errors). `dev.repo.remove`
rides the panel's explicit confirm gate on adopted, non-managed rows — the
confirm copy says the project stays bound and returns to the unregistered
state — so the owner can undo an adoption the auto-adopt flow chose for
them; refusals surface as typed non-blocking notices.
`dev.project.archive` passes the same explicit confirmation gate as the
archive shelf; refusals (live sessions, `stale_version`) surface as typed
non-blocking notices and the view reloads the authoritative state rather
than keeping a fabricated outcome.
A runtime without the registry providers answers `capability_unavailable`, and
the panel renders that typed-unavailable state instead of dead controls.

## Workspace connections

ADR 0012 ("Connections") binds a workspace to credential material the user
already holds on this device. Two kinds exist: **git hosting** (a vault
`CredentialRef` per host — `github.com` or a GitLab host — used for clone,
fetch, push, and pull-request operations) and **harness accounts** (a reusable
`HarnessAccountProfile` per harness family selecting the provider API key a
harness launches with). Bindings and profiles hold ids only; secret material
stays in the credential vault and is unsealed only at a spawn seam.

```ts
type WorkspaceConnections = {
  scope: Scope
  gitHosting: { host: string; credentialRefId: string }[] // ≤ 64, one per host
  harnessAccounts: { harnessId: HarnessAccountFamily; profileId: string }[] // one per family
  version: number // 0 = never written
  availableHarnesses: { harnessId; displayName; accountHosts: string[] }[] // host projection
}
type HarnessAccountProfile = {
  id: string
  harnessId: 'claude-code' | 'codex' | 'opencode' | 'pi'
  label: string // 1..80 printable
  credentialRefId: string
  version: number
}
```

**Storage.** The binding document lives in the workspace's Dev scope
partition: `dev-runtime/connections/workspace-<sha256(scope)>.json`, one
owner-only (0600 in a 0700 directory), schema-versioned file per
`(accountId, workspaceId, runtimeNodeId)` on the shared atomic store (temp +
fsync + rename; an unreadable envelope is retained as `.corrupt-<time>`). A
record that fails strict decode — unknown keys, a duplicate host or family, a
non-UUID id, or a scope other than the partition's own — fails closed with
`corrupt_state` and is never repaired. Profiles are reusable, so they live
device-wide in `dev-runtime/connections/harness-account-profiles.json`, owned
by the local `(accountId, runtimeNodeId)` pair (at most 256), each carrying the
vault scope that holds its credential and a **reverse index** of the scope
digests that bind it. Binding writes the index first, the document second, and
removes the stale index entry last, so an interruption can only leave the
index a superset (a delete is then refused, which is safe).

**Operations.** All six carry no resource binding and re-check the scope
triple (`unauthorized` otherwise):

- `dev.connections.get {}` — the active partition's document (version 0 and
  no bindings when never written) plus the harness families this node can
  launch (managed Pi when ready, then discovered inventory families).
- `dev.connections.setGitHosting { host, credentialRefId | null, expectedVersion }`
  — `host` must be a bare lowercase hostname (`invalid_state`); the version
  must equal the document's (`stale_version` with `currentVersion`). A non-null
  reference must be served by the ACTIVE scope's vault (`not_found` otherwise,
  so another workspace's reference reads as absent), be `ready`
  (`invalid_state`), name the same host (`identity_mismatch`), and not be an
  SSH key (`incompatible`). `null` clears the host. A change bumps the version
  by one; re-applying the current state is a no-op that keeps it.
- `dev.connections.setHarnessAccount { harnessId, profileId | null, expectedVersion }`
  — the profile must belong to this device owner (`not_found`), name the same
  family (`identity_mismatch`), and its credential must be `ready`.
- `dev.harness.accountProfiles.list { harnessId?, cursor?, limit? }` — this
  device owner's profiles, every workspace alike.
- `dev.harness.accountProfiles.create { harnessId, label, credentialRefId }` —
  the reference must be `ready` in the active vault scope and name a provider
  host the family accepts (`claude-code`: `api.anthropic.com`; `codex`:
  `api.openai.com`; `opencode` and `pi`: either), else `identity_mismatch`; a
  duplicate label for the family is idempotent for the same reference and
  `name_collision` otherwise.
- `dev.harness.accountProfiles.delete { profileId, expectedVersion }` — refused
  with `invalid_state` while the reverse index names any binding scope on this
  device. The check reads only the profile store; no other workspace's
  partition is opened.

**Resolution rules.** One seam (`connections/register.ts`) resolves every
credentialed operation against the ACTIVE scope's document only:

1. No binding for the host (or family) is the **device default**: the child
   keeps today's behaviour (keychain, `gh auth`, `glab auth`, SSH agent, the
   harness's own sign-in) and the resolution is recorded as
   `connection: 'device_default'`.
2. A binding resolves its reference through the vault (`audience:
'runtime_driver'`). A binding that cannot be used — revoked, expired,
   missing, unreadable, or a profile whose provider host the family no longer
   accepts — fails closed with `auth_required`; it never falls back to the
   device default.
3. A workspace never reads another workspace's partition, so it can never
   observe, resolve, or borrow another workspace's binding. A profile may be
   bound in several workspaces of the same local account on this device; its
   credential resolves from the vault scope the profile recorded at creation.
4. An SSH remote under a git hosting binding keeps the device SSH agent and is
   recorded as `device_default` with `transport: 'ssh'` (a token cannot
   authenticate SSH).

**Delivery.** The secret reaches exactly one child process through that
child's environment, built at spawn time and never persisted, logged, or
returned: git children (worktree-create base fetch, `dev.git.fetch`, GitHub
push and its `ls-remote` verification) receive an inline, secret-free
credential helper through `GIT_CONFIG_COUNT` whose first entry empties the
accumulated helper list (so a device helper cannot answer instead) and whose
second answers `get` for the bound host only, from child-only
`ADEA_GIT_CONNECTION_*` variables; `gh` children receive `GH_TOKEN`
(`GH_ENTERPRISE_TOKEN` + `GH_HOST` for an enterprise host) and `glab` children
`GITLAB_TOKEN` + `GITLAB_HOST`, keyed by each argv's `--hostname`. Harness
launches deliver the profile's key through the terminal sidecar's
launch-credential allowlist (see the launch transaction below). The repo
registry's offline-safe `ls-remote` probe and ACP lane spawns stay on the
device default in this slice.

**Audit.** Every mutation and every resolution appends a secret-free entry to
the owner-only `dev-runtime/connections/audit-<sha256(scope)>.jsonl` (or the
host-composed authority audit): action, host or family, `connection`
(`workspace` | `device_default`), the resolved reference or profile id, and
the operation. Identical resolutions coalesce inside 60 seconds so read-model
polling cannot grow the trail without bound; failures always record.

**Client.** Workspace settings › Connections (`packages/workspace-ui`,
lazy-loaded like the permissions pane) renders one git hosting row per host
(`github.com`, every bound host, and every non-provider host in
`dev.repo.credentialRefs`) with a credential select whose first option is "Use
device default", and one harness account row per connectable family with a
profile select and "Add account…" (a label plus a vaulted provider key, which
creates the profile and binds it). The desktop bridge
(`apps/web/src/lib/desktop-workspace-connections.ts`, the
`WorkspacePlatformServices.connections` entry) builds commands against the
runtime's authoritative scope and passes every reply through the strict
`WorkspaceConnections`/`HarnessAccountProfile`/`CredentialRef` decoders; a
failed decode is `corrupt_state`. Every change re-reads the authoritative
state. A web-only host has no service and the pane renders a typed
unavailable state instead of controls.

## Worktree lifecycle

The shipped shell composes exactly one worktree service per verified scope
in the Dev Runtime composition root. Session validation
(`dev.session.create` refuses an unknown, archived, or removed worktree with
`not_found`/`invalid_state`), the worktree register, the terminal/files/git/
GitHub resolvers, cleanup-policy facts, and the repository registry's primary
reconciliation all read that one instance.

### The primary checkout record

Registering a git repository (a `dev.repo.*` proof, or the service's
`registerRepo` seam) creates exactly one `kind: 'primary'` worktree record for
the repository's own checkout (ADR 0011). Its `branchRef`/`headRef` come from
`git symbolic-ref HEAD` and its `headSha` from `git rev-parse HEAD` — bounded
local reads only; a detached or unborn HEAD leaves them absent. Later proofs
and the fingerprint-gated `refreshRepo` pass (whose fingerprint stamps the
main HEAD) re-inspect the checkout and persist moved facts at `version + 1`;
the `generation` (the lease/plan fence) does not move. A folder repository
has no primary record, and neither does a managed bare clone (a remote-only
project has worktrees only). The record's `projectId` is the repository's first
bound project; `provenance` is `external` (Adea did not create it), so every
ownership-gated path already fails closed for it.

The primary is represented exactly once: re-registration reuses it,
`adoptWorktree` refuses the primary path and any path that already has a
live record (`invalid_state`). It cannot be archived, merged back, cleaned up
(`cleanupPlan`/`cleanupCommit`/`cleanupResume`), renamed, or deleted — each
refuses with `invalid_state` before any fact is observed. Leases and sessions
bind to the primary like any other worktree.

### Rename and diff summary

`dev.worktree.rename { worktreeId, expectedVersion, title }` sets the local
display title of a `managed` or `external` worktree (the primary refuses with
`invalid_state`). The envelope binds `worktree:<id>` at the live generation;
`expectedVersion` must equal the record's version (`stale_version`). The title
is trimmed, at most 120 characters, and control characters refuse; a blank
title clears it. Rename is metadata only: the version moves, the generation
and everything on disk do not. Titles are `workspace_private` and never leave
the device.

`dev.worktree.diffSummary { worktreeIds: string[]<=50 }` returns
`[{ worktreeId, added, removed, filesChanged }]`, computed with
`git diff --numstat --no-renames --no-ext-diff --no-textconv <base> --` in each
worktree (working tree and index against the recorded `baseSha`, or `HEAD`
when none is recorded — the primary and adopted worktrees). Each child is
bounded (10 s, 1 MiB); untracked files are not counted; binary files count as
a changed file with zero lines. Only counts leave the host — never paths or
content. The batch names its targets in the body, so it takes no envelope
resource (a binding refuses with `identity_mismatch`) and requires both
`dev.worktree.read` and `dev.git.read`. An unknown or out-of-scope id refuses
the whole call with `not_found`; a worktree whose checkout cannot be observed
right now is omitted rather than reported clean.

### Creation

1. authorize canonical repository/common-dir on an eligible runtime node;
2. acquire authoritative per-repo mutation ownership/cross-process lock;
3. fetch configured remote with 60-second default timeout and typed auth/network
   failure; never reset the primary checkout;
4. resolve/display base ref and SHA; allocate collision-safe, never-reused name;
5. run argv-only `git worktree add`; verify top-level, gitdir backlink, common
   dir, canonical path, and directory identity;
6. persist lifecycle fact before subsequent side effects;
7. apply approved `.worktreeinclude` regular files without overwrite;
8. run approved bootstrap argv steps after fresh identity proof;
9. mark ready, acquire terminal lease, then permit harness launch.

`.worktreeinclude` defaults: maximum 1,000 files, 100 MiB total, 16 MiB/file.
Reject symlinks, devices, sockets, FIFOs, destination collisions, tracked-file
overwrite, path escape, or source/destination identity change. Every candidate
and result is reported; list/copy failure fails the step rather than continuing
silently. Secret-like entries (`.env*`, key/certificate/token files) require an
explicit item-level approval and are never inferred.

Bootstrap/teardown approval binds canonical project/repo path, workflow digest,
argv, cwd, environment-key allowlist, and version. Revalidate directory identity
and gitdir backlink immediately before every command. No `shell -c` or command
string. Default step timeout is 15 minutes, output cap 10 MiB, and cancellation
terminates only the step's owned process group.

### Locks and leases

One sidecar is the preferred repository mutation owner. If a filesystem lock is
used, it stores owner process identity, runtime-node ID, nonce, operation,
heartbeat, and acquisition time; creation is exclusive and stale recovery
requires proving the owner process is gone. Default acquisition timeout is 30
seconds, heartbeat 5 seconds, stale consideration 30 seconds. A process-local
promise queue is not sufficient.

Leases heartbeat every 15 seconds and become suspect after 45 seconds, but
expiry never grants destructive deletion. Cleanup must reconcile the owner and
prove it gone or obtain explicit release.

### Worktree names and dependency templates

Worktree names come from one fixed pool shared by the suggester and the
retired-name registry. A name whose checkout was removed is retired forever —
harness session stores key state by cwd — and retirement never evicts: completed
tiers compact into a watermark so a repository stays bounded at roughly one
pool of entries. Suggested names dedupe against live sibling directories plus
every retired name and degrade to `-2`, `-3`, … suffix tiers rather than
recycling. User-typed names that merely end in a spent tier number are never
covered by the watermark. Registration cleanup failure restores the checkout;
only proven removal retires the name.

The per-project dependency-template cache holds one immutable dependency tree
per project under the project's approved data location — never inside a
worktree or the primary checkout. Validity binds package manager, lockfiles,
manifests, and relevant config digests. A matching new worktree materializes
the template through CoW file clones (same rules as `.worktreeinclude`) and
skips the install; a stale or absent template falls back to normal bootstrap.
Promotion is approved, locked (one build at a time per project), audited, and
content-digest-verified at materialization; a promoted template is never
mutated in place, carries no custom ACLs, and rebuilding never touches live
worktrees. Templates appear in the retained-data breakdown (#424) and as
explicit cleanup candidates; clearing one never touches worktrees or the
primary checkout.

### Merge and cleanup

Default merge-back is squash in a temporary detached worktree. The plan records
base/head/target expected SHAs and refuses moved refs. Conflict preserves the
temporary worktree/reference and exact continue/abort instructions. Branch
deletion uses expected-SHA compare-and-delete and only follows successful
integration policy.

`Archive only` changes navigation metadata and nothing else.

`Complete and clean…` preflight blocks destructive steps for dirty/untracked,
unpushed, ahead/behind ambiguity, conflicts, active/suspect leases, unknown or
external active processes/ports, nested worktrees, dangerous/root/home/repo
paths, symlink/non-directory trash root, unproven gitdir/provenance, protected
or default branch, external ownership, or changed plan facts. A plan may list
Adea-owned resources for explicit stop before deletion. Each selected resource
must pass launch/start/generation proof, stop, and post-exit reconciliation;
cleanup remains blocked if any selected resource cannot be proven stopped.

Managed deletion:

1. revalidate path, root identity, gitdir/backlink, provenance, leases, and
   generation immediately before rename;
2. rename atomically to a sibling owner-only Adea trash root;
3. revalidate moved identity/provenance immediately after rename;
4. update git registration; on failure restore or quarantine, never delete;
5. revalidate before deferred deletion;
6. delete only the proven trash identity;
7. persist continuation if a sweep page is capped, until all proven entries are
   processed.

On `dev.worktree.cleanupResume`, the host replays the durable journal and
returns one result for every selected step. A restart in the narrow window
after quarantine's fsynced completion and before the worktree record update is
rolled back only when the journaled trash root, generated entry name, recorded
identity, and missing canonical path all match; the original checkout is
restored and that step is reported as `rolled_back` with the job `partial`.
Any later journaled step, missing provenance, or identity mismatch remains
`recovery_required` for explicit operator handling. Resume never guesses past
an ambiguous side effect.

Multi-file metadata/history changes stage all writes and restore prior disk and
memory state if any commit fails. No deletion error is logged-and-ignored.

## Files and search

The visible Files projection composes the shared UI `Tree`, `TreeRow`, and
`VirtualWindow` contract. The host supplies the complete ordered visible-item
descriptors and owns filesystem/worktree state, expanded paths, activation,
selection policy, and `DevRuntimeService` calls. The shared tree owns treeitem
ARIA metadata, the roving tab stop, arrow-key navigation, and focus handoff for
virtualized rows. Its row-size callback reports each mounted row's actual
border-box block size in CSS pixels; the host uses those measurements for
identity-keyed variable-height range, spacer, and reveal calculations. A focused
row is revealed and mounted before focus moves, while the DOM remains limited to
the viewport, bounded overscan, and the initial measurement slice. Do not assume
a fixed row height: text sizing and zoom may change shared row measurements, and
scroll anchoring must preserve the current item or end position while those
measurements update.

The left utility keeps Files and Source Control as independent panes; their
shared button-group selector is pinned below the pane content rather than
repeating those two destinations in a vertical rail. Browser, Devices, Agents,
and History use the published collapsed SideRail, including its selected
accent and hover/focus labels. Utility separators use the shared resizable
handle with a full-height pointer target and centered grip; their ruler maps
the persisted 240–384 CSS-pixel left-pane range and 240–600 CSS-pixel right-pane
range and remains keyboard operable. An empty layout defaults left utility
panes to 336 CSS pixels and right utility panes, including Browser, to 600 CSS
pixels to fit their lane and viewport controls. This default fills missing
preferences only; saved widths continue through the existing migration and
snap rules, with one tolerant exception: the v0.83.0 build wrote its 512
default into stored documents on first run, so a stored right-side width of
exactly 512 resolves to 600 on decode (the two states are indistinguishable on
disk, so a deliberate 512 also resolves to 600; every other stored width,
including the pre-v0.83.0 448 default, stays verbatim).

Every operation carries scope, live worktree ID/generation, authorized root,
canonical relative path, and expected file identity where relevant.

MUST reject absolute root substitution, traversal, NUL, symlink escape,
reparse/alias escape, devices, sockets, FIFOs, and cross-worktree access. Use
`lstat`/`symlink_metadata` for classification. Revalidate canonical nearest
existing parent, final target identity, and containment immediately before the
system call; when the platform supports stable directory handles, prefer them.

Defaults:

- directory page: 500 entries;
- editable text: 8 MiB;
- bounded read/preview: 64 MiB with streaming metadata fallback;
- operation timeout: 30 seconds;
- CodeMirror tokenization soft budget: 10,000 lines/5 MiB before reduced mode;
- no recursive copy unless an explicit plan enumerates and validates every
  source/destination under limits.

Inline control-path file content is capped at 256 KiB (`dev.files.read`,
`dev.files.write`, `dev.files.create`), matching the control-payload limit.
Transfers above that cap use the `file-bytes-v1` bulk stream:
`dev.files.readStream`/`dev.files.writeStream` return a `DevStreamGrant`
carrying the worktree root resource, expected file identity, byte range, and
(for writes) declared `byteLength`/`contentSha256`. Stream frames obey the
grant's `maxFrameBytes`; a write whose received bytes fail the declared
length/digest is discarded and reports `file_changed`.

Save uses content SHA-256 plus stat identity/version compare-and-swap, then an
owner-only same-directory temporary file, write, fsync file, preserve reviewed
permissions, atomic rename where supported, and directory fsync. Revalidate
before replacement. On mismatch return current identity/digest and no write;
UI offers Reload, Diff, Save As, or explicit Overwrite.

Preserve BOM, supported encoding, per-line mixed EOL, final newline, and
permissions. Invalid UTF-8, unsupported UTF-16/other encodings, binary, and
special files are read-only/refused with explanation; never silently normalize.

Search uses supervised `rg` with fixed argv flags and authorized cwd. Query is a
single argv value, not shell text. Defaults: 10,000 matches, 50 MiB scanned
result budget, 1 MiB emitted result bytes, 30 seconds, 1,000 files with matches;
return partial/budget reason. Cancellation terminates only the owned `rg`
process; it is not exposed to callers, and that is deliberate. A search read is
a bounded page — the caps above, plus the caller's own `limit` and cursor — so
the run a client would want to cancel is already bounded by the budget that
would motivate cancelling it, while a cancel handle would need the command frame
to carry an identity the provider can address and to survive the client
forgetting it. Clients abandon a page by ignoring its reply and issuing the next
query; the provider finishes at most one bounded run. A fallback obeys equal or
stricter limits.

### Shipped provider slice (M12 #399)

The desktop shell registers the control-path files/search operations
(`dev.files.list`, `stat`, `read`, `write`, `create`, `rename`, `delete`,
`copy`, `search`, `openExternal`) plus the bulk-stream grants
(`dev.files.readStream`, `dev.files.writeStream`) and the recursive/overwrite
plan-commit pairs (`dev.files.renameOverwritePlan`/`Commit`,
`dev.files.deleteTreePlan`/`Commit`, `dev.files.copyTreePlan`/`Commit`)
against the worktree service's canonical roots through a narrow
worktree-resolution seam. `dev.files.openExternal` is the one handoff that
leaves the runtime: the caller may name an `applicationId` from the
applications the node reports and a `line`/`column`, an application outside
that list is refused by name (with the available ones in the message), the
opener receives the target as data with no shell in the path, and the reply
carries `position` only when the handoff confirmed it opened there — asking
for a position is not evidence that the editor landed at one. The provider re-proves the gate independently of it:
envelope resource kind `workspace_root`, id, and live generation must match a
registered ready worktree; each `WorkspacePath` must pin that worktree's root
identity (cross-worktree substitution is `unauthorized_root`); the canonical
grammar is re-validated; every symlink component is `symlink_rejected` (final
symlinks are never followed); FIFOs/devices are `special_file_rejected`;
containment is re-proven from the deepest existing ancestor immediately before
each system call. Writes are CAS (`file_changed` carries the current mtime/size
facts, no content) through an owner-only same-directory temp file, fsync,
atomic rename, reviewed-permission preservation, and directory fsync; explicit
`lf`/`crlf` policies never move a BOM. The worktree root itself is spelled `.`
in `WorkspacePath.relativePath` (the only permitted `.` segment); renames and
copies use hardlink-based fail-if-exists so a lost race is `path_collision`
that names the destination, never an overwrite. Search probes `rg` per call and
reports `capability_unavailable` with install guidance when absent; matches,
files with matches, emitted bytes, and the 30-second budget each terminate only
the owned `rg` process. Errors and logs carry identity facts and paths — never
file contents or credentials.

Bulk `file-bytes-v1` stream (gateway attach): the command halves mint
single-use grants bound to the authenticated channel identity, the
`workspace_root` resource at its live generation, and the CAS-pinned file
identity (`readStream` also carries the byte offset/length; `writeStream`
declares `byteLength`/`contentSha256` and is byte-exact — `lf`/`crlf` policies
are control-path-only and refused with `invalid_state`). Grants expire in 60 s
and are consumed by one attach; without a composed full-duplex gateway the two
stream operations stay unregistered and typed-unavailable. The attached read
direction re-proves worktree and file identity at attach and between credit
windows, then pumps `data` frames capped at the grant's `maxFrameBytes`
(64 KiB), with sequence numbers equal to byte offsets and at most 1 MiB of
unacknowledged credit in flight. The attached write direction appends
generation-stamped `input` chunks to an owner-only same-directory temp file,
fsyncs, verifies the declared length and SHA-256 digest, re-proves the pinned
identity, preserves reviewed permissions, and renames atomically into place;
any mismatch, overrun, or post-mint drift discards the temp and reports
`file_changed` — the target is never partially written.

The signed desktop stream relay preserves canonical server `heartbeat` and
`resync` frames. The renderer validates their exact keys, UTC observation time,
canonical decimal cursor within the uint64 range, and registered resync reason
through the same pure
`dev-runtime-control` decoder used by `decodeDevStreamFrame`; rollover calendar timestamps and malformed controls
fail the relay instead of refreshing terminal liveness. This decoder does not
load the operation registry. Outgoing relay commands remain direction-bound.

Client attach (desktop stream relay): the desktop renderer activates the bulk
stream through `DevRuntimeService.streams()` without binding a second
WebSocket — the launch bootstrap is consumed once per page, every handshake
mints a NEW channel, and grants are caller-channel-bound, so a per-transfer
WS channel would be refused (`identity_mismatch`) and would evict the page
channel from `MAX_ACTIVE_CHANNELS`. Instead the injected bridge signs the
attach proof under its channel secret inside its closure (the secret never
crosses into `apps/web` or `packages/dev-view`), and a shell-side relay
(`apps/desktop/shell/src/dev-runtime/stream-relay.ts`, composed in the shell
entry) runs the exact gateway attach contract on the page's own channel:
authority `attachStream` consumes the grant (single-use, 60 s, channel-bound,
replay-protected, capability-gated via the registered-provider check), client
frames pass the gateway's `createStreamInbound` discipline, and the real
registered provider byte-halves pump an in-memory session. Frames cross to the
renderer on the signed event path and return on the signed legacy invoke path
(both bounded control transports; byte-bearing frames carry base64 within the
frame bound, and client frames are delivered strictly in send order). The
shared `createStreamInbound` validator enforces the write direction's
byte-offset contiguity itself (first chunk at the grant's `fromSequence`,
every later chunk at the running offset end) — the relay applies it verbatim
and no longer defers ordering to the provider; the provider keeps its
byte-exact atomic-write guarantees (non-contiguous or overrun input still
discards the temp and reports `file_changed`). The editor and files
flows open/save stream-backed only when the transport binds; absence of the
bridge seam falls back to the bounded control path, and refused binds surface
typed `capability_unavailable`/relay errors, never strings.

Overwrite renames are the one sanctioned clobber and ride an explicit
plan/commit pair: the plan requires an existing destination (a free target
belongs to `dev.files.rename`), pins BOTH identities — the moving source and
the colliding destination named in the plan — and refuses a destination inside
the source directory; the commit re-proves both pins immediately before the
atomic rename. Recursive deletes and copies are bounded plan/commit pairs: the
dry run enumerates every item (depth ≤ 64, ≤ 5,000 items, copy volume ≤ 256 MiB,
per-file 64 MiB) into per-item steps carrying mtime/size facts, refuses any
symlink or special file inside the tree outright (links are never followed
out), and requires an explicit confirmation id for deletes; the commit re-walks
and re-proves the whole tree against the plan (and the destination still free
for copies) before deleting children-first or copying via atomic create-new,
and refuses with `plan_stale`/`file_changed` on any drift. Plans expire after
10 minutes; commits verify the plan digest and are single-use.

Quick-open (#399 residue) is a keyboard-first files-pane affordance:
Ctrl/Cmd+P (or the toolbar action) opens a pane-local picker over the file
paths already loaded into the tree, ranked by a pure fuzzy model — in-order
subsequence matches score consecutive runs, path/word boundaries, and
filename-part hits highest; ties break by shorter path; results are bounded
(20). Selecting a result opens the file through the same identity-pinned
`onOpenFile` path as tree selection; nothing in the picker grants authority.
V1 ranks only loaded paths by design — a prebuilt index over the whole
worktree (paged provider-side) is a future slice.
The picker composes the shared `CommandDialog`/`Command` input and list
primitives for listbox semantics, active-option announcements, keyboard
selection, and focus restoration. Its built-in filter stays disabled so the
files pane's fuzzy ranking and loaded-path boundary remain authoritative.

## Local git and diffs

Git commands run through the per-repo mutation/read scheduler with argv arrays,
`--` before paths, NUL-delimited machine formats where available, locale-fixed
output, bounded time/output, and typed parsers. Filenames beginning with `-`,
Unicode, and newlines remain representable.

Included local operations: status, branch/upstream/ahead-behind, history,
worktree/base/checkpoint diff, stage/unstage file/hunk, explicit discard plan and
commit, local commit, fetch, and namespaced checkpoint refs.

Destructive operations use plan digests and exact path/hunk previews. Checkpoint
restore is never automatic. Patch generation/parsing runs off the UI thread;
large/binary/generated diffs use bounded plain-text/metadata fallbacks.

Remote URLs are redacted before DTO, cache, log, or UI. Preserve full nested
namespace paths; never truncate GitLab subgroups. Embedded user-info is removed.

### Shipped provider slice (M12 #399)

The desktop shell registers the local-git operations (`dev.git.status`,
`history`, `diff`, `stage`, `unstage`, `commit`, `fetch`, `checkpoint`,
`discardPlan`/`discardCommit`, `restorePlan`/`restoreCommit`,
`hunkStagingPlan`/`hunkStagingCommit`) over the worktree
service's canonical roots, through the bounded argv-only runner with
`LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`. Status parses
`--porcelain=v1 -z --branch --untracked-files=all` (unmodified sides are
reported as `.`; untracked entries carry `?`); the compare-and-swap commit
fingerprint is the sha256 of `git ls-files --stage -z`, and a mismatch is
`stale_version` with no side effect. History and diffs use NUL-delimited
machine formats with cursor paging; `diff-tree --root` serves commit diffs;
diff lines carry a renderer budget and truncate explicitly. Checkpoints are
commits built through a temporary index (`read-tree`/`add -A`/`write-tree`
under `GIT_INDEX_FILE`), published as
`refs/adea/checkpoints/<worktreeId>/<checkpointId>` — the branch and the real
index are never touched. Those refs had no lifecycle, so an abandoned worktree
kept every snapshot it ever took; `dev.git.checkpointPrune` is the explicit
bound — it keeps the newest `keep` refs for one worktree, deletes the rest,
and reports both lists by checkpoint id, touching nothing but those refs. Restore and discard are plan/commit pairs whose
envelope resource is validated against the plan's bound worktree and
generation before digest evaluation; discard refuses untracked paths as plan
blockers (explicit deletion stays out of the plan), and restore sources only
the checkpoint ref, never moving HEAD. Fetch reports `for-each-ref` before and
after maps for the named remote and fails `remote_unavailable` with
credential-redacted errors.

Hunk-level staging (#399 residue) rides the `hunkStagingPlan`/`hunkStagingCommit`
pair. The plan body carries structured `DiffHunk` selections (≤ 200) plus a
`stage`/`unstage` direction — the client only NAMES hunks (path plus `@@`
header quadruple), never patch text. The provider re-runs the authoritative
diff over the exact pre-image `git apply --cached` will read (index↔worktree
for `stage`, HEAD↔index for `unstage`), builds the patch by slicing git's own
output verbatim — headers, context, and `\ No newline at end of file` markers
included; hunks the fresh diff cannot locate fail `stale_version` before any
plan exists. The plan stores the exact patch (bounded) with the generation,
index fingerprint, and digest; the commit re-proves generation and index
(`stale_generation`/`stale_version` on drift) and applies the patch offline
through fixed argv (`git apply --cached [--reverse] --whitespace=nowarn`)
with the patch on stdin — never an argv value, never shell text. Dropped
hunks rely on git's context matching; an application failure is typed
`invalid_state`. Commits are single-use and reply with the re-read status.

### Watcher-driven status invalidation (M12 #399 residue)

`dev.git.status` stays authoritative and stateless; the watcher lane makes a
consumer's status cache honest when the tree moves underneath the pane. One
bounded watcher per ready worktree root watches the worktree recursively
through a deprecation-safe handle factory: a platform that cannot watch, or
a handle that errors mid-stream, degrades exactly once to a stat-fingerprint
lane (root/`.git/HEAD`/`.git/index` facts, no subprocess, no traversal)
checked no faster than the watcher/status floor (60 seconds) and only
demand-driven from reads — there is no steady per-row subprocess polling.
Bursts coalesce for 250 ms into ONE invalidation and at most one refresh,
and the named limits live in `STATUS_WATCHER_LIMITS`
(`coalesceMs`, `maxRefreshConcurrency`, `fingerprintMinIntervalMs`).
Refresh concurrency is capped at 4 through a gate shared by a host's
watchers; concurrent refreshes on one watcher dedupe onto the in-flight
read. Everything is generation-fenced: cache entries, events, and in-flight
reads carry the worktree generation they were produced under, and a re-fence
discards results from the dead generation — a stale generation never
publishes. The cache is honest on misses: an invalidated entry is undefined,
never a stale value labeled fresh; a failed read stays empty rather than
publishing stale bytes as current. Status is read only through the injected
`readStatus` seam bound to the provider's public status path — the git
provider itself is untouched.

Constructed in production: the git registrar owns the lane. On every git
dispatch, the live-worktree resolution that already re-proves
scope/generation/lifecycle also reconciles the watcher map: the first ready
sighting constructs and starts the watcher (recursive `fs.watch` through the
production handle factory, the `setTimeout` coalesce scheduler, and one
refresh gate shared by the host's watchers), a moved generation `refence`s
the watcher (the old cache dies with its generation), and a disappeared or
non-ready record stops the watcher and discards it — a watcher's lifetime is
exactly the worktree's live/generation state, with no polling and no second
lifecycle authority. The injected `readStatus` dispatches the REGISTERED
`dev.git.status` provider with a full command envelope pinned to the live
generation, so scope admission, resource binding, and the generation fence
re-run exactly as for an external caller; a typed refusal (a race lost to a
re-fence) resolves undefined and the cache stays honestly empty. Tree-moving
mutations (stage, unstage, commit, discard, restore, hunk staging)
additionally invalidate through the manual lane to skip watcher latency. A
platform that cannot watch degrades exactly once — typed `mode: 'degraded'`
on the registrar's `statusWatchers` snapshot view — and the command surface
is unaffected. Watcher lifecycle events fan out to the shell event bus as
`git.statusInvalidated` (secret-free), and the Dev View consumers mirror the
contract renderer-side: the source-control pane's status cache and the files
pane's marker cache are generation-fenced client caches that go UNDEFINED on
invalidation or a failed refresh — never stale-fresh — and repopulate only
through the capability-checked dispatch. Pinned by
`apps/desktop/tests/git-status-watcher.test.ts` (the unit contract plus the
constructed production lane) and
`packages/dev-view/tests/status-cache.test.ts` (the client contract).

The renderer consumes the invalidations as PUSH, not only as pull (M12): the
desktop `DevRuntimeService` exposes an optional `events()` subscription surface
(`DevEventSubscription`) that delivers `git.statusInvalidated` over the
gateway's existing signed event stream through the bridge's existing
`listen` seam — the bridge contract is not widened. The surface is typed
(`DevGitStatusInvalidated`: worktree, generation, revision, reason),
capability-checked (a scope is subscribed only when its capability snapshot,
read through the authenticated command path, grants `dev.git.read`; a refused
probe subscribes nothing — fail closed), and generation-fenced. SSE payloads
are transport bytes: the surface structurally validates each payload before
delivery and drops a malformed frame rather than trusting it, while tolerating
additive payload fields. Consumers decide through one shared pure predicate
(`pushInvalidationDecision`): a same-generation `tree_changed`/`degraded`
event invalidates the cache and repopulates through the capability-checked
pull, a moved generation re-resolves the worktree context (a re-fence), and
another worktree's event plus the watcher's own `refreshed`/`stopped`
bookkeeping are ignored. A push never carries status bytes, so pull remains
the correctness path; when the event surface is absent — a web non-desktop
runtime, or a bridge predating the listen seam — panes keep generation-fenced
pull unchanged.

The shell bridge's legacy SSE subscription token is event-scoped. The
`POST /__adea/events-token` request MUST authenticate the channel and mint a
single-use token bound to the exact non-empty event name in its JSON body. The
`GET /__adea/events` request MUST present the same trusted origin, channel,
credential, token, and event query value; the authority MUST reject a missing,
expired, replayed, or differently named event before opening the stream and
MUST consume the token before subscribing. After validation, the gateway passes
that validated event value directly to the subscriber. A token minted for one
event therefore cannot be substituted into another event stream.

### Off-thread diff rendering (M12 #677 residue)

The Dev View bundle owns one module worker for the source-control diff pane:
the fetched `DiffHunk` page's grouping into per-file hunk lists and every
hunk's bounded line payload are computed in the worker
(`packages/dev-view/src/source-control/diff-render.worker.ts`) and the pane
renders from the worker's reply. The boundary's contract: the worker is
constructed lazily through an injectable factory; every message is pure data
that survives structured clone; and every failure path — a worker that cannot
be constructed, errors mid-flight, misses its 4-second deadline, refuses the
page, or answers with a malformed frame — degrades EXACTLY ONCE to the typed
main-thread path, which runs the SAME pure compute (`computeDiffRender`), so
the fallback result is identical to the worker's. `render` always resolves
with an outcome that names how it was produced (`worker` | `main-thread`);
there is no silent hang and no unhandled rejection, the surface states the
degraded mode, and dispose answers in-flight renders instead of stranding
them. Keyboard diff flows are anchored on the hunk bar buttons themselves:
j/k move hunk to hunk across file boundaries, n/p move file to file, both
clamp at the diff's edges, modifier chords stay reserved for the workspace
shortcuts, and Enter activates the focused hunk's own stage/unstage button —
no focus-managed layout element. The editor's save-conflict lane is the
UI-lane twin of the provider's compare-and-swap: the surface classifies the
`file_changed` refusal (a live terminal or other external writer changed the
file between read and save), keeps local edits, and offers exactly the two
resolution records — Reload (discard local edits, re-pin to the disk
identity) and Overwrite (re-pin to a freshly observed identity, then retry as
a new CAS) — with the pinned-identity chain continuous across saves.
Pinned by `packages/dev-view/tests/diff-render-model.test.ts` (the boundary
contract, injected duck-typed workers), `diff-navigation.test.ts`, and
`save-conflict.test.ts` (the concurrent-edit flow).

### Canonical byte encoding in proofs

The command-proof canonical JSON encodes a `Uint8Array` body field (the
registry DSL `Uint8Array<=N`) deterministically as the tagged lowercase-hex
string `u8:<hex>`, so byte-carrying commands (`dev.files.write`,
`dev.files.create`) proof byte-identically on both sides of the channel.

## Harness registry and launch

M10 discovery produces installations with stable ID, runtime node, executable
identity/path label, protocol, version, auth state, health, capabilities,
available models, freshness, and update state. Parser inputs are bounded to
1 MiB, 1,000 models/commands, 64 KiB per label/record, and 10 seconds unless the
upstream M10 contract is stricter.

Preferences are versioned by account/workspace/runtime node: enabled, order,
global default, per-project default, preferred AgentProfile/model/options.
Credential values are never stored. A disabled, missing, unauthenticated,
incompatible, stale-unverified, or unhealthy installation is never
auto-launched.

Launch transaction:

1. verify scope, eligible node, ready worktree, generation, and leases;
2. resolve default installation, executable identity/version/auth/capability,
   AgentProfile version, model/options, and resume support, and the active
   workspace's harness account binding for the installation's family
   (Workspace connections: `device_default` when unbound; a bound account that
   cannot be used refuses `auth_required`); a bound account delivered into the
   launch satisfies a `required`/`unknown` native auth state, never an
   `expired` one;
3. idempotently create/attach the canonical `RuntimeSession` and acquire leases;
4. wait for authenticated shell readiness;
5. launch argv/cwd/sanitized environment; a bound harness account adds its
   one provider key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, the sidecar's
   launch-credential allowlist — any other key is refused before spawn) read
   from the vault at this step only, and `run.created` records
   `accountConnection` plus `accountProfileId`/`accountProfileVersion`,
   never the secret. A sidecar older than protocol 1.1 refuses the launch
   (`spawn_failed`) rather than dropping the credential;
6. attach native/ACP, else authenticated hook, else mark terminal fallback;
7. compile the session workspace's memory preamble (ADR 0012) and deliver it
   with the initial prompt through native/ACP, harness API, or guarded PTY in
   that order, recording acknowledgement/provenance;
8. publish status/history.

A timeout/ambiguous acknowledgement does not retry prompt delivery blindly.
The user chooses reconcile/retry after querying session truth. Partial failure
retains ready worktree and terminal.

Changing AgentProfile does not silently select credentials. Changing harness
does not rename the profile. A linked donor persona's inherited provider/model
behavior is not the Adea identity model.

### Harness-in-PTY spawn (attachTerminal)

`dev.session.launchHarness` and `dev.session.launchDefault` accept an optional
`attachTerminal` intent: the harness process launches INSIDE the runtime
session's terminal instead of over a protocol lane. The terminal runtime owns
the spawn and the process; the harness register only binds and observes:

- **Spawn** happens at launch step 5, BEFORE the run record and its
  `run.starting` fact exist: the terminal runtime's harness spawn seam creates
  a NEW terminal bound to the session — the same sidecar `terminal.create`
  path, worktree-resolved cwd, registry and input-authority registration as
  `dev.terminal.create` — whose PTY child is the host-resolved installation
  executable identity alone (`argv[0]` with no extra arguments; never
  renderer-supplied argv, never shell interpolation). The spawned harness is
  therefore a first-class terminal process: listed by `dev.terminal.list`,
  writable through the guarded input authority, and prompt-deliverable
  through the same fenced path as any PTY-backed launch.
- **Binding**: on success the run record carries `terminalId` and
  `terminalGeneration` from birth (the `HarnessRun` DTO fields are the
  wire-visible binding), and the `run.starting` payload records transport
  `pty_process` with the terminal identity. A spawn failure refuses the
  launch with typed `spawn_failed` and fabricates NO run record — nothing
  that never existed is never reported. An `attachTerminal` launch on a host
  with no terminal runtime refuses `capability_unavailable` before any
  record exists. The launch remains idempotent: a repeat launch of the same
  installation/profile returns the live run and spawns nothing.
- **Exit observation** derives later run status ONLY from sidecar-OBSERVED
  terminations (the exited notice). The first notice naming the bound
  terminal is the consumed observation — a terminal exits exactly once;
  notices for other terminals never move the run or consume the
  subscription, and a notice carrying a foreign generation is consumed
  without applying. The observed exit code maps through the canonical run
  machine: 0 → `completed`, non-zero → `failed`, null (the process ended by
  signal) → `disconnected` — a signal is never treated as an exit status. A
  mapping that would be an illegal edge (e.g. `completed` from `starting`)
  demotes to the always-legal `disconnected` with the observed code preserved
  in the transition detail and event payload — never silently rewritten. A
  terminal-state run (cancelled, …) is never overwritten; cancelling the run
  signals nothing — the terminal runtime owns the process, and terminating it
  stays the terminal runtime's confirmed `dev.terminal.terminate` decision.
  Each applied observation appends the canonical `run.*`/`session.*` events
  and mirrors the gate's observed-status publication.

### Initial prompt delivery

`dev.session.launchHarness` and `dev.session.launchDefault` accept an optional
bounded `initialPrompt` (1–64 KiB) delivered as launch step 7. The transport
split is explicit and scoped to the harness kind:

- **PTY-backed launches** deliver through the terminal runtime's guarded input
  authority. The host acquires the session's live terminal as the
  `prompt_delivery` input source at the terminal's current generation — the
  TerminalInputAuthority single-writer contract: an equal-generation takeover
  atomically displaces the current writer (a user's write stream is rejected
  on its next chunk, before the PTY), every chunk is re-admitted against the
  fence so a partial prompt cannot cross an ownership change, and the fence is
  released after the submit. Delivery is ONE bounded submit — the verbatim
  prompt plus a single Enter terminator, written in ≤1 KiB revalidated chunks;
  no shell interpolation, no bracketed-paste rewriting, no retry. It happens
  exactly once per run: the idempotent-launch early return precedes delivery
  and the provenance event dedupes on `host:prompt:<runId>`, so a retried
  launch never re-delivers; reconcile/retry after ambiguity is a caller
  decision.
- **ACP-launched harnesses** never use this path: while a live ACP lane is
  bound to the session, the host hands the prompt to the lane adapter through
  the typed handoff (`lane.deliverPrompt` — run id, session id, connection id
  and expected generation, prompt). The handoff is generation-fenced and
  session-bound like every lane mutation; the lane's protocol delivers over
  the structured transport (native/ACP outranks guarded PTY), and the host
  writes nothing to the PTY input stream. An accepted handoff records ONE
  host `turn.user_input` provenance event (`workspace_private`) whose payload
  carries transport `acp`, the lane's connection id/generation, the delivered
  byte count, and the lane's process identity — never the prompt text, and
  never a harness turn event over the lane's own tier (the harness fabricates
  nothing here; the host fabricates nothing there). A typed lane refusal —
  foreign session (`identity_mismatch`), non-ready lane (`invalid_state`),
  stale generation (`stale_generation`), unknown connection (`not_found`),
  or a driver that implements no delivery seam
  (`capability_unavailable`) — appends a host `capability.degraded` event
  naming the reason. Both facts dedupe on `host:prompt:<runId>`, so the
  handoff, like the PTY submit, happens at most once per run.

Delivery provenance is canonical and auditable: a delivered submit appends an
authoritative host `turn.user_input` event with `workspace_private`
classification whose payload carries the fenced-write provenance (run id,
`pty_input` transport, terminal id and generation, chunk/byte counts) and
never the prompt text — prompt content stays in the control plane only. A
typed non-delivery (no terminal runtime composed, no live terminal for the
session, refused or interrupted fenced write) appends a host
`capability.degraded` event naming the reason. A delivery failure never fails
the launch (partial failure retains the terminal/worktree) and never silently
masquerades as delivered.

### Workspace memory preamble

ADR 0012 memory rides launch step 7. Before the run record exists, the
launch transaction asks the shell's memory store
([local-content.md](./local-content.md), "Workspace memory") for the preamble
of the session's own workspace — `session.scope.workspaceId`, which the
register has already proved equals the authenticated scope; the request body
names no workspace and another workspace's entries are never read:

- **Compile.** The workspace's `active` entries (never `pending` proposals),
  newest first by creation time then id, become one block: a fixed header line
  followed by one `- ` bullet per entry, continuation lines indented. The bound
  is `workspaceMemoryLimits.preambleMaxBytes` — 16 KiB of UTF-8 — enforced over
  whole entries: the block carries the longest newest-first prefix that fits
  and never cuts an entry.
- **Overflow.** When entries are left out the run is created with a typed
  diagnostic, `HarnessRun.diagnostics: [{ code: 'memory_truncated',
includedEntries, omittedEntries, limitBytes }]`, which the launch reply and
  run history (`dev.harness.runs`) carry, and the run's stream gains one host
  `capability.degraded` fact with the same counts (dedupe key
  `host:memory:<runId>`). Overflow is never silent.
- **Delivery.** The preamble leads the initial prompt, separated by one blank
  line, in the SAME single delivery described below — the ordered
  native/ACP → harness API → guarded PTY channel, at most once per run, no
  blind retry. With no initial prompt the preamble is delivered alone. With
  injection switched off for the workspace, or no active entries, nothing
  extra is sent and a launch without an initial prompt delivers nothing.
- **Provenance.** The delivery's `turn.user_input` (or `capability.degraded`)
  payload adds `memoryEntries` and `memoryBytes` — counts only. Neither entry
  text nor prompt text enters an event, a log, or the run record.
- **Failure.** A store that cannot be read injects nothing; the run's stream
  records a host `capability.degraded` fact with code `memory_unavailable`
  and the launch proceeds.

Agent-written memory is a proposal: `dev.memory.propose` (body
`{ runtimeSessionId, expectedGeneration, text }`, text 1–2,000 characters,
`runtime_session` resource required, capability `dev.memory.propose`) is
admitted only while a harness run is active for the session, re-checks scope,
resource binding and generation like every session-bound operation, and
stores the text as a `pending`, `agent`-sourced entry of the session's
workspace. Its reply, `MemoryProposalReceipt { memoryEntryId, status:
'pending', createdAt }`, never echoes the text; the pending bound refuses
`limit_exceeded`, a host without a memory store refuses
`capability_unavailable`, and the audit trail records the entry id and
outcome only. A proposal becomes memory only when the user accepts it in
Workspace settings › Memory.

### The managed Pi installation lifecycle

The managed Pi driver (issue #31) owns exactly one thing: putting a verified,
pinned managed Pi installation into an Agent HQ-owned location under the app
data dir so a clean supported desktop reaches a healthy managed Pi
RuntimeConnection with NO manual Pi installation required — and reporting that
installation truthfully. It owns no model routing, no profiles, no prompt
handling, no compaction, no context injection, and no task planning: those are
decision-layer (control-plane) concerns; the harness retains only its internal
loop and local context/tools. The driver's public surface is `status()` (a pure
projection of the durable record — it never probes or mutates) and
`ensureInstalled()` (idempotent install-or-verify); anything else on the wire
is a decision-layer authority this lane does not carry.

Pinning is deterministic and build-time: the pinned version, its archive
SHA-256 digest, and the release URL are constants replaced together by the
packaging lane (the Runtime Compatibility Matrix records the combination).
The URL embeds the exact pinned version — the driver never asks a server what
"latest" is. Source resolution is strictly ordered: "already installed at the
pinned version" → bundled archive (packaged app dir) → data-dir cache → one
bounded fetch of the pinned URL. A network download is hard-capped, deadline-
bounded, and persisted into the cache only AFTER it passes digest
verification, so the cache holds only verified pinned archives and a
re-ensure never refetches. Every install writes a staging directory and
atomically renames into place; a failed install/update rolls back to the
previous managed installation, and user-managed Pi locations are never read
or written.

The typed failure matrix (every failure is a recorded durable driver state
carrying the contract code — never a crash, a fabricated installation, or a
fake success):

| Condition                                                       | Code                     | Retryable |
| --------------------------------------------------------------- | ------------------------ | --------- |
| Host has no managed Pi build                                    | `capability_unavailable` | no        |
| No source at all (no bundle, no cache, nothing to fetch)        | `capability_unavailable` | yes       |
| Network refused / unreachable / empty body                      | `unavailable`            | yes       |
| Pinned endpoint answered non-OK                                 | `remote_unavailable`     | yes       |
| Download exceeded its deadline                                  | `timeout`                | yes       |
| Download exceeded the hard byte cap                             | `limit_exceeded`         | no        |
| Archive bytes failed the pinned digest                          | `corrupt_state`          | no        |
| Source declared a version other than the pin                    | `incompatible`           | no        |
| Bun runtime older than the desktop lane floor (fetch path only) | `incompatible`           | no        |
| Install write failed                                            | `unavailable`            | yes       |

The Bun runtime-version guard (adea#490) applies to the network fetch path
only: the fetch refuses to run on an older or unknown runtime, while bundled
and cached sources still install.

Version drift is detected, never assumed away: a `ready` record is a cache
hit only when the on-disk installation still declares the pinned version in
its manifest (a missing or mismatched manifest is drift). A drifted
installation is healed by reinstalling at the pin; a failed heal is a typed
refusal naming the drift (`incompatible` when no verified source is
available), and the record never keeps claiming `ready` through a failed
heal.

The driver never breaks the shell boot: construction is synchronous and
non-throwing, every `ensureInstalled` failure is typed, concurrent calls
share one in-flight install (single-flight), and the composition-level boot
warm is an explicit opt-in that fires one best-effort `ensureInstalled` after
the harness register is up — never awaited, its every failure recorded as the
driver's durable typed state. The warm never runs for a scripted (injected)
driver. `dev.harness.managedPiInstall` remains the explicit command path with
the same typed contract; the launch path treats a non-ready managed
installation as the typed gap carrying the install remediation.

The managed Pi is also a registered **component of the packaged manifest**
(#185 follow-up, "Local stack supervision"): the manifest entry carries the
driver's build-time pin (pinned version, pinned archive digest — the
installed executable is the digest-verified archive bytes written verbatim),
a `managed-data-dir` install kind with the data-dir-relative install label,
the process health probe over the engine's own launch, startup phase 1, no
adoption protocol (the driver owns install and the launch path, so there is
nothing for the sidecar handshake to adopt), and the optional flag — it never
gates baseline readiness. The ownership boundary is unchanged: the DRIVER
owns install (the engine never installs, never fetches, never touches
user-managed Pi locations); the ENGINE observes and starts per policy. Before
the first successful ensure the component is truthfully ABSENT — its
install-location resolution reports typed absence, the engine holds and
reports it like any component, and a start attempt fails typed
(`spawn_failed`) without burning the crash-loop budget (spawn failures never
count as crashes). A drifted on-disk artifact is surfaced truthfully as a
digest mismatch in the resolution; healing stays the driver's job.

### Launch orchestration, preferences, and the root default

Preferences are the user-expressed overlay on a runtime node, stored per
account/workspace/runtime node keyed by stable harness-installation ID (plus
an optional project scope for per-project defaults). A preference records
enabled, order (`sortKey`), default, and optional preferred profile/model;
credential values do not exist in the model and are never persisted. A
disabled harness is never auto-launched.

Root-default policy (owner decision, 2026-09-16): on a **clean desktop** — no
stored preference of any kind — the effective preference list synthesizes
**managed Pi as the enabled global default** from the ready managed
installation; nothing is written until the user expresses a preference.
Discovered user-installed harnesses enter the ordering only through user
action. `dev.harness.preferenceReset` clears the stored overlay (scope-wide,
or per project), so the managed-Pi-first projection returns.

`dev.session.launchDefault` resolves the launch candidate in strict order —
project default (enabled), then global default (enabled), then the managed-Pi
root default — and requires an explicit AgentProfile from the caller; the
model resolves as explicit body → preference default → the harness's own
default. An explicit default that names an existing but unlaunchable
installation (auth not ready, unhealthy, missing) refuses with that typed
reason and never silently launches a different harness; with no resolvable
default the typed `capability_unavailable` carries the managed-Pi install
remediation. Launch is idempotent (the same installation/profile on a live run
returns that run), fenced to one active run per session, and emits
`run.created`/`run.starting` canonical events. `dev.harness.preferenceUpdate`
creates records addressed as version 0 and fences updates by optimistic
version (`stale_version`); setting a default clears its sibling defaults in
the same scope slice.

### Observed run status

Run status transitions follow the canonical machine (see "Runtime session and
harness run") and are applied only from OBSERVED facts — the gate operation
`dev.harness.runStatus` (scope + `runtime_session` resource + generation
fenced) records each transition with its source
(native/ACP/authenticated-hook/terminal-fallback/host) and observed time,
mirroring the supervision discipline: a signal is never treated as an exit and
an unknown protocol response never becomes success. Same-state re-observation
is an idempotent replay that changes nothing; illegal edges refuse with
`invalid_state`; terminal states refuse re-observation with
`already_completed`; terminal transitions stamp `finishedAt`. Legal
transitions append the matching `run.*` (and session-lifecycle) canonical
events so Dev and Chat observe the same fact through the same stream. The
per-run transition journal is host-side diagnostic history bounded at 50
entries and never crosses the wire inside the `HarnessRun` DTO.

### Run history retention

`HarnessRun` records persist durably per scope with a target of 200 total
records. When that target is exceeded, the oldest terminal runs are evicted
first; active runs are never evicted, so the store can exceed 200 while more
than 200 runs remain active. History reads
(`dev.harness.runs`) are newest-first with bounded pages (default 100, maximum 500) and an opaque cursor. Resume remains
resume-as-new-generation under the same canonical `RuntimeSession`. The
registry is one shared file for every scope on the device; a write replaces
only the writing scope's records and carries every other scope's records
through unchanged, so a workspace switch never erases another workspace's run
history.

### Cross-workspace run summary

`dev.summary.workspaces` (capability `dev.summary.read`, no resource, strict
empty body `{}`) answers `{ items: [{ workspaceId, running, needsInput }],
observedAt }` for ADR 0011's collapsed workspaces and "Needs you" strip. It is
a pure fold over the shared run registry:

- only runs whose scope has the active scope's `accountId` AND
  `runtimeNodeId` count — another account's or node's runs never appear;
- `resolving`/`starting`/`working` count as `running`;
  `awaiting_input`/`awaiting_approval` count as `needsInput`; terminal states
  and the `unknown` holding state count as neither;
- archive state lives in each scope's authority partition, which this read
  never opens. Runs of the active scope are filtered through its own,
  already-open authority (archived or unresolvable sessions are excluded);
  another workspace's runs are counted by run state alone. Archiving a
  session does not cancel its runs, so a sibling workspace's archived
  session with a live run still counts until that run reaches a terminal
  state;
- items are sorted by `workspaceId` (code point), contain only workspaces
  with at least one counted run (absent means zero), and are bounded at 256;
  the strict reply decoder rejects unknown keys, duplicate or non-UUID
  workspace ids, and negative or fractional counts.

The command itself is still scope-admitted for the active scope only; a
sibling workspace's id is returned as data and never becomes an authorized
scope. The read writes nothing. The client helper `workspaceSummaries()` in
`apps/web/src/lib/desktop-dev-runtime.ts` is a one-shot pull that fails
closed to `undefined`; the consuming UI owns polling cadence.

### Desktop harness notifications

The shell may request a generic desktop notification when a canonical durable
`run.status` transition enters `awaiting_input`, `awaiting_approval`, or
`completed`. It compares the durable run snapshot before and after the event;
initial composition and non-status events do not notify. The selected
non-archived runtime session is an ephemeral presentation hint sent through
the signed legacy invoke channel. It is revalidated against the current
authenticated host projection, and never grants input authority. A focused
desktop window with a selected runtime session suppresses notifications. The native
request contains only the fixed title `Adea` and body
`A conversation needs your attention.` — no IDs, display names, prompts,
paths, or tool output. A missing or throwing host API is ignored after the
durable transition; an API call returning records only a request, not proof of
user-visible delivery. Composition changes dispose the old observer and seed
the new one from existing history, preventing old runs from replaying. A same-scope
host recomposition preserves the selected-session hint only if the new host
projection still validates that non-archived session; a scope change or invalid
session clears it before the replacement observer can use it.

The shared derivation is exported from the narrow
`@adea-ai/dev-view/chat/notifications` subpath and depends only on Dev Runtime
DTO types. The desktop shell may import this pure host contract, but must not
pull the Dev View UI barrel into its main-process graph. The desktop boundary
test bundles the production notification entry and rejects UI, styling, and
browser modules.

### The runtime-events-v1 stream

`dev.session.events` mints a read-direction `runtime-events-v1` stream grant
through the channel authority against the CALLER's authenticated identity —
bound to channel, scope, resource generation, single-use at attach, and
expiring — the same pattern as `dev.browser.attach`; archived sessions keep
their history readable (only the generation binding must hold). The stream
serves the canonical event log: append-only, sequence-ordered per (session,
generation) with canonical uint64 `seq`; dedupe on
`(runtimeSessionId, generation, source, sourceEventId)` where the identical
event is an ignored duplicate and a different event under the same key is
`idempotency_conflict`; bounded retention (oldest dropped first per session in
generation-aware order — 1,000 events/session, 5,000/scope); reads are bounded ascending windows
(page maximum 500, default 100). The host appends `session.*`/`run.*`
lifecycle facts (session created via the register's publishes; run
created/starting/resumed/cancelled; observed status transitions) as
`authoritative` host events with `workspace_metadata` classification; harness
turn/tool/approval events arrive only through their own tiers and are never
fabricated here. At attach the handler replays at most the newest 500 events
of the granted generation from (or after) `fromSequence`. When that bound
raises the actual replay floor above the requested cursor, the handler emits a
`resync { reason: 'checkpoint_required', checkpointSequence }` frame naming
that floor before the CBOR `data` frames. It then streams live
append-matched events, accepts only `ack` control frames, and closes
`stale_generation` when the session moves to a newer generation — grants
minted under an old generation are inert, never ambiguous.

## Browser and device lanes

Kinds:

- `human_embedded`: an isolated context in Electrobun's bundled CEF, which also
  renders the shell; no automation grant;
- `task_owned`: a separate Bun 1.4 `Bun.WebView`, persistent per-task owner-only
  profile, supervised by the authorized host. It may use macOS WebKit or a
  dedicated local Chromium/CDP target as ADR 0006 permits; it is not the shell's
  CEF context and cannot share its profile;
- `user_context`: dedicated external Chromium over CDP, explicit per-origin
  grant, mirrored screencast and visible takeover.

A real-browser extension is out of M12 scope. Each lane displays kind, runtime
node, profile label, automation owner, takeover, and recording state. Lane and
profile IDs are immutable; generation increments on ownership transfer.

Navigation permits `http`/`https` only. Resolve and revalidate DNS/IP before
connection and after redirects; block cloud metadata, loopback privileged
routes, Unix sockets, private/LAN ranges unless the selected target is a proven
Adea-owned loopback service on that runtime node. Redirects repeat policy.
Policy is provider-controlled, never engine-controlled: the lane engine must
obtain admission from the provider before opening every connection — the
initial URL and every redirect target — and may connect only to the freshly
resolved addresses that admission was computed on (DNS is re-resolved per hop,
so rebinding between hops is refused). A redirect chain is bounded and a loop
back onto an already-visited hop is refused. An engine-reported final URL is
never trusted: the provider verifies it against its own admitted-hop ledger
and reports the last admitted URL; an engine that lands elsewhere or bypasses
the gate fails closed (lane crashed, typed `ssrf_blocked`).
Downloads/uploads, clipboard, camera, microphone, geolocation, notifications,
popups, and certificate exceptions are lane-specific and default denied.

The browser pane sends URL entry, port-preview selection, and reload through
`dev.browser.navigate`, binding the request to the selected lane and its current
generation. A port-preview row must pass the host's Adea-ownership and listening
checks, then navigate its explicit requested URL; it must not depend on URL-field
focus or substitute a target-list refresh. The current operation contract has no
back/forward history commands, so those controls remain disabled and must not
present a target refresh as browser history.

The browser pane's DOM inspector uses an explicit CSS selector against the
active page target. It sends `dev.browser.inspect` with the selected target ID,
the lane's expected generation, and a lane-resource binding; it does not claim
to pick an element from preview pixels. A returned inspection may show the
element role, accessible name, and bounds. Selector-based DOM inspection is
separate from screenshot display, coordinate annotation, and live frame
subscription. Results are cleared when the lane, target, selector, or emulated
viewport changes. The current caller/transport gap and bounded amendment are
recorded in the [browser caller gap note](../research/dev-browser-caller-gaps.md).

The BrowserPane screenshot action binds `dev.browser.screenshot` to the
selected lane generation and current page target. It may display only metadata
from the returned `ScreenshotRef`: reference ID, dimensions, content type,
expiry, and the exact host-provided `redacted` boolean. The caller does not
request or display screenshot bytes. Runtime instance, scope, session, lane ID
and generation, target/navigation, or emulated-viewport changes clear the
displayed result and make pending success and error replies inert; unmount does
the same for pending replies. This metadata-only result is not a pixel preview
and does not authorize rendering bytes when `redacted` is false. Annotation
still has its separate control capability and provenance contract.

Cookie import is opt-in, source/profile/origin scoped, previewed, encrypted at
rest, and atomic: any write/cancel failure rolls back the whole import. Maximum
10,000 cookies and 16 MiB serialized input. Preserve partition/SameSite
semantics. Cookie values never enter events/logs. Reset cannot affect the
user's normal browser profile.

Screencast defaults: 15 FPS, maximum 30; maximum 4096×4096 and 8 MiB/frame;
one in-flight plus one newest complete frame; input maximum 240 events/second;
resize/takeover/input carry lane/session/generation/viewport sequence. Stale
subscriptions and old input are inert. Escape always releases human capture.

Human input reaches the lane through `dev.browser.input`, which returns a
`DevStreamGrant` for a write-direction `browser-frames-v1` stream bound to the
lane resource and generation. Input is admitted only while the lane's
automation owner permits the caller: a `human_takeover` lane accepts the
controlling user's input, a `task_owned` lane accepts input only within the
owning task's grant, and `none` rejects input. Ownership transfer increments
the generation, so input granted under an old generation is inert.

The `browser-frames-v1` handler may receive a valid stream grant immediately
after lane creation, before navigation or screenshot has provisioned a view.
The host resolves the lane from its registry, provisions the owner-scoped view
at stream attach, and checks the lane generation again after asynchronous setup
before publishing frames. A missing lane, stale generation, or failed setup
closes the stream with a typed refusal; a valid first attach is not treated as
stale merely because no view existed yet. The handler installs the stream's
close cleanup before provisioning begins, so a socket that closes while the
view is starting cannot acquire a subscriber after setup completes; an
authoritative generation change during that window also refuses the attach.

The packaged browser engine uses Bun 1.4 `Bun.WebView` with the Chrome/CDP
backend for task-owned and user-context lanes. Each view requests an
owner-only persistent `dataStore` directory derived from the immutable lane
profile identity; the shell's bundled Electrobun CEF window is never reused.
Because Bun's Chrome backend currently shares one Chrome process (and therefore
one process-level data store) across views, production cookie/profile
isolation still requires the packaged host to provide a process-per-lane CDP
adapter or an equivalent CEF profile boundary; this engine does not claim that
acceptance evidence yet.
The engine enables CDP `Fetch.requestPaused` for document requests before
navigation. It calls the provider's admission hook for the initial request and
each redirect, continues only admitted URLs, records console and failed-network
diagnostics, and fails closed when the view reports a navigation error. CDP
`Page.captureScreenshot`, DOM inspection, viewport emulation, and
`Page.startScreencast` provide the live host surface. Screencast publication
uses the one-in-flight/latest-frame bound and sends `video` frames through the
authenticated `browser-frames-v1` stream; write frames decode only bounded
CBOR input controls, and Escape invokes the generation-fenced release path.

The current Electrobun 2.0.1 shell declaration exposes only `BrowserWindow`;
it has no BrowserView/CDP handle for the human embedded CEF context. The
engine therefore keeps that context isolated and does not claim a CEF target
until the packaged host exposes an authorized BrowserView seam. Packaged
macOS CEF evidence remains a required #537/#426 acceptance gate.

When the CDP target contains iframes, `Page.getFrameTree` supplies child-frame
targets and `Page.createIsolatedWorld` gives selector-based inspection a
frame-specific execution context. `dev.browser.inspect` can therefore query
same-origin and cross-origin iframe DOM through the authorized CDP target
without injecting a page script. This host operation does not provide
preview-pixel click picking. Screencast frames remain compositor output for the
whole page; they include iframe pixels but carry no separate iframe byte
stream. A future requirement for per-frame capture or frame-specific redaction
needs a host adapter that exposes OOPIF capture identities and coordinate
transforms.

Profile directories remain immutable and owner-only, but Bun's Chrome backend
does not expose a process-per-`dataStore` guarantee. The engine refuses to
reuse a lane directory while it is alive; this is useful lifecycle protection,
not proof that two Chromium profiles cannot share process state. Packaged
acceptance still needs an independently supervised browser process per lane or
an equivalent CEF profile boundary before cookie/profile isolation can close.

Screenshots/annotations carry origin, viewport, time, lane/profile, and
redaction provenance; maximum 25 MiB each and workspace retention limits apply.
Browser page content cannot invoke Adea commands through origin or loopback.

Responsive emulation is always available. iOS uses verified `xcrun simctl`
inventory; Android uses verified `adb`/emulator inventory. Commands use fixed
argv templates and inventory IDs. Starting/stopping is explicit, and Adea stops
only a still-identity-matching process it launched. Physical devices require a
separate pairing/grant.

## Computer use lanes

A computer-use lane is the one supervised surface through which an agent
harness may view the execution host's real desktop (bounded screen frames) and,
where separately consented, synthesize keyboard input. The lane is a
session-scoped grant: it is created for one `runtimeSessionId`, dies with that
session (closure revokes every outstanding consent and frame/input stream), and
never becomes a global permission. Lane and consent IDs are immutable; the
generation increments on every ownership or authority transfer, and input or
capture authorized under an old generation is inert — dropped without error,
never executed.

Lane states: `idle` (created, no live authority), `granted` (a consent record
is active and the permission state behind it still holds), `suspended` (human
takeover), `closed`, `crashed`. `automationOwner` is `none`, `agent`, or
`human_takeover`. `dev.computeruse.takeover` suspends agent input instantly and
increments the generation; `dev.computeruse.release` is the Escape path and
returns authority to the base owner with a new generation. Closing the lane is
the kill switch: input authority is revoked immediately, in-flight captures
stop at the next publication boundary, and stale-generation input is inert.

The authority gate fronts every operation and re-derives every decision from
facts it owns — the provider trusts no engine, harness, or caller claim:

1. the M10 channel gate (identity, proof, replay, expiry, capability set,
   scope shape) has already passed;
2. the lane exists and belongs to the command's
   `(account, workspace, runtime node)` scope — the scope binding is the
   runtime-node authority, never a session string alone;
3. the command's `expectedGeneration` equals the lane generation;
4. the lane's automation owner admits the principal (`human_takeover` accepts
   only the controlling user; `none` accepts nothing);
5. a consent record ties the operation to the #471 permissions substrate: the
   record is issuance-backed (created by `dev.computeruse.consent` with an
   owner confirmation, mirroring the owner-approval verifier's fail-closed
   semantics), scope/lane/generation-bound, single-use, and expires within
   60 seconds; a consumed, expired, wrong-scope, wrong-generation, or
   forged record refuses. The consent request carries only the owner
   approval's `reference` — never the scope, action, or validity window —
   and the gate resolves that reference inside the `authorize computer-use
input` action and scope against the shared durable owner-approval ledger.
   A reference no owner prompt ever issued has no issuance record to consume
   and refuses, so a caller — including any authenticated channel holding
   `dev.computeruse.control` — cannot mint input authority for itself. The
   permission state is settled first, so a denied host returns its Settings
   remediation rather than an approval-shaped refusal, and a request that
   could never be granted does not burn the owner's confirmation;
6. the permission state behind the record is still fresh: input requires the
   accessibility probe to report `granted`, and the gate re-probes through the
   permissions service when its snapshot is older than the record's window. A
   permission that moved from granted revokes admission immediately; a probe
   that cannot answer refuses admission — it never defaults to allowed.

All capture and input execute through the authorized fixed-argv host-tooling
path with launch/audit records; free argv elements never come from caller
text. No synthetic input ever originates from browser context: input reaches
the lane only as `desktop-frames-v1` write frames minted by
`dev.computeruse.input` from an authorized execute reply against the caller's
authenticated channel identity, and every frame is re-admitted through the
same gate with per-submission sequence and the lane's hard 240-inputs/second
rate cap before the engine may inject anything.

Screen frames inherit the screencast rules: 15 FPS default and 30 maximum,
4096×4096, 8 MiB per frame, one in-flight plus one newest complete frame, and
stale generations/sequences are inert. Frames carry
scope/lane/generation/sequence provenance, are classified before leaving the
host, and inherit workspace screenshot retention when attached to the
canonical session.

Frame publication (issue #624) is the read direction of `desktop-frames-v1`.
A read attach is gated on a FRESH screen-recording preflight answer: capture
that cannot be proven closes the stream typed (`revoked` for a refused or
unanswered prompt, `incompatible` for an unanswerable probe) and no frame is
ever fabricated — the capture tool itself cannot detect a missing grant (it
exits 0 and produces wallpaper-only frames), so the preflight is the only
honest gate. When the preflight proves the grant, the publisher captures the
main display through the macOS `screencapture` host tool (fixed argv, engine
generated temp path), parses the PNG dimensions, and enforces the bounds
before the pacer sees a frame; an over-bounds capture is a typed refusal
(downscaling is not available in this lane), never a silent shrink or drop
into a placeholder. Observation rides the lane's authority fences: a live
consent record is required (publication never consumes the single-use record
— consumption mints input), and every publication tick re-derives lane state,
generation, automation owner, and the consent's permission digest, so a
takeover or kill switch stops frames synchronously in the same call and a
moved TCC state stops them at the first boundary after the consent freshness
window. Every published frame is classified before egress: the frame record
carries lane/session/generation/sequence provenance and the classification
`restricted_local` (full-desktop pixels can include credential prompts) with
`redacted: false` recorded honestly — no pixel-level redaction exists in this
lane; the consented, authenticated channel is the boundary. Delivery follows
the shared screencast flow control: the grant's frame bound is the initial
credit, acks refresh it, a frame larger than the remaining credit is never
sent, and the newest complete frame waits instead of queueing.

Capability probing is honest per the permissions page's rules: a capability
exists only where a probe or host tool can prove it. Input synthesis requires
the accessibility grant (the `osascript` System Events probe proves it) and a
fixed-argv input tool on the host. Screen capture requires the screen
recording grant, which the JXA `CGPreflightScreenCaptureAccess` preflight
measures for the responsible process without ever showing the consent prompt
(issue #624): a `true` answer proves the capture capability available, and
anything less — a `false` answer, an unanswered prompt, or a probe that
cannot answer — keeps capture refused with the probed state or the exact
missing piece; the preflight proves only granted and not-granted, so a
`false` answer reports the fail-closed `denied` state and the Settings pane
is the repair path for a refusal and a never-asked prompt alike.
`dev.computeruse.capabilities` reports the row truthfully.
Accessibility-tree reading has no authorized bridge in this lane
and reports the same unavailable treatment. Capability-missing and
permission-denied states block launch with actionable guidance through the
permissions page (denied accessibility routes to the exact Settings pane); TCC denial is never
silently degraded into a working-looking lane.

The lane has no native ScreenCaptureKit bridge and no authorized
accessibility-tree bridge to the Bun process: capture goes through the macOS
`screencapture` host tool behind the preflight gate, and AX-tree reading stays
typed-unavailable (issue #624 leaves it deliberately out of scope). The
browser CDP frame path cannot satisfy computer-use capture: it sees only the
browser lane and cannot claim the full desktop. #542's packaged real-TCC
frame gates (granted-preflight frames flowing end to end, TCC-denied refusal
copy on the packaged bundle identity, revocation timing against a live
desktop) remain owner-side evidence: this machine class cannot grant Screen
Recording headlessly, and the packaged lane must record the bundle's own
permission identity, frame provenance, and generation revocation behavior on
a host where the grant is real.

| Capability | Depends on                                                   | This lane's honest state until proven otherwise                                                             |
| ---------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| input      | accessibility grant + host input tool + active consent       | `denied`/`not_determined`/`unavailable` mirrors the probe; never assumed                                    |
| capture    | screen recording grant (preflight probe) + host capture tool | `denied`/`not_determined` mirrors the preflight; `capability_unavailable` only when the probe cannot answer |
| ax_tree    | accessibility bridge for tree reads                          | `capability_unavailable` (no authorized bridge in this lane)                                                |

Threat-model closure (see `docs/security/dev-view-threat-model.md`,
TM-015–TM-017): agent-driven typing into privileged surfaces (password
fields, Terminal, sudo prompts) is bounded by consent records that name the
session, are single-use, and die with the run — but the residual risk is
accepted and documented, not engineered away; capture of secrets
(keychain/password-manager prompts) is bounded by the #624 fences — frames
flow only while the screen-recording preflight and the lane's live consent
hold, are classified `restricted_local` before egress with honest
`redacted: false` provenance, and stop at the next boundary after revocation
— while pixel-level redaction of credential surfaces remains unbuilt and the
residual risk stays documented; grant escalation via harness compromise
is bounded by the gate re-deriving every admission from provider-owned state,
so a compromised harness can never extend, replay, or widen a grant.

## GitHub provider

`RemoteSourceProvider` exposes host-neutral IDs and DTOs. GitHub response objects
never enter UI state. Reads prefer API/GraphQL and use ETags/cursors; `gh` is an
authenticated transport option, never output to scrape.

Credentials are host/account scoped. Enterprise hosts require explicit trust;
github.com credentials are never sent elsewhere. Every `gh` child and every
push resolves the active workspace's git hosting binding for its host
(Workspace connections): a binding adds that host's token to the one child's
env; no binding is the device's own `gh auth`, recorded `device_default`. All mutation results are
reread before success. PR create uses an idempotency/reconciliation key and
searches for an existing matching head/base after timeout. Before a PR-create
POST, the host durably records the authorized scope, repository, head, and base
as an opaque key under its owner-only runtime data directory. It returns only
an exact open head/base match whose head owner and base repository match the
authorized remote. A per-key file lock fences concurrent host processes before
the POST. A timed-out POST, lost response, verification failure, or
host crash keeps the record: later attempts reread GitHub, reconcile when the
matching PR becomes visible, and refuse another POST while the outcome is
unknown; the same holds for an HTTP 5xx response or any other failure without
an observable HTTP verdict. A definitive refusal that proves GitHub created
nothing — an HTTP 4xx response body, or a pre-flight failure that never
reached GitHub's evaluator (missing `gh` binary, pre-flight auth gate,
rate-limit throttle) — clears the record after one final reread, so an
"already exists" refusal reconciles and a pure validation refusal leaves the
head/base pair retryable instead of wedged (#597). A successful POST also
requires an authoritative reread before the record is cleared. A corrupt
retained record also blocks further POSTs. An
unresolved record requires manual GitHub verification; the UI must never
silently retry creation for the same head/base.

Push defaults to normal fast-forward/upstream setup. Force requires a separate
plan and confirmation using `--force-with-lease=<ref>:<expectedSha>`; raw force
is prohibited and protected/default branches refuse. Update branch shows exact
base/head SHAs and strategy; merge/rebase is explicit, conflicts remain
recoverable, and reset/force-push is never automatic.

PRs are draft by default per repository policy. Merge is explicit, uses the
repository's permitted strategy, and refuses unresolved required checks,
reviews, conversations, or branch rules. No admin bypass.

Issue, PR, review, and check text/logs are untrusted display content. They are
sanitized, bounded, and never automatically inserted into a privileged prompt
or shell command.

### Pull request collaboration (source control app)

The source control app reads and acts on pull requests across every
registered repository whose `origin` is a trusted GitHub remote. Its
operations extend the provider above under the same credential rule: GitHub
auth is the user's `gh` CLI context, and Adea stores no GitHub token.

- **Sidebar tree and the show-more bar.** The tree groups registered
  repositories under their provider owners, counts active projects whose
  every binding has no registry record separately from archived ones (the
  empty state names auto-adoption, its failure fallback, and the panel's
  remove action, and always states unregistered archived projects
  separately — auto-adopt skips them), and collapses archived projects into
  their own section. Repositories the viewer does not want listed sit below
  the show-more bar: hiding is a per-repository display preference in the
  app's scope-scoped browser storage (`hiddenRepoIds`), never an unlink —
  hidden repositories stay adopted and registered, keep their rows inside
  the collapsed group, and are excluded from the shortcut counts and the
  default selection while every newly adopted repository is visible by
  default (membership is an explicit set, so auto-adopt lands above the
  bar). The bar itself is a divider between the owner sections and the
  collapsed group, present whenever any active project exists, and it is
  the pointer fast path, not a second state model: dragging a repository
  row across the line and releasing commits the same `hiddenRepoIds` write
  the per-row hide/show controls make — below the line hides, above it
  restores. It never reorders: owner grouping and within-section order are
  fixed, so a drop on the row's own side is a no-op. The pointer mechanics
  mirror the published resize handles — pointer capture on the row, a
  6px travel threshold before a press becomes a drag, a 12px hysteresis
  band around the line before the landing zone flips (a click never
  toggles), and Escape, pointer cancellation, and lost capture abort
  without a drop and without falling through to the row's click; the line
  highlights while a drag is live and arms once the pointer crosses. Touch
  keeps its scroll (`pan-y`): a scroll that wins fires pointercancel and
  aborts the drag, so the explicit controls are also the touch path.
  Keyboard parity stays with the per-row hide/show controls; the bar
  exposes itself as a labelled separator plus a grip button that toggles
  the collapsed group, mirroring how the resize grips are exposed.

- **Read models.** `pullRequestSummaries` (one repository, newest update
  first, at most 50 a page) and `pullRequestSummary` (one PR, plus `body`,
  the compare-derived `behindBy`, and `requiredApprovals`, the larger of the
  base branch's ruleset pull request rule and its classic branch protection,
  each read best effort so a refused read — classic protection needs admin —
  leaves it absent) return `GitHubPullRequestSummary`: author
  (`user`, `bot`, or `team`), the base ref's oid (`baseSha`, omitted when
  absent), requested reviewers, the latest review per reviewer, GitHub's
  review decision, `mergeable`, `mergeState`, a check
  rollup with per-bucket counts, auto-merge, the repository's allowed merge
  methods, and closing issues. `timeline` returns comments, reviews, commits
  with their rollup state, review threads (first page only, with the first
  comment's diff hunk), and a fixed set of lifecycle events; an unknown node
  type is skipped, never guessed. `commits`, `files` (patches capped at
  256 KiB and marked `patchTruncated`), `labels`, `assignableUsers`,
  `branches`, and `compare` back the app's lists and pickers. `repository` also carries
  `defaultBranchHead` (the default branch's head SHA and check rollup), read
  best effort so a failed decoration never fails the repository read. `checks` takes
  an optional `sha` so each commit's runs can be read, and a check run carries
  its own output `title`. `checkLog` returns the sanitized last 512 KiB of a
  GitHub Actions job log (terminal escapes and control characters stripped,
  `truncated` set); any other check is `not_found`.
- **Transport.** GraphQL documents and every request body that carries user
  text travel on gh's stdin (`gh api --input -`); argv carries only fixed
  paths and flags. An `errors` array in a GraphQL reply fails closed.
- **Conversation writes.** `comment`, `threadReply`, and `threadResolve` are
  single operations that re-read server truth before replying. A thread
  operation first re-proves that the thread belongs to the addressed pull
  request and refuses `identity_mismatch` before any mutation is sent.
  `metadataUpdate` adds or removes reviewers (an `<org>/<slug>` login is a
  team), assignees, and labels; every login must match GitHub's login syntax.
- **Reviews.** `submitReview` binds `expectedHeadSha`: when the head moved
  since the reviewer read the diff it refuses `stale_version`, because inline
  comments would otherwise land on the wrong lines. Requesting changes needs
  a summary; a comment review needs a summary or at least one inline comment.
- **Merge outcome and branch rewrites are plan/commit pairs.**
  `autoMergePlan` binds the head SHA, the enabled state, and the method;
  blockers report a repository that disallows auto-merge or the method, a
  draft, a PR that can merge now, or a no-op. `syncBranchPlan` updates the
  head from its base on GitHub (merge or rebase, explicit and confirmed in
  the UI) and reports a branch already up to date or conflicts; GitHub's
  `viewerCanUpdateBranch` reflects up-to-date branch protection, not
  permission, so it gates nothing and GitHub refuses a viewer who cannot push. Each commit re-reads the PR and refuses
  `stale_version` when the head moved. The worktree-local
  `updateBranchPlan` above is unchanged.
- **#423 extensions.** `mergePlan` takes `deleteBranch`: after a verified
  merge the host deletes the head branch only when it lives in the base
  repository and is neither the default branch nor protected (by GitHub or by
  the registrar's `protectedRefs`); the reply's `headBranchDeleted` reports
  the outcome and a refusal never fails the merge. `updatePlan` patches take
  `state` (`open`/`closed`, refused on a merged PR), and `draft` now converts
  in both directions through GraphQL, since REST cannot change draft state.
- **Re-running failed jobs.** `rerunFailedJobs` resolves the job's workflow
  run and refuses `identity_mismatch` unless the job ran for the pull
  request's head branch.

### GitLab provider (source control app)

`dev.gitlab.*` mirrors the 29 source control operations of `dev.github.*`
with identical request bodies, the same reply DTOs, and the capability pair
`dev.gitlab.read`/`dev.gitlab.write`. The host provider
(`apps/desktop/shell/src/dev-runtime/gitlab/register.ts`) follows the GitHub
provider's rules, with these differences:

- **Credentials.** GitLab auth is the user's `glab` CLI context (its
  per-host credential store) unless the active workspace binds a git hosting
  connection for the host, which adds `GITLAB_TOKEN`/`GITLAB_HOST` to that one
  `glab` child (Workspace connections); Adea stores no GitLab token outside
  the vault. `gitlab.com` is
  trusted; a self-managed host must be trusted explicitly. Request bodies
  carrying user text ride `glab api --input -` stdin, never argv. A missing
  binary is `capability_unavailable`; a signed-out CLI is `unauthenticated`.
- **Identity.** A merge request id is `gl:<full/project/path>!<iid>`: the
  full path keeps every subgroup. The provider re-derives the project from
  the registered repository's `origin` before any repository-scoped read.
- **Mapping.** Merge requests map to `GitHubPullRequestSummary`. GitLab's
  `Draft:` title prefix becomes the `draft` flag and is stripped from the
  title; approvals become `approved` reviews and a reviewer who requested
  changes a `changes_requested` review; `reviewDecision` follows the
  project's approval rule, whose `approvalsRequired` is `requiredApprovals`,
  and the diff's start sha is `baseSha`. The head pipeline's jobs are the checks
  (`stage / name`); an `allow_failure` job that failed is `neutral`, manual
  and skipped jobs are `skipped`. Discussions anchored to a diff position
  are threads (their id is the discussion id); other notes are comments;
  system notes for approval, merge, close, reopen, draft and ready, review
  requests, target changes and force pushes become review or lifecycle
  events, and other system notes are dropped. Job logs drop GitLab's
  section markers with the terminal escapes.
- **Checks.** `checks` without a `sha`, or with the merge request's own
  head, reads the head pipeline; an older `sha` reads that commit's latest
  pipeline.
- **Writes.** Reviews post inline comments as positioned discussions
  against the head's diff refs, then the summary note, then the approval
  bound to `expectedHeadSha`. Merge binds the planned head through GitLab's
  `sha` guard and removes the source branch on request (never a fork's).
  Auto-merge is merge-when-pipeline-succeeds, also bound to the head.
  Updating a branch is a rebase. Draft and title changes travel through the
  title prefix. `createPullRequest` opens a draft and reconciles onto the
  open merge request for the same source and target. Re-running retries the
  failed jobs of the job's pipeline, only for this merge request's branch.
- **Refusals.** A `merge` branch update and a `request_changes` review are
  `unsupported_capability` (a plan blocker for the former); a team reviewer
  (`org/team`) is `unsupported_capability`. The app hides these actions
  through per-provider capabilities rather than failing on them.

Pinned by `apps/desktop/tests/dev-runtime-gitlab-provider.test.ts` on a
scripted `glab`; the opt-in, read-only
`apps/desktop/tests/live/gitlab-collaboration-live-read.ts` runs every read
against a real project through the production `glab` transport, or with
`--anonymous` against a public project over HTTPS (reads GitLab keeps behind
sign-in then refuse with typed errors).

### Source control app (client)

`packages/dev-view/src/source-control-app/**` is the rail's Source control
app. It reaches GitHub and GitLab only through the operations above and
holds no provider state of its own beyond these rules:

- **Projects.** The sidebar lists Dev projects whose repository `remote` is
  on GitHub or GitLab, grouped by owner or group and labelled with the
  provider (organizations, then the viewer's own account); other projects
  are counted, not listed. Archived projects collapse into one row.
- **Providers.** The client picks the operation family from the pull
  request id (`gh:`/`gl:`) or the repository's catalog provider. Each
  provider has its own account and viewer; a provider that is signed out
  shows its reason on its own projects while the other keeps working, and
  the app is disconnected only when every provider in use is. Capabilities
  per provider hide what it cannot do: GitLab offers only a rebase update,
  no request-changes verdict, and no team reviewers. The Git providers
  dialog checks every listed provider when it opens and re-checks on
  demand. A check updates the affected row in place — chip, caption, and
  busy control — and must never rebuild the menu or collapse a row's
  sign-in help while the check runs; the same no-rebuild rule holds for
  every menu fed by an async refresh, whose refetches update the rendered
  list in place instead of swapping it for a loading state.
- **Session link and agents.** A pull request belongs to the Adea session
  whose non-archived worktree has its head branch checked out in the same
  repository (a live session wins); forks never link. The link is derived on
  every sync from `dev.worktree.list` and `dev.session.list` and never
  stored. An author is an agent when GitHub reports a bot or the pull
  request has a session link.
- **Inbox grouping.** Every open pull request lands in exactly one group, in
  order: draft; the viewer is a requested reviewer without a review on the
  head; ready (approvals met, checks passing or absent, not behind, no
  conflicts); blocked (failing checks, requested changes, behind, or
  conflicts); waiting. The rules are pure functions with unit tests.
- **Merge dock.** Merge is offered only when every row is green and is
  confirmed first; otherwise merge-when-ready is offered when the repository
  allows auto-merge; conflicts, requested changes, failing checks, and
  drafts disable it with the reason shown.
- **No agent hand-off.** The app never sends pull request, review, or check
  text to an agent session; it offers Open session, which selects the
  session in the Dev view.
- **Local state.** Browser storage, scoped to the runtime scope, holds the
  selected project, the details panel per tab, the merge method, the diff
  layout, the delete-branch choice, viewed files per head, and pending review
  comments until Submit review. Every read decodes strictly and falls back to
  defaults.
- **Sync.** Every 60 seconds and on window focus; a mutation re-reads the
  pull request and folds it back into the inbox.

## Process, port, metrics, and usage

A destructive process action requires an Adea launch record plus PID start
identity, executable identity, parent/process-group/session relationship,
runtime node, worktree/session owner, and generation. Recheck immediately before
every signal, or use a stable OS process handle. PID, PGID, name, argv, cwd,
parent, or port alone is insufficient. A replacement between scan and signal
must survive.

Ports derive first from launch/session metadata and are confirmed by scoped OS
inspection. A listener Adea did not launch is never stopped through the
Adea-owned path above. With the default `machine` resource coverage it becomes a
`ForeignProcessRecord`, and only the user-confirmed foreign stop in
"Machine-wide inventory and foreign stop" may signal it. With the `adea` coverage
it is displayed as external without a stop button. No LAN-wide scan,
`pkill`, `killall`, `lsof`-wide termination, or termination selected by port,
name, or argv.

Metric defaults:

- visible active session: 2-second sample;
- visible idle: 10 seconds;
- hidden/background: 60 seconds; pause during sleep;
- system-call concurrency: 4/runtime node;
- command timeout: 5 seconds; output cap: 1 MiB;
- retained history: 720 points/metric/session and 24 hours, downsampled;
- CPU uses monotonic deltas; memory distinguishes process and descendants;
- unknown/unsupported/permission-denied/stale are explicit, never numeric zero.

Usage adapters label source as `official_api | harness_protocol |
local_transcript_estimate`, account-safe label, period, unit/currency,
used/remaining, confidence, captured/expires times, and typed failure. Estimates
are never billing truth. Cache/backoff honors provider limits; manual refresh
has a 60-second floor unless an official contract permits less.

Usage endpoints are fixed reviewed URLs or explicit trusted-host allowlists.
Non-loopback requires HTTPS. Revalidate DNS/IP, deny metadata/private networks,
and refuse or revalidate every redirect. Credentials are host scoped and never
forwarded to an untrusted URL. Provider undocumented endpoints require terms and
current-behavior review.

External telemetry is off by default. If enabled, scrub paths, commands,
project/worktree names, environment, exception messages/frames, SDK contexts,
attachments, terminal/prompts, and credentials before egress.

### Host provider policy (M12 #424)

The shell serves `dev.resources.*` from proven sources only, and every
listing without a source is truthful-empty rather than fabricated:

- The process inventory joins the supervision engine's durable launch/exit
  journal against its live snapshot. A launch is listed `running` (and only a
  `running` row offers a stop) when journal identity, live PID, PID start
  identity, executable identity, and launch generation all match; a reused
  PID or replaced executable renders as `unknown`, and a journaled exit
  renders as `exited` for a bounded retention window. Exited-but-unrecorded
  and never-journaled processes are not listed at all.
- Ports come from the #422 inventory (launch/session metadata confirmed by a
  loopback-only scan); unknown listeners are `unknown` with no Adea-owned
  stop path (the foreign stop below is a separate, user-confirmed path).
- Metrics are pull-based: a bounded sample is recorded when the snapshot or
  metrics surface is read, never on a timer. CPU is a monotonic delta
  between consecutive samples of one owner; the first sample carries no
  `cpuPercent`, and unobservable values stay absent (never numeric zero).
  History is bounded to 720 points per owner and 24 hours. Each pull makes at
  most one `ps` observation of 64 distinct PIDs. The sampler rotates that
  bounded window through the current inventory, so a stable large inventory
  is covered across successive pulls without a command burst or permanent
  first-page bias. An unsampled process has no fabricated metric. Reads
  maintain the full listing between pulls — points append in listing order
  under the monotonic sampler clock and reads fold only the delta since the
  last read — so host read cost tracks the bounded sample delta instead of
  re-deriving every retained point (#596).
- Usage adapters are sequenced by a cache service with exponential backoff
  plus jitter, per-provider in-flight dedup, and the 60-second manual-refresh
  floor. A failed poll stores an explicit typed-failure row (quantity
  `unknown`, never 0) and never blocks the listing or any other lane.
  Official-API adapters require a fixed reviewed endpoint (HTTPS off
  loopback), host allowlisting, DNS revalidation that denies private and
  metadata ranges, `redirect: 'error'`, a bounded 5-second fetch, and a
  vault credential — without a credential they report `auth_required` and
  never touch the network.
- Stopping a process is a plan/commit pair bound to the envelope resource
  `{kind: 'process', id: processRecordId, generation}`. The plan mints the
  supervision engine's stop confirmation; the commit re-checks the binding,
  the live generation, the plan digest, and the still-proven inventory entry
  before calling the engine's public stop API — which re-proves the launch
  identity immediately before any signal (TM-004). The first attempt is
  graceful; a retry after an unconfirmed stop window escalates explicitly.
  Failures map typed (`ownership_unproven`, `stale_generation`,
  `already_completed`, `plan_stale`, `timeout`) and never signal PIDs
  directly.
- Cleanup policies are durable drafts that become approved only through a
  single-use owner approval; approval fails closed (`auth_required`) without
  the owner approval authority. Evaluation observes facts only and returns
  `executesNothing: true` always; unavailable facts, an expired policy, or a
  non-approved state produce blockers and `matched: false` — automatic
  background cleanup can never run on an unprovable state.
- The composition constructs and holds the supervision engine when the
  component manifest is available (`componentManifest`): the engine's durable
  launch/exit journal lives under `<data dir>/dev-runtime/supervision/`, and
  the resources surface binds to that engine — listings join the journal
  against the engine's live snapshot, and the stop commit delegates to the
  engine's public stop with its identity re-proof. Without a manifest (and
  without a scripted engine override) the listings stay truthful-empty and
  stop fails closed with `capability_unavailable`. The packaged shell entry
  supplies the manifest in production: at boot it locates the `.app` it
  itself runs from (`Contents/Resources/app` → bundle root) and loads the
  component manifest through the packaging lane's strict install-location
  resolution (`loadPackagedManifestForEntry`); a repo dev run has no bundle,
  and a found bundle whose resolution or decode fails loads nothing — the
  shell logs the reason and boots the same truthful no-supervision
  composition, never a fabricated manifest.
- Metrics sample through the bounded process-sampler seam: one fixed-argv,
  read-only `ps` observation per pull (`ps -o pid=,time=,rss= -p <pids>`;
  the composition's default sampler; tests script the transport) with a
  5-second command timeout, a 1 MiB output cap, and 64 PIDs per invocation.
  `time` is the OS cumulative CPU time (the history derives monotonic
  deltas), `rss` the resident set size. Rows `ps` did not report are absent
  from the reply — never numeric zero.
- The retained-data breakdown is a read-only byte projection over the owning
  slices' stores — terminal checkpoint segments under the owner-only runtime
  root (`protected: true`; deletion stays the terminal's own re-proved
  path), the browser lanes' bounded screenshot retention, and the
  dependency-template cache's promoted records. Each source is
  independently best-effort: an unreadable source contributes nothing
  (absent, never zero) and is never rewritten or moved by the projection.
- Cleanup-policy evaluation facts come from a read-only adapter over the
  worktree service: the durable worktree record, the lease store's live
  views (active and suspect leases count as live), and fixed-argv read-only
  git observation (`status --porcelain`, upstream `rev-parse`, `rev-list`
  counts). An unknown worktree returns no facts at all; a failed git read
  or push state that cannot be proven leaves that fact absent, and facts
  the adapter cannot prove at all (PR merge state, attached owned
  resources) stay absent by design — every predicate over an absent fact
  fails closed.

### Machine-wide inventory and foreign stop

Agents leave servers, debuggers, and automation browsers running outside
Adea's launch records: harnesses run in other terminals, and a dev server
started in an Adea terminal has no launch record either. The resources sheet
therefore defaults to the whole machine. `ResourcePreferences.coverage =
'adea'` restores the Adea-only listing, and then the snapshot carries neither
`foreign` nor `machine`.

The host composes this surface only where it can observe processes: the
desktop shell uses its bounded command runner on macOS, and a test or another
host injects one (`runResourceCommand`). Without a runner, `foreign` and
`machine` are absent, foreign stop fails closed with `capability_unavailable`,
and external listeners keep the no-stop rendering above. The shell modules are
`apps/desktop/shell/src/dev-runtime/resources/{capped-command,machine-inventory,foreign-stop,worktree-storage,preferences,janitor,janitor-model}.ts`.

Inventory (one bounded pull per snapshot read):

- Every observation goes through the capped runner: fixed argv, 5-second
  timeout, 1 MiB output cap, and the child is killed when it exceeds either.
  A killed, truncated, or failed run is reported as such and never read as
  an empty answer.
- One `ps -axww -o pid=,ppid=,uid=,rss=,time=,lstart=,comm=` listing gives
  PID, parent, owner uid, resident bytes, cumulative CPU time, start identity
  (the whitespace-collapsed `lstart`), and executable identity (`comm`). An
  incomplete listing proves nothing: the pull reports no foreign rows and
  forgets the previous observation, so no stop plan can bind to it. One
  `ps -axww -o pid=,args=` listing supplies command lines for attribution and
  the redacted preview.
- `lsof -nP -iTCP -sTCP:LISTEN -F pcn` lists listeners, filtered to loopback or
  wildcard binds inside `portRange`. It runs at most once per visible sample
  interval and never faster than every 2 seconds. `lsof` exiting 1 with no
  output is an empty answer; any other failure leaves `listeningPorts` absent
  for that pull. One `lsof -a -d cwd -nP -F pn -p <pids>` call reads the
  working directory of rows not seen before; it is cached per row.
- The Adea tree is the shell, its descendants, and every proven launch with
  its descendants. Inside it, a process below an interactive shell (`zsh`,
  `bash`, `fish`, …) was started by the user in an Adea terminal and is
  listed with `adea_terminal` attribution, because no launch record proves
  it. Everything else in the Adea tree (helpers, sidecars, the shells
  themselves) is never listed, and journal-proven `ProcessRecord`s are never
  foreign rows.
- A foreign row is emitted for every listener, every automation app (the top
  of its tree only), and the 64 largest remaining Adea-user processes, at most
  256 rows. Descendants that are not rows themselves fold into their row's
  tree: `childCount`, tree `residentBytes`, and tree CPU.
- Attribution walks the parent chain, at most 16 hops, and is a display hint
  only:
  - `automation` when the process proves it itself: a Chrome for Testing or
    Simulator executable, or `--enable-automation`,
    `--remote-debugging-port`, or `--remote-debugging-pipe` on its command
    line (only with `includeAutomationApps`). Computer-use lanes launch no
    apps of their own, so there is no separate computer-use attribution.
  - `harness` when an enabled `recognizedHarnesses` entry matches the
    executable basename or the first script argument (`node …/claude`). The
    matchers are fixed executables shipped with Adea; the preference only
    selects which are on.
  - `adea_terminal` as above, otherwise `unknown`.
- `worktreeId` is the registered worktree whose root contains the working
  directory (longest root wins).
- Metrics follow the existing rules: CPU is a monotonic delta over the tree,
  absent on the first observation, and unknown values are absent, never zero.
  Each row keeps 10 minutes of tree resident bytes and reports at most 30
  evenly spaced points; history is dropped when the row disappears.
- `commandPreview` and `cwdLabel` are redacted before they leave the host:
  home becomes `~`, values after secret-looking flags (`--token`,
  `--api-key`, …) and in secret-looking assignments (`GITHUB_TOKEN=…`) are
  masked, and the preview is truncated to 160 characters. Both are
  display-only and never become event payloads or telemetry.
- `MachineResourceSummary` reads total and free memory, cumulative CPU times
  (the percentage is a delta between pulls), and the free and total bytes of
  the volume holding the home directory.

Protection, evaluated by the host on every observation and again before
every signal:

- `other_user`: the process is owned by another uid.
- `system`: PID 1 or lower, `kernel_task`, `launchd`, `WindowServer`,
  `loginwindow`, an executable under `/System/`, `/usr/libexec/`,
  `/usr/sbin/`, `/sbin/`, or `/Library/Apple/`, and the Adea tree outside its
  terminals plus the chain of processes that launched the shell.
- `protected_list`: the executable basename or `.app` name matches
  `protectedExecutables` (an entry ending in `*` is a prefix). The default
  list is postgres, redis-server, mysqld, `com.docker.*`, and ollama.

A protected row is listed with its reason and has `stoppable: false`. No
operation accepts it.

Foreign stop is `dev.resources.foreignStopPlan` → `dev.resources.foreignStopCommit`,
under the separate `dev.resources.stopForeign` capability:

- The plan binds the envelope resource
  `{kind: 'foreign_process', id: foreignProcessId, generation: observationGeneration}`
  to the latest observation. It refuses an unknown row (`not_found`), another
  generation (`stale_generation`), and a protected or unstoppable row
  (`ownership_unproven`). It records PID, start identity, executable
  identity, uid, and the descendant set, and its steps name every PID to be
  signalled, children first. `force` is a plan option, so changing it means a
  new plan. The plan expires after 60 seconds and is single use.
- The renderer shows the plan in the shared `AlertDialog`: the redacted
  command, folder, PID, start time, child count, attribution, that Adea did
  not start it, that unsaved work may be lost, and the PIDs the plan names.
  Confirmation is per process. There is no bulk confirm and no "remember
  this choice".
- The commit re-reads each PID (`ps -o uid=,lstart=,comm= -p <pid>`)
  immediately before signalling it. If the root's start identity,
  executable identity, or uid changed, or it became protected, nothing is
  signalled and the commit fails `ownership_unproven`. A child that changed
  or exited is skipped. A root that already exited reports `already_gone`.
  The first signal is SIGTERM, children first. The commit then waits up to 10
  seconds for the root to exit; without `force` an unexited root reports
  `still_running`. With `force`, each survivor is re-proven and sent SIGKILL,
  and the outcome is `forced` or `still_running`.
- Foreign stop never participates in automatic cleanup, cleanup-policy
  evaluation, or `Complete and clean…`. A worktree whose preflight is blocked
  by a foreign process stays blocked until the user stops that process
  through this path and the preflight is re-run.

Restart (`dev.resources.restartPlan` → `dev.resources.restartCommit`, under
`dev.resources.stop`) applies only to proven, running Adea launches of a
supervised component. The plan binds `{kind: 'process', id, generation}` like
the stop plan. The commit fences the generation and identity itself (the
engine's restart takes a component id) and then calls the supervision
engine's `restart`, which re-proves identity, stops, and relaunches the
component from its manifest command as a new generation. The reply is the
relaunched `ProcessRecord`. Without an engine restart the plan fails closed
with `capability_unavailable`. Foreign processes have no restart.

Worktree storage (`dev.resources.worktreeStorage`) returns one
`WorktreeStorageRecord` per registered, non-quarantined worktree:

- Measurement is lazy: a request schedules it and the reply carries the
  current state (`measuring` until the first walk finishes). The sheet asks
  only while its Storage tab or clean-up review is open.
- One walker runs per runtime node with at most 4 concurrent directory reads.
  It never follows symlinks, never crosses a mount point, and spends at most
  2 minutes per worktree. A walk that runs out of budget reports `stale`,
  keeps its previous bytes, and resumes from where it stopped on the next
  request.
- A finished result is served from cache and re-measured on request once it
  is at least 15 minutes old.
- Bytes inside `node_modules`, `target`, `.venv`, `venv`, `dist`, `build`,
  `.next`, `.turbo`, `.output`, `.svelte-kit`, `__pycache__`, `.gradle`,
  `Pods`, and `DerivedData` count as `buildBytes`; allocated blocks are
  counted where the filesystem reports them.
- An unreadable root is `unreadable` with bytes absent, never zero; an
  unreadable subdirectory contributes nothing.

Resource preferences (`dev.resources.preferences` under
`dev.resources.read`, `dev.resources.preferencesUpdate` under
`dev.resources.configure`) persist `ResourcePreferences` per device in the
shell's private data directory (`dev-runtime/resources/preferences.json`):

- The update carries `expectedVersion`; a different stored version fails
  `stale_version`. Every accepted update increments `version`.
- Every numeric field is clamped:
  - memory alert: 256 MiB–64 GiB; growth: 16 MiB–64 GiB;
  - growth window: 1–60 minutes; snooze: 0–7 days;
  - idle time: 15 minutes–7 days;
  - quarantine retention: 1–30 days;
  - retained-data retention: 1–90 days;
  - visible sampling: 2–60 seconds; background sampling: 30–600 seconds.
- Lists are bounded to 32 printable entries without `/`. A harness name
  without a shipped matcher is dropped.
- A stored document that cannot be read is replaced field by field with
  defaults, never rejected wholesale. Without a store, reads answer with the
  defaults and updates fail closed with `capability_unavailable`.
- These are the only resource settings. App Settings has no resource section.
- What reads each setting today: the host reads `coverage`,
  `includeAutomationApps`, `recognizedHarnesses`, `portRange`,
  `protectedExecutables`, and `sampling.visibleSeconds` (listener scan
  interval). The sheet reads `alerts.residentBytesAbove`,
  `alerts.growthBytes`, `alerts.growthWindowSeconds`, `cleanup.mode`,
  `cleanup.serverIdleSeconds`, and `sampling.visibleSeconds` (poll interval).
  The remaining fields are stored and validated but not yet acted on, and the
  sheet does not offer them. `cleanup.mode = 'automatic'` is shown as
  unavailable: no background runner for approved cleanup policies exists.

Clean-up review composes existing authorities and adds none:

- Candidates:
  - a running Adea launch whose worktree is no longer registered, or whose
    CPU stayed under 1% for the whole `serverIdleSeconds` window;
  - an archived, managed, Adea-provenance worktree;
  - a stoppable foreign row that holds a port or is over the memory alert.
- Pre-selected: those Adea launches unless they are leaking, and those
  archived worktrees once their plan has no blockers. Leaking servers,
  protected rows, and foreign rows are never pre-selected.
- When the review opens, each archived worktree is planned through
  `dev.worktree.cleanupPlan` with `quarantine_worktree` and
  `unregister_worktree` (branch kept); a plan with blockers is listed under
  "Can't be cleaned up" with the host's reasons.
- Confirming runs each selected item in turn and plans it again first:
  servers through the Adea-owned stop plan/commit, worktrees through
  `dev.worktree.cleanupCommit`. Foreign rows each open their own foreign stop
  confirmation.
- Retained data is shown read-only in the Storage tab; no prune operation
  exists for it, so the review does not offer one.
- `cleanup.mode = 'off'` hides the banner and disables the review.

### Machine-wide janitor

Junk exists regardless of origin: Xcode DerivedData entries, `~/Library/Caches`
and `~/Library/Logs` entries, the Trash itself, and git worktrees no Adea
register tracks. The janitor is an additional section of the resources sheet
(the "Junk & leftovers" tab) beside the adea-created resource tracking, which
stays as-is; the janitor never touches a registered worktree, a proven launch,
or any retained data.

Safety contract (non-negotiable, enforced by the provider design):

- Nothing is ever deleted automatically and nothing is deleted in place.
  Every deletion is an explicit user action — per item or a checked bulk
  selection — and every run is a single-use `dev.resources.janitorPlan` →
  `dev.resources.janitorCommit` pair under the dedicated `dev.resources.janitor`
  capability: the plan binds the sheet's scan generation and digests each
  named item's proven identity (device + inode); the commit re-proves the
  identity immediately before each disposal and reports one typed outcome per
  item (`trashed`, `emptied`, `pruned`, `skipped`, `failed`). A changed
  identity is skipped, never disposed.
- The default disposal is the platform Trash: a `trash` item is renamed into
  the user's `~/.Trash` (recoverable, destination names deduplicate without
  overwriting, and a cross-volume rename fails the item instead of deleting).
  Only entries discovered inside the Trash offer `trash_empty` (the OS already
  classified them deleted), and only a provably stale git worktree admin entry
  (`git worktree list` `prunable` reason, directory still gone at commit time)
  offers `prune` (fixed-argv `git worktree prune` scoped to the reporting
  repository).
- Discovery and sizing are read-only: `readdir`/`lstat` at the item roots,
  never symlink-following, and fixed-argv git. The scan universe is closed
  over first-level entries of the well-known roots plus worktrees under the
  configured scan roots; only these discovered paths can ever be disposed,
  and paths never leave the host (home-abbreviated labels only). Adea's own
  quarantine trash (`.adea-worktree-trash`) is excluded.
- Sizes and modified times are computed asynchronously with bounded budgets
  (per-item deadline, bounded depth and entries, a per-command global budget);
  an unmeasured item stays unknown rather than zero, and a budget that ran out
  reports `stale`. The sheet asks for at most 64 ids per measure command.
- Worktree discovery runs `git worktree list --porcelain` per configured scan
  root (default: the register's authorized repository roots — the user's
  configured project roots; the composition's `janitorScanRoots` seam
  overrides). The primary checkout and every Adea-registered root are never
  candidates; an unregistered worktree is a candidate only when Git itself
  marks it prunable.
- The whole authority composes on macOS only; elsewhere every janitor command
  fails closed with `capability_unavailable`.

The scan/measure pair rides `dev.resources.read`; the plan/commit pair rides
`dev.resources.janitor`. The commit binds the envelope resource
`{kind: 'janitor_plan', id: planId, generation: scanGeneration}`; a rescan
between plan and commit fails the commit `stale_generation`, and the reply's
strict decoders (`JanitorScanReport`, `JanitorMeasurePage`, `JanitorPlan`,
`JanitorCommitResult`) fail closed like every other operation's.

### Runtime activity

The Agents pane mounts the harness status surface above the Activity section:
the session's derived run state (idle stays idle, `unknown` stays unknown, a
fallback-only transport offers jump-to-terminal instead of implying structured
events), the effective default harness, and the preference rows with their
installation display states, all projected through the pure status model from
`dev.harness.runs` / `dev.harness.preferences` / `dev.harness.managedPiStatus`.
The History pane mounts the bounded run-history rows (newest-first,
redacted by construction, resume/jump affordances through caller-owned
callbacks only). Both ride their own lazy chunks inside the Dev boundary and
render their capability state truthfully when the runtime is unavailable.

The Agents pane also carries an Activity section built from `dev.harness.runs`
(event provenance: the harness substrate's run records). Rows show the
agent/profile, model, state, and elapsed time; `awaiting_input` and
`awaiting_approval` states are attention-ranked first, so the pane answers
"what needs me?" without terminal scrolling. Stop controls ride the
session-scoped, generation-fenced `dev.session.cancelHarness` command and
are disabled while the session generation is unknown. The workspace top bar
carries the runtime-resources action on every view. Its detail sheet is docked
by the shared inset Sheet to the workspace's end edge below the bar on every
host, widened to 37.5rem through its `dev-resources-sheet` hook. All resource
management and all resource settings live in this one sheet
(`packages/dev-view/src/resources/`):

- **Pinned title band:** the published `SheetHeader` part — the #1082
  two-toned muted band — holds the title, the coverage (`This machine` or
  `Adea only`), and the refresh and settings `ActionButton`s. The close
  button stays the sheet's own corner action.
- **Pinned action band:** the published `SheetFooter` part holds the clean-up
  section (the clean-up button and its ask-first note) on the main view, so
  the decision stays reachable while the body scrolls. The drill-in reviews
  carry their own action rows; the band yields to them.
- **Scrolling body:** the published `SheetBody` part scrolls the overview,
  attention banner, tabs, and drill-in views between the bands.
- **Overview:** the memory used by Adea (proven launches plus processes in
  Adea terminals) over a machine memory bar split into Adea, other listed
  processes, other apps, and free; then CPU, ports (`N Adea · M other`), and
  storage tiles.
- **Attention banner:** the pre-selected clean-up count and the disk it
  would free (or how many things need a look), with one line naming every
  kind of issue present — servers leaking memory, servers over the memory
  limit, servers whose worktree was deleted, idle servers, archived
  worktrees, and processes Adea did not start that hold ports — and a Review
  action.
- **Servers & apps tab:** rows grouped by worktree (proven launches and
  foreign rows whose working directory is in a registered worktree), then
  deleted worktrees for launches whose worktree is gone, then "Adea", then
  "Elsewhere on this machine", then "Protected". A deleted worktree's group
  keeps the branch title the sheet last listed for it (remembered for the
  page's lifetime) and says the worktree was deleted; without one it reads
  "Worktree deleted". Each row shows its port (the column fits a full
  loopback address and truncates anything longer), what it is, who started
  it, a memory sparkline, and tree memory, plus row actions: restart (proven
  launches), stop (stoppable rows), and details. A proven launch's second
  line names its executable, PID, uptime (from its start identity; the state
  instead when it is not running), and its runtime session (`this session`
  for the session the sheet is scoped to). A row is leaking when its memory
  grew by at least `alerts.growthBytes` within `alerts.growthWindowSeconds`,
  and the leak line names that window (`Leaking · +600 MB in 10 min`); a row
  is over its limit when it holds at least `alerts.residentBytesAbove`; both
  use the warning tone. Protected rows show why and have no stop.
- **Storage tab:** a disk bar (worktree source, builds and dependencies,
  retained data), the worktree list with state badges and sizes, and the
  read-only retained-data breakdown. The tab trigger carries a badge: the
  measured total once storage has been measured, the worktree count before.
  read-only retained-data breakdown.
- **Junk & leftovers tab:** the machine-wide janitor's sections (Derived
  Data, Caches, Logs, Git worktrees, Trash) with per-item size and modified
  time as the bounded measure lands, per-item selection, a plan confirmation
  that names every path, its disposal, and the total size, and the same
  section show-more window as the server lists.
- **Agents & usage tab:** the provider usage cards.
- **Drill-in views:** server details (memory and CPU history charts with a
  time axis, the memory chart with a dashed line at `alerts.residentBytesAbove`
  when the limit is within twice the highest sample; facts including the
  command, session, and the start time as relative age plus locale date; and
  ownership), the clean-up review, resource settings, and the stop, restart,
  and foreign-stop confirmation in the shared `AlertDialog`. The confirmation
  has an Owner row (the launch owner and session, or who started a foreign
  process) and formats the start time the same way. A proven launch with a
  preview URL offers **Open preview** (the host's external-link hand-off on
  desktop, a new tab on the web), and one with a runtime session offers **Go
  to session** when the host supplies the hand-off: the sheet closes and the
  workspace navigates to Dev with the `devProject` (from the launch's
  registered worktree) and `devSession` deep-link params, which Dev View
  resolves like any deep link.
  and foreign-stop confirmation in the shared `AlertDialog`.
- **Section lists:** a servers section with more than 8 rows collapses to its
  first 8 behind a `Show n more` control, with `Show less` restoring the full
  section; the expanded choice persists for the session. A section at or
  under the limit never collapses and never shows a control.
- While the sheet is open and the page is visible, it re-reads the snapshot
  every `sampling.visibleSeconds`.

Lanes without a Dev runtime channel render the typed unavailable state; absent
capability renders as typed states.
The resource refresh icon uses the shared explanatory `ActionButton`; an
unavailable runtime keeps the action inert while its tooltip explains how to
enable it. Stop and cancel actions use shared destructive and outline button
variants rather than private control colors, padding, or shape overrides.

## Appearance and App Library

The settings dialog can mount without application providers. Its Appearance
fallback uses the persisted theme control when the host supplies a theme
provider; otherwise it reports that appearance settings are unavailable in
this view. Missing preference ownership must not throw, reset the document's
theme, or prevent navigation to other settings sections.

App Settings holds only app-wide sections: Account & app and Appearance
(Account), Agents and Input & notifications (Workflows), and Privacy & data,
Integrations & capabilities and Permissions (Data & access), deep-linked as
`#settings/<section>`. Workspace-scoped settings live in the workspace
settings dialog the sidebar's workspace gear opens (`WorkspaceDetailsDialog`,
`@adea-ai/workspace-ui/workspace-details-dialog`, lazy like app Settings):
titled "<workspace name> workspace settings" with the workspace's own mark,
its sections are General (name, mark, accent and Virtual world, saved as they
change against the workspace version), Memory, Skills and Connections (the
device connections pane and Connections › Cloud), deep-linked as
`#workspace-settings/<section>`. The retired `#settings/workspace`,
`#settings/memory`, `#settings/skills` and `#settings/connections` links open
the workspace settings dialog at the matching section and are rewritten to
the canonical hash.

Each signed-in user and guest receives exactly one persistent personal workspace,
initially **Home** with a home icon and the established app defaults. Its persisted
`is_personal` identity is independent of name, logo, accent and Virtual world;
settings remain editable, and General’s **Move up / Move down** controls persist the member’s own workspace order. The API checks the complete current membership list, and ordering a shared workspace never changes another member’s list. It is the default
workspace when no explicit workspace is selected, even after reordering. No
account connection, project, agent or integration is created by this bootstrap.
Additional workspaces use the existing **New workspace** inline name entry, a box
icon, empty workspace data and no account bindings; they append to the user's
list and can be reordered. An unbound harness still uses the established **Use
device default** behavior; an empty binding document is not an explicit account
connection, and this change does not expand authorization.

Migration uses only stable legacy `default-home`/`default` metadata, preserving
IDs, names, logos, accents, worlds, memberships, order and content. A proven
archived root is restored; legacy Work is never removed or reseeded. Historical
claims that lost seed metadata retain all their workspaces and gain a new personal
Home at next bootstrap. First sign-in preserves the guest root. A guest claim
into an account with its own root retains the account's personal identity and
keeps the incoming guest workspace as an additional workspace, without dropping
content. Owner locking, a partial unique index and an active-root check enforce
a single persistent personal identity. Personal-root deletion/archive is refused
in database helpers and API routes, including retries; the UI hides destruction
even if a stale capability says it is allowed, and fresh native deletion proof is
unavailable for the root.

General offers an owner-only **Delete workspace** confirmation for additional
workspaces with an explicit availability notice. Active permanent deletion is
currently unavailable: the server lacks a native cleanup-completion verifier.
Both prepare and final requests return `workspace_deletion_cleanup_required`,
preserving the cloud root and data. Owner/name/version checks and personal-root
protection remain authoritative. A caller boolean/header, desktop origin,
owner credential, local receipt or prepare timestamp is never completion proof.
No new pending intent is created. Historical deleted receipts are retryable only
when the cloud root is absent; a receipt alongside an active root cannot produce
`deleted` proof. The shared empty creation screen is a compatibility/recovery
fallback, not a normal last-workspace flow. Chosen emoji marks remain intact.

Native preflight uses signed-window commands and `workspace-deletions/cleanup.json`
to fence admission and refuse live work, PTYs, browser/device lanes, unresolved
managed worktrees and ambiguous ownership. Fresh active proof permits cancelling
a prepared fence. A pending cloud intent authorizes no session archival, local
purge or identity removal, including direct native calls, restart and repeated
retry. Existing interrupted intents remain visible/frozen with **Retry cleanup**
and truthful refusal. Historical already-deleted roots may resume scoped recovery
cleanup from fresh owner proof. Completed receipts permanently fence stale writes.

Recovery cleanup archives/detaches Adea's idle session projection and preserves
harness-owned histories. It verifies indexed ciphertext, authenticated memory and
injection overrides, scoped bindings/audits, root/grant/repository/worktree/policy
records and proven completed journals, fingerprints, template caches and browser
profiles. Managed clones use ownership-proven unbind/quarantine; failure retains
recovery state. Shared profiles/vault keys, ordinary repositories/checkouts and
unread legacy/corrupt ownership are retained. These foundations do not make active
workspace deletion supported without a server-owned completion contract.

Used/unverified Control Plane scope, any registered runtime node including
revoked/offline nodes, queued/running/review tasks and browser inability to verify
local resources are additional refusal reasons. Legacy scopes are conservatively
marked used by migration. Mutating signed credential issuance records external
ownership before minting and serializes against pending intent; reads/shared host
authentication do not mark workspace resources. Workspace-wide Control Plane
physical-purge receipts and all-device cleanup/acknowledgement contracts are also
missing. No broad Control Plane infrastructure is introduced and no catalog,
execution/history/evidence, cloud credential or marketplace installation purge is
claimed. Running work is never silently terminated. Native/browser fixtures and
raw database cascade fixtures do not establish packaged or deployed acceptance.

Additional workspaces have no seeded account binding. Clearing a binding still
means **Use device default** under ADR 0012, so existing device CLI sign-in may be
used. There is no explicit “no account” policy mode in the current native resolver,
nor verified personal/additional metadata in its membership-ID contract. Home's
ready-to-use defaults and that existing fallback are preserved. Isolated account
behavior requires a separate persisted policy and launch-path implementation.

### Shared utility action controls

Utility icon actions use the shared `ActionButton` with accessible names and explanatory
tooltips. Resources refresh stays disabled until the runtime is ready and explains the
connection requirement in its tooltip. File rename and copy use shared ghost icon
actions; pending tree copy uses the same confirmation label in its tooltip and accessible
name. Labelled delete and overwrite confirmations use the shared destructive button
variant. These presentation controls retain the existing runtime fences and plan/commit
authority; a tooltip or visual variant does not authorize an operation.

Browser lane selection uses published `ListRowControl` buttons in a labelled group. The selected lane has the shared selected treatment and `aria-current`; keyboard activation uses native button semantics. Lane state and ownership remain domain descriptions, and choosing a lane preserves the existing inspection invalidation and scoped target/diagnostic refresh behavior.

Utility pane resize controls use the published `PixelResizeHandle`, including its
shared grip, full-height pointer target, cancellation handling, and keyboard
controls. Adea retains only the utility width steps and saved preferences.
Host CSS restyles the presented grip on Dev surfaces into a tall, skinny,
translucent rung (icon dropped, hover wash softened) without touching the hit
target, drag semantics, or keyboard controls.
