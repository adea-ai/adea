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
- Threat model: [Dev View threat model](../security/dev-view-threat-model.md)
- Delivery order: [M12 implementation plan](../plans/m12-dev-view.md)

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
| `projectId`             | user-defined project intent                                  |
| `repoId`                | canonical repository/common-dir identity on one runtime node |
| `worktreeId`            | never-reused checkout identity                               |
| `runtimeSessionId`      | canonical Dev/Chat session                                   |
| `groupId`               | user-defined project group                                   |
| `bookmarkId`            | M10-minted authorized root grant                             |
| `credentialRefId`       | vault-held credential reference, never the secret            |
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
  | 'dev.resources.read'
  | 'dev.resources.stop'
  | 'dev.cleanup.approve'
  | 'dev.appearance.read'
  | 'dev.appLibrary.manage'

type Scope = {
  accountId: string
  workspaceId: string
  runtimeNodeId: string
}

type Project = {
  id: string
  scope: Scope
  name: string
  groupIds: string[]
  repoIds: string[]
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

type Repo = {
  id: string
  scope: Scope
  kind: 'git' | 'folder'
  lifecycle: RepoState
  canonicalRoot: string
  gitCommonDirIdentity?: FileIdentity
  remote?: RedactedRemote
  defaultRef?: string
  projectIds: string[]
  version: number
}

type Worktree = {
  id: string
  scope: Scope
  repoId: string
  projectId: string
  canonicalRoot: string
  rootIdentity: FileIdentity
  gitDirIdentity?: FileIdentity
  provenance: 'adea' | 'external'
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

type Group = {
  id: string
  scope: Scope
  name: string
  colorToken?: string
  projectIds: string[]
  sortKey: string
  version: number
}

type GroupMutableFields = {
  name?: string
  colorToken?: string
  sortKey?: string
}

// A RootBookmark is a durable grant that a directory or repository root has
// been authorized by the owner. M10's authorized-root flow mints and revokes
// bookmarks; M12 consumes them but cannot mint one.
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
    | 'name'
    | 'groupIds'
    | 'preferredRuntimeNodeId'
    | 'defaultBaseRef'
    | 'bootstrapWorkflowId'
    | 'defaultHarnessId'
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
  observedAt: string
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
a pane is undoable in the window; closing a terminal process is a separate
privileged command. The center layout is a strict binary tree with a hard M12
cap of 8 leaves and depth 8; split/duplicate refuses with `limit_exceeded`
when either cap would be exceeded. Ratios are finite and clamp to `[0.1, 0.9]`.
Leaf IDs are unique, utility panes do not count as center leaves, and closing the
last leaf restores one terminal placeholder. Utility slots are independent:
left and right may each show one pane or be collapsed, and a change on one side
cannot hide the other side. Utility order, side, visibility, size, collapse,
and full-width state are local preferences only. A persisted focus target must
identify a center leaf; a split-node target is corrupt and falls back to the
first valid leaf.

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
and ownership. Archive does not stop or delete anything.

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
and freshness/generation metadata, and the groups, projects, repositories,
worktrees, and `RuntimeSession` records returned by the corresponding registry
operations. The provider may expose loading, stale, offline, unavailable, and
partial states, but it MUST NOT turn any of them into fabricated success data.

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

The M13 Chat model projects the canonical session, project, and group registry
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
transcript; session-local answer and composer draft state reset on selection.
During append-only streaming, existing transcript row DOM nodes stay mounted so
the live region adds only the new row instead of replaying prior announcements.
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
M13 first-run onboarding consumes identity and model-access entitlement facts
from the owning desktop composition. The guest state with no model entitlement
offers sign-in as its one recovery action; it never invents free guest model
access or displays a raw credential field. Managed-Pi install state is a
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
synthetic launch context. The current desktop API has no Control Plane model-
entitlement projection, so signed-in onboarding stays at an explicit
model-access gate and guest onboarding requires sign-in; no client-side
entitlement is inferred from identity or profile data. Packaged first-run
certification remains an M13.4 acceptance gate.

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
authority for projects, runtime sessions, groups, and the archive journal —
not a projection of other state. One versioned snapshot payload commits groups,
projects, sessions, and `ArchiveRecord`s together in the WAL-backed per-scope
`dev-runtime/project-session/authority-<sha256(scope)>.sqlite3` store, so
`dev.session.archive`/`dev.session.unarchive` persist the session flip and its
durable record in one SQLite transaction. The store enables `journal_mode=WAL`,
`synchronous=FULL`, and foreign keys on every open, uses a format-version guard,
and binds its single row to the `(accountId, workspaceId, runtimeNodeId)` scope
key before returning records. Each scope has an independent database and
ledger, so switching workspaces never makes one scope open or overwrite another
scope's file. The pre-slice `authority.sqlite3` is reused only when its stored
row belongs to the requested scope; a different scope gets a new partition.
A scope mismatch, malformed payload, or
unsupported format/schema version fails closed and retains an unread database
copy for recovery; the original database is never replaced by a recovery copy.
An interrupted migration transaction rolls back and leaves its JSON source for
the next open to retry while the SQLite database identity is unchanged. Each
partition has an owner-only sidecar migration ledger
(`authority-<sha256(scope)>.sqlite3.migration.json`), which
records the legacy source digest and database identity, and survives SQLite
loss: a recreated database refuses to re-import stale JSON and reports
`corrupt_state` for recovery. A first open without a legacy source creates a
native-state ledger before accepting a save; if the SQLite metadata survives
alone, a missing ledger is regenerated before records are returned. The
SQLite database and ledger are separate durable files, but deleting both is a
complete local state loss with no surviving identity; a later open cannot
distinguish that event from a first install and this slice does not claim to
prevent stale legacy re-import in that case. External backup or recovery
protection must cover that trust boundary. The retained `authority.json` source
is filtered by scope for each partition, so an A-to-B-to-A restart preserves
both migrated records without cross-scope import; legacy authority and
projection files must be regular owner-only files, and duplicate same-scope
legacy rows fail closed as `corrupt_state` instead of selecting the first row.
The register serves `dev.group.*` (now
including `create`/`update`/`delete`: a created group is placed after
`afterGroupId` or at the end and every displaced group's `version` bumps;
`delete` requires an empty group plus a `confirmationId` and the `group`
resource binding), `dev.project.import`/`create`/`get`/`list`/`reorder`, and
`dev.session.create/get/list/archive/unarchive`. `dev.session.create` binds the
session to an in-scope project and rejects a `repoId` outside the project's
bound repositories with `identity_mismatch`. `dev.project.import` registers a
project from an **authorized root bookmark**: the canonical root is resolved
fail-closed through the roots authority inside the host — a client-supplied
path never reaches the register — and a second registration for the same
bookmark is refused with `identity_mismatch` instead of silently duplicating.
Import and create commit the new project and every affected group's membership
ordering in one snapshot write. Every mutation enforces the scope triple
(`unauthorized`), the ownership epoch (`stale_generation`), and optimistic
concurrency (`stale_version`); a stored record that fails structural decode
fails closed with `corrupt_state` and is retained unread. The previous
`authority.json` envelope is migrated exactly once inside a SQLite transaction;
if migration is interrupted, the transaction rolls back and the next open
retries from the untouched JSON source only when it is the same database
identity. The earlier local `projection.json` is
seeded into the authority store exactly once and neither legacy JSON source is
deleted or rewritten. Other Dev Runtime authorities remain on the existing
JSON store until an independently reviewed migration slice covers their schema
and rollback contract.

On the client, project/session selection resolves only inside the active
scope's projection and enforces archive state, explicit revocation, generation
binding, and observation freshness; a stale projection renders a visible
staleness state instead of silently trusting the stored selection. Deep-link
selection (`devProject`/`devSession` query params) is deterministic: an
unknown query key survives, and a stale, archived, revoked, generation-stale,
or cross-scope link recovers to the closest live selection with a visible,
announced banner while the URL converges on the corrected selection. Sidebar
group/project reordering is accessible through pointer drag and keyboard
(`Alt`+`Arrow`) paths that produce the same
`dev.group.reorder`/`dev.project.reorder` commands; a refused reorder reverts
to the authoritative projection.

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
  | `dev.group.${'list' | 'create' | 'update' | 'delete' | 'reorder'}`
  | `dev.project.${'list' | 'get' | 'import' | 'clone' | 'scan' | 'create' | 'update' | 'reorder' | 'archive' | 'bookmarks'}`
  | `dev.repo.${'list' | 'inspect' | 'refresh' | 'authorize' | 'adopt' | 'credentialRefs'}`
  | `dev.worktree.${'list' | 'create' | 'retryBootstrap' | 'lease' | 'releaseLease' | 'mergePlan' | 'mergeCommit' | 'archive' | 'unarchive' | 'cleanupPlan' | 'cleanupCommit' | 'cleanupResume' | 'cleanupJobs'}`
  | `dev.terminal.${'create' | 'attach' | 'detach' | 'input' | 'resize' | 'signal' | 'terminate' | 'checkpoint' | 'search' | 'historyDelete' | 'list' | 'shellProfiles'}`
  | `dev.session.${'create' | 'get' | 'list' | 'launchDefault' | 'launchHarness' | 'resumeHarness' | 'cancelHarness' | 'events' | 'transferInput' | 'archive' | 'unarchive'}`
  | `dev.harness.${'managedPiStatus' | 'managedPiInstall' | 'acpConnect' | 'acpConnections' | 'acpClose' | 'preferences' | 'preferenceUpdate' | 'preferenceReset' | 'runStatus' | 'runs'}`
  | `dev.files.${'list' | 'stat' | 'read' | 'write' | 'create' | 'rename' | 'delete' | 'copy' | 'search' | 'openExternal' | 'readStream' | 'writeStream' | 'renameOverwritePlan' | 'renameOverwriteCommit' | 'deleteTreePlan' | 'deleteTreeCommit' | 'copyTreePlan' | 'copyTreeCommit'}`
  | `dev.git.${'status' | 'history' | 'diff' | 'stage' | 'unstage' | 'discardPlan' | 'discardCommit' | 'commit' | 'fetch' | 'checkpoint' | 'restorePlan' | 'restoreCommit'}`
  | `dev.browser.${'laneCreate' | 'laneClose' | 'lanes' | 'attach' | 'navigate' | 'targets' | 'viewport' | 'screenshot' | 'annotate' | 'inspect' | 'diagnostics' | 'takeover' | 'release' | 'input' | 'cookieImportPlan' | 'cookieImportCommit' | 'profileReset' | 'profilePolicies'}`
  | `dev.computeruse.${'capabilities' | 'lanes' | 'laneCreate' | 'laneClose' | 'consent' | 'attach' | 'input' | 'takeover' | 'release'}`
  | `dev.device.${'list' | 'sessions' | 'start' | 'attach' | 'input' | 'screenshot' | 'stop'}`
  | `dev.github.${'account' | 'repository' | 'issues' | 'milestones' | 'pullRequest' | 'pullRequests' | 'checks' | 'pushPlan' | 'pushCommit' | 'createPullRequest' | 'updatePlan' | 'updateCommit' | 'mergePlan' | 'mergeCommit'}`
  | `dev.resources.${'snapshot' | 'processes' | 'ports' | 'metrics' | 'usage' | 'stopPlan' | 'stopCommit' | 'retainedData'}`
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
stream negotiated from an authorized execute reply). The normative
[`dev-runtime-operations.json`](./dev-runtime-operations.json) registry provides
all 148 operation names, exact body shapes, exact reply types, complete required
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
  | { type: 'video'; sequence: string; timestampMs: number; keyframe: boolean; bytes: Uint8Array }
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
are never JSON/base64-transcoded. Browser/device
video uses `video`; terminal output uses `data`; control frames are canonical
CBOR with a 64 KiB maximum unless the grant's lower bound applies. Server output
pauses when credit is zero; client input never exceeds the grant and subsystem
queue caps. Reconnect obtains a new grant and starts from the last acknowledged
sequence/checkpoint; it never reuses attach proof or guesses continuity.

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

| Family              | Required operations                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev.capability`    | `snapshot`                                                                                                                                                                                                                                           |
| `dev.group`         | `list`, `create`, `update`, `delete`, `reorder`                                                                                                                                                                                                      |
| `dev.project`       | `list`, `get`, `import`, `clone`, `scan`, `create`, `update`, `reorder`, `archive`, `bookmarks`                                                                                                                                                      |
| `dev.repo`          | `list`, `inspect`, `refresh`, `authorize`, `adopt`, `credentialRefs`                                                                                                                                                                                 |
| `dev.worktree`      | `list`, `create`, `retryBootstrap`, `lease`, `releaseLease`, `mergePlan`, `mergeCommit`, `archive`, `unarchive`, `cleanupPlan`, `cleanupCommit`, `cleanupResume`, `cleanupJobs`                                                                      |
| `dev.terminal`      | `create`, `attach`, `detach`, `input`, `resize`, `signal`, `terminate`, `checkpoint`, `search`, `historyDelete`, `list`, `shellProfiles`                                                                                                             |
| `dev.session`       | `create`, `get`, `list`, `launchDefault`, `launchHarness`, `resumeHarness`, `cancelHarness`, `events`, `transferInput`, `archive`, `unarchive`                                                                                                       |
| `dev.harness`       | `managedPiStatus`, `managedPiInstall`, `acpConnect`, `acpConnections`, `acpClose`, `preferences`, `preferenceUpdate`, `preferenceReset`, `runStatus`, `runs`                                                                                         |
| `dev.files`         | `list`, `stat`, `read`, `write`, `create`, `rename`, `delete`, `copy`, `search`, `openExternal`, `readStream`, `writeStream`, `renameOverwritePlan`, `renameOverwriteCommit`, `deleteTreePlan`, `deleteTreeCommit`, `copyTreePlan`, `copyTreeCommit` |
| `dev.git`           | `status`, `history`, `diff`, `stage`, `unstage`, `discardPlan`, `discardCommit`, `commit`, `fetch`, `checkpoint`, `restorePlan`, `restoreCommit`                                                                                                     |
| `dev.browser`       | `laneCreate`, `laneClose`, `lanes`, `attach`, `navigate`, `targets`, `viewport`, `screenshot`, `annotate`, `inspect`, `diagnostics`, `takeover`, `release`, `input`, `cookieImportPlan`, `cookieImportCommit`, `profileReset`, `profilePolicies`     |
| `dev.computeruse`   | `capabilities`, `lanes`, `laneCreate`, `laneClose`, `consent`, `attach`, `input`, `takeover`, `release`                                                                                                                                              |
| `dev.device`        | `list`, `sessions`, `start`, `attach`, `input`, `screenshot`, `stop`                                                                                                                                                                                 |
| `dev.github`        | `account`, `repository`, `issues`, `milestones`, `pullRequest`, `pullRequests`, `checks`, `pushPlan`, `pushCommit`, `createPullRequest`, `updatePlan`, `updateCommit`, `mergePlan`, `mergeCommit`                                                    |
| `dev.resources`     | `snapshot`, `processes`, `ports`, `metrics`, `usage`, `stopPlan`, `stopCommit`, `retainedData`                                                                                                                                                       |
| `dev.cleanupPolicy` | `list`, `createDraft`, `approve`, `disable`, `evaluate`                                                                                                                                                                                              |
| `dev.appearance`    | client preference only; privileged host command only for capability snapshot                                                                                                                                                                         |
| `dev.appLibrary`    | existing verified catalog/install-plan authority; no new dynamic-code command                                                                                                                                                                        |

`dev.appearance` and `dev.appLibrary` intentionally have no operation in this
contract: `dev.capability.snapshot` is their only consumer — it reports each as
granted or typed-unavailable for the scope, and the client falls back to local
preference storage or the existing verified App Library surfaces accordingly.

Capability/resource binding is deny-by-default:

| Family        | Read operations                                                             | Mutation operations                                                                                         | Resource kind                                                       |
| ------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| capability    | authenticated channel; no feature capability (this snapshot reports grants) | none                                                                                                        | no resource                                                         |
| group         | `dev.project.read`                                                          | `dev.project.manage`                                                                                        | `group` except top-level list/create/reorder                        |
| project       | `dev.project.read`                                                          | `dev.project.manage`                                                                                        | `project` except top-level list/create/import/clone                 |
| repo          | `dev.repo.read`                                                             | `dev.repo.manage`                                                                                           | `repository`                                                        |
| worktree      | `dev.worktree.read`                                                         | `dev.worktree.manage`; cleanup additionally `dev.cleanup.approve`                                           | `worktree`                                                          |
| terminal      | `dev.terminal.attach`                                                       | input requires `dev.terminal.input`; lifecycle/signal requires `dev.terminal.manage`                        | `terminal`                                                          |
| session       | `dev.session.read`                                                          | harness lifecycle/input transfer requires `dev.session.manage`                                              | `runtime_session`                                                   |
| harness       | `dev.harness.read`                                                          | installation/connection/run control requires `dev.harness.manage`                                           | `acp_connection`, or `runtime_session` for `acpConnect`/`runStatus` |
| files         | `dev.files.read`                                                            | `dev.files.write`                                                                                           | `workspace_path` plus current root identity                         |
| git           | `dev.git.read`                                                              | `dev.git.write`; commit/restore/discard additionally require their current M11 approval when policy says so | `repository` or `worktree` as named by request                      |
| browser       | `dev.browser.read`                                                          | `dev.browser.control`; cookie/profile additionally `dev.browser.cookies`                                    | `browser_lane`                                                      |
| computeruse   | `dev.computeruse.read`                                                      | `dev.computeruse.control`; input additionally requires an active consent record                             | `computeruse_lane`                                                  |
| device        | `dev.device.read`                                                           | `dev.device.control`                                                                                        | `device_session`                                                    |
| github        | `dev.github.read`                                                           | `dev.github.write`; merge/push additionally require plan digest and current M11 approval/policy             | `repository` or `pull_request`                                      |
| resources     | `dev.resources.read`                                                        | stop requires `dev.resources.stop`; destructive cleanup also requires `dev.cleanup.approve`                 | target process/port/worktree resource                               |
| cleanupPolicy | `dev.resources.read`                                                        | create/approve/disable requires `dev.cleanup.approve`; evaluate executes nothing                            | `cleanup_policy`                                                    |

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

### Terminal UX

The terminal ships a styled default profile using theme tokens for font,
cursor, padding, opacity, and colors; a "system terminal" opt-out leaves the
host terminal untouched.

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

A group organizes projects; a project expresses user intent/defaults; a repo is
an authorized source; a worktree is one checkout; a session binds execution.
None is an alias for another.

A group is user organization: `name`, an optional `colorToken` from the theme
token vocabulary, and `sortKey` order. `dev.group.*` manages it. `create` places
the group after `afterGroupId` or at the end; `update` patches name/color/order
under expected version; `reorder` applies the submitted `orderedGroupIds`
atomically as one ordering decision and bumps each affected group's `version`
(a stale submission loses wholesale rather than interleaving); `delete`
requires an empty group — move or remove its projects first — plus a
`confirmationId`. Group collapse is ephemeral `packages/state` UI state, not a
host command.

The add surface supports recent/indexed folders, picker/import, clone URL,
authenticated GitHub selection, monorepo package, and known external worktree.
It displays host, canonical identity, duplicate state, and authorization before
mutation.

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
(`Project`, `Group`, `ProjectScanPage`); a success DTO without its decoder
still fails closed. The sidebar's add surface renders scan results as previews
requiring confirmation — duplicates are flagged against live projects and the
register's bookmark-binding check remains authoritative — and the sidebar's
session rows render the canonical `RuntimeSession` lifecycle from the register
(states outside the historical `active`/`ready`/`archived` set render a
neutral dot with their own accessible name, never a coerced state).

## Project archive/update and the repository registry

`dev.project.update` and `dev.project.archive` are served by the durable
project/session register. Both carry the `project` envelope resource whose
generation must equal the record's optimistic `version` (projects carry no
`generation` field). `update` patches only `ProjectMutableFields` (name,
group membership, preferred runtime node, default base ref, bootstrap
workflow, default harness) under the expected version; an unknown group in
`patch.groupIds` refuses the whole update before any write, the membership
delta (adds and removals together) commits in one atomic snapshot write that
bumps each affected group's version, and an archived project is frozen —
`update` refuses with `invalid_state` until the project is unarchived.
`archive` is a navigation-lifecycle flip only: `archived: true` refuses with
`invalid_state` while any non-archived session on the project is still live
(`preparing`, `ready`, `active`, `disconnected` — archive never stops or
deletes anything), refuses a flip to the current state, bumps the version,
and `archived: false` restores `ready`. Both publish a `dev.project.updated`
shell event; both replies decode through the strict `Project` decoder.

`dev.repo.adopt`, `dev.repo.authorize`, `dev.repo.inspect`, and
`dev.repo.refresh` form the repository registry (a companion register owning
`dev-runtime/repos/registry.json` with the same atomic fsync+rename store,
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
  under the named authorized bookmark and persists the durable record
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

Replies decode through the strict provider-owned `Repo`/`RepoInspection`
decoders (and the `Repo` page for `dev.repo.list`); a success DTO without its
decoder still fails closed. Git children run through the bounded, argv-only
#397 runner (`LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`,
fixed time and output budgets) — never a shell, never credential material in
arguments or environment.

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
(`stale` and `unavailable` render as states, not errors). `dev.project.archive`
passes the same explicit confirmation gate as the archive shelf; refusals
(live sessions, `stale_version`) surface as typed non-blocking notices and the
view reloads the authoritative state rather than keeping a fabricated outcome.
A runtime without the registry providers answers `capability_unavailable`, and
the panel renders that typed-unavailable state instead of dead controls.

## Worktree lifecycle

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
process. A fallback obeys equal or stricter limits.

### Shipped provider slice (M12 #399)

The desktop shell registers the control-path files/search operations
(`dev.files.list`, `stat`, `read`, `write`, `create`, `rename`, `delete`,
`copy`, `search`, `openExternal`) plus the bulk-stream grants
(`dev.files.readStream`, `dev.files.writeStream`) and the recursive/overwrite
plan-commit pairs (`dev.files.renameOverwritePlan`/`Commit`,
`dev.files.deleteTreePlan`/`Commit`, `dev.files.copyTreePlan`/`Commit`)
against the worktree service's canonical roots through a narrow
worktree-resolution seam. The provider re-proves the gate independently of it:
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
index are never touched. Restore and discard are plan/commit pairs whose
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
   AgentProfile version, model/options, and resume support;
3. idempotently create/attach the canonical `RuntimeSession` and acquire leases;
4. wait for authenticated shell readiness;
5. launch argv/cwd/sanitized environment;
6. attach native/ACP, else authenticated hook, else mark terminal fallback;
7. deliver initial prompt through native/ACP, harness API, or guarded PTY in that
   order, recording acknowledgement/provenance;
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

`HarnessRun` records persist durably per scope with bounded retention:
at most 200 runs, evicting the oldest TERMINAL runs first and never an active
run. History reads (`dev.harness.runs`) are newest-first with bounded pages
(default 100, maximum 500) and an opaque cursor. Resume remains
resume-as-new-generation under the same canonical `RuntimeSession`.

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
targets and `Page.createIsolatedWorld` gives element picking a frame-specific
execution context. The picker can therefore inspect same-origin and
cross-origin iframe DOM through the authorized CDP target without injecting a
page script. Screencast frames remain compositor output for the whole page;
they include iframe pixels but carry no separate iframe byte stream. A future
requirement for per-frame capture or frame-specific redaction needs a host
adapter that exposes OOPIF capture identities and coordinate transforms.

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
   forged record refuses;
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

Capability probing is honest per the permissions page's rules: a capability
exists only where a probe or host tool can prove it. Input synthesis requires
the accessibility grant (the `osascript` System Events probe proves it) and a
fixed-argv input tool on the host. Screen capture requires the screen
recording grant, whose native helper is deliberately deferred — until that
helper lands, capture reports typed `capability_unavailable` naming the
missing piece, and `dev.computeruse.capabilities` reports the row
truthfully. Accessibility-tree reading has no authorized bridge in this lane
and reports the same. Capability-missing and permission-denied states block
launch with actionable guidance through the permissions page (denied
accessibility routes to the exact Settings pane); TCC denial is never
silently degraded into a working-looking lane.

The current packaged shell does not expose a native Screen Recording helper,
CGWindow/ScreenCaptureKit bridge, or authorized accessibility-tree bridge to
the Bun process. The browser CDP frame path cannot satisfy computer-use
capture: it sees only the browser lane and cannot claim the full desktop.
Therefore #542's packaged activity-frame, TCC-denied, capture/input/takeover,
and reconnect smoke gates remain open until the host supplies those explicit
bridges and records their permission identity, frame provenance, and
generation revocation behavior.

| Capability | Depends on                                             | This lane's honest state until proven otherwise                          |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| input      | accessibility grant + host input tool + active consent | `denied`/`not_determined`/`unavailable` mirrors the probe; never assumed |
| capture    | screen recording grant + native capture helper         | `capability_unavailable` (native helper deferred)                        |
| ax_tree    | accessibility bridge for tree reads                    | `capability_unavailable` (no authorized bridge in this lane)             |

Threat-model closure (see `docs/security/dev-view-threat-model.md`,
TM-015–TM-017): agent-driven typing into privileged surfaces (password
fields, Terminal, sudo prompts) is bounded by consent records that name the
session, are single-use, and die with the run — but the residual risk is
accepted and documented, not engineered away; capture of secrets
(keychain/password-manager prompts) is why capture stays unavailable until a
redaction-classifying helper exists; grant escalation via harness compromise
is bounded by the gate re-deriving every admission from provider-owned state,
so a compromised harness can never extend, replay, or widen a grant.

## GitHub provider

`RemoteSourceProvider` exposes host-neutral IDs and DTOs. GitHub response objects
never enter UI state. Reads prefer API/GraphQL and use ETags/cursors; `gh` is an
authenticated transport option, never output to scrape.

Credentials are host/account scoped. Enterprise hosts require explicit trust;
github.com credentials are never sent elsewhere. All mutation results are
reread before success. PR create uses an idempotency/reconciliation key and
searches for an existing matching head/base after timeout. Before a PR-create
POST, the host durably records the authorized scope, repository, head, and base
as an opaque key under its owner-only runtime data directory. It returns only
an exact open head/base match whose head owner and base repository match the
authorized remote. A per-key file lock fences concurrent host processes before
the POST. A timed-out POST, lost response, verification failure, or
host crash keeps the record: later attempts reread GitHub, reconcile when the
matching PR becomes visible, and refuse another POST while the outcome is
unknown. A successful POST also requires an authoritative reread before the
record is cleared. A corrupt retained record also blocks further POSTs. An
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

## Process, port, metrics, and usage

A destructive process action requires an Adea launch record plus PID start
identity, executable identity, parent/process-group/session relationship,
runtime node, worktree/session owner, and generation. Recheck immediately before
every signal, or use a stable OS process handle. PID, PGID, name, argv, cwd,
parent, or port alone is insufficient. A replacement between scan and signal
must survive.

Ports derive first from launch/session metadata and are confirmed by scoped OS
inspection. Unknown owners are displayed as external without a stop button. No
LAN-wide scan, `pkill`, `killall`, or `lsof`-wide termination.

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
  loopback-only scan); unknown listeners are `unknown` with no stop path.
- Metrics are pull-based: a bounded sample is recorded when the snapshot or
  metrics surface is read, never on a timer. CPU is a monotonic delta
  between consecutive samples of one owner; the first sample carries no
  `cpuPercent`, and unobservable values stay absent (never numeric zero).
  History is bounded to 720 points per owner and 24 hours. Each pull makes at
  most one `ps` observation of 64 distinct PIDs. The sampler rotates that
  bounded window through the current inventory, so a stable large inventory
  is covered across successive pulls without a command burst or permanent
  first-page bias. An unsampled process has no fabricated metric.
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
are disabled while the session generation is unknown. The toolbar resources
detail sheet shows the process/port inventory, metric summaries, provider
usage cards, and the retained-data breakdown with cleanup context; absent
capability renders as typed states.

## Appearance and App Library

Client preference schema:

```ts
type AppearancePreferencesV2 = {
  version: 2
  mode: 'system' | 'light' | 'dark'
  lightThemeId: string
  darkThemeId: string
  accent: 'theme' | string
  surface: 'opaque' | 'frosted' | 'translucent'
  reduceTransparency: boolean
}
```

Migrate the old `theme` key without flash or deletion. System mode follows the
OS; pinned modes do not. Accent affects only semantic accent/interactive roles
and must pass contrast validation. OS or user reduced transparency forces
opaque. Browser content is not recolored. Terminal ANSI and CodeMirror
syntax/diff/search roles come from the same manifest and update without remount.

Appearance and rail preference storage uses a read-modify-write contract with
a recovery envelope: a malformed or future-version stored document is
quarantined — byte-for-byte, with a reason and capture time — into a separate
recovery key at read time, before any later write can touch the main key.
Saving valid preferences never destroys unread original data, and the legacy
key migrates without deletion. Layout storage retains unread values under its
unread key; rail storage quarantines malformed and future records the same
way. Storage-level round-trip tests, not only normalizer tests, pin each of
these behaviors.

Theme imports are deferred until signed App Library support and require a known
license/provenance or explicit `unknown/unverified`; “User supplied” does not
prove redistribution permission.

M12 App Library can activate only a bundled first-party entry ID after existing
catalog signature/digest/install-plan checks. Trust resolves through a
**compiled** trusted first-party entry registry — the build's own list of
shipped entry IDs, each bound to the view it mounts and carrying a build-time
entry digest the catalog record must echo verbatim. An arbitrary non-empty
`bundledEntryId` from a plugin manifest is never trusted by itself. Activation
is fail-closed and ordered: installation, registry membership
(`untrusted-entry`), entry-digest integrity (`integrity-failure`), verified
install-plan shape (`plan-unverified`), and catalog source revision (`stale`).
No downloaded JS, `eval`, remote module URL, arbitrary postinstall, or empty
placeholder view. Optional rail items can hide/reorder, but active/core
Chat/Dev/Virtual remain recoverable via App Library or Reset Navigation.

## macOS permissions onboarding

The permissions page (issue #471) reports macOS TCC permissions the shipped
features depend on: `accessibility`, `screen_recording`, `notifications`,
`automation_apple_events`, and `microphone`. No permission ships without a
recorded feature reason in the page row metadata, and nothing is auto-granted,
prompted in a loop, or probed from browser context.

Status rides the guarded legacy invoke path behind the M10 channel gate —
`desktop_permissions_snapshot` and `desktop_permissions_open_settings` — with
DTOs in `packages/types/src/desktop-permissions.ts`. The shell measures the
real host (`apps/desktop/shell/src/desktop-permissions.ts`) through fixed-argv
commands with injectable runners; single-flight coordination means concurrent
snapshots share one probe set. Every report carries its probe time; a re-check
reflects System Settings changes within one interaction (focus-return triggers
one, never a polling interval) and no app restart.

Capability matrix (permission × what this lane can honestly report):

| Permission              | Probe (fixed argv)                                                                                                    | granted | denied                        | not_determined                              | unavailable              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------- | ------------------------------------------- | ------------------------ |
| accessibility           | `osascript` System Events process count, 3 s deadline                                                                 | exit 0  | assistive-access refusal text | probe deadline hit (consent prompt pending) | other failures           |
| automation_apple_events | `osascript` Apple Event to Finder, 3 s deadline                                                                       | exit 0  | `errAEEventNotPermitted` text | probe deadline hit                          | other failures           |
| screen_recording        | none in this lane (native capture helper still deferred; computer-use capture stays typed-unavailable until it lands) | —       | —                             | —                                           | `capability_unavailable` |
| notifications           | none in this lane                                                                                                     | —       | —                             | —                                           | `capability_unavailable` |
| microphone              | none in this lane                                                                                                     | —       | —                             | —                                           | `capability_unavailable` |

`unavailable` is a first-class typed state (`capability_unavailable`,
`unsupported_platform`), never a stand-in for denied or granted, and no
fixture status exists in any production path (fixtures are E2E-only). A
non-macOS host reports `hostPlatform: 'other'`; a lane with no shell (plain
web tab) reports `hostPlatform: 'unknown'` and every row unavailable.

Deep links are the frozen `x-apple.systempreferences` anchors
(`Privacy_Accessibility`, `Privacy_ScreenCapture`,
`com.apple.preference.notifications`, `Privacy_Automation`,
`Privacy_Microphone`), resolved on macOS 13–15, held only in the shell's
`SETTINGS_PANES` table: the client names a permission id and the shell opens
that exact URL through fixed-argv `open`. No client string ever reaches argv,
and no arbitrary URL can be opened.

The page (`packages/dev-view/src/permissions/**`, a Solid pane with a pure
DOM-free model) groups rows into System control and System interactions,
shows per-permission purpose and the feature-level consequence of denial
("Without it: computer-use sessions cannot start"), and offers Request only
where a probe can actually surface the macOS consent prompt; a denied
permission's repair path is the exact Settings pane, because macOS ignores
re-prompts. Accessibility contract: all actions are real buttons in DOM order,
status changes and action outcomes are announced through a polite live region
(only on change — first paint stays quiet), the pane carries no transitions
(reduced motion needs no override), and rem-based wrapping layout survives
200% zoom. `packages/dev-view` consumes the page service port
(`MacPermissionsPageService`); the desktop lane binds it in
`apps/web/src/lib/desktop-permissions.ts`, and every other lane binds
`createUnavailableMacPermissionsService`.

Pinned by `packages/types/tests/desktop-permissions.test.ts`,
`apps/desktop/tests/shell-permissions.test.ts` (probe outcomes, fixed argv,
settings table, bridge commands), and
`packages/dev-view/tests/permissions-model.test.ts` (presentation, action
affordances, announcements, honest degradation).

## Data classification and redaction

```ts
type DataClassification =
  'public' | 'workspace_metadata' | 'workspace_private' | 'credential' | 'restricted_local'
```

| Data                                                | Minimum class                   | Client/event policy                            |
| --------------------------------------------------- | ------------------------------- | ---------------------------------------------- |
| IDs, capability names, generic status               | workspace metadata              | authorized workspace clients                   |
| local paths, repo names/remotes, command labels     | workspace private               | redact/home-alias remotely unless granted      |
| terminal bytes, prompts/results, file content/diffs | restricted local by default     | bounded explicit projection only               |
| screenshots/annotations/check logs                  | workspace private or restricted | provenance + retention + redaction             |
| cookies, tokens, keys, auth headers, secret env     | credential                      | never renderer event/log; vault operation only |
| usage account identifiers                           | workspace private               | safe display label, no token/account secret    |
| process argv/env                                    | restricted local                | sanitized labels only                          |

Redaction runs before persistence to shared logs/events and again before remote
serialization. Secret patterns are defense in depth, not authorization. Error
messages never echo untrusted payloads, credentials, full terminal output, or
private file content. Audit records contain IDs, operation, actor, scope,
result/error code, byte/count summaries, and redacted target labels.
Chat transcript projection also drops any `credential`-classified event before
rendering, including a malformed producer's otherwise renderable event kind.

## Error contract

```ts
type DevErrorCode =
  | 'unauthenticated'
  | 'unauthorized'
  | 'workspace_unavailable'
  | 'runtime_node_unavailable'
  | 'runtime_node_revoked'
  | 'capability_denied'
  | 'channel_unauthenticated'
  | 'channel_unauthorized'
  | 'token_expired'
  | 'replay_rejected'
  | 'not_found'
  | 'identity_mismatch'
  | 'stale_generation'
  | 'stale_version'
  | 'invalid_state'
  | 'unsupported_version'
  | 'corrupt_state'
  | 'already_completed'
  | 'idempotency_conflict'
  | 'unauthorized_root'
  | 'path_escape'
  | 'symlink_rejected'
  | 'special_file_rejected'
  | 'file_changed'
  | 'not_git_repo'
  | 'gitdir_unproven'
  | 'remote_unavailable'
  | 'base_not_found'
  | 'name_collision'
  | 'path_collision'
  | 'bootstrap_denied'
  | 'bootstrap_failed'
  | 'dirty'
  | 'unpushed'
  | 'behind'
  | 'conflicted'
  | 'protected_branch'
  | 'external_ownership'
  | 'dangerous_path'
  | 'nested_worktree'
  | 'lock_timeout'
  | 'unsupported_capability'
  | 'capability_unavailable'
  | 'unavailable'
  | 'limit_exceeded'
  | 'spawn_failed'
  | 'auth_required'
  | 'incompatible'
  | 'sidecar_incompatible'
  | 'profile_scope_denied'
  | 'remote_host_untrusted'
  | 'force_push_denied'
  | 'timeout'
  | 'cancelled'
  | 'backpressure'
  | 'sequence_gap'
  | 'resync_required'
  | 'checkpoint_corrupt'
  | 'crash_loop'
  | 'delivery_ambiguous'
  | 'navigation_blocked'
  | 'ssrf_blocked'
  | 'permission_denied'
  | 'cookie_import_failed'
  | 'rate_limited'
  | 'remote_changed'
  | 'branch_protected'
  | 'leased'
  | 'ownership_unproven'
  | 'plan_stale'
  | 'cleanup_blocked'
  | 'cleanup_partial'
  | 'recovery_required'
  | 'rollback_failed'

type DevError = {
  code: DevErrorCode
  retryable: boolean
  message: string
  remediation?: { action: string; parameters?: Record<string, string> }
  currentVersion?: number
  observedAt?: string
}
```

Stable codes include:

- authority: `unauthenticated`, `unauthorized`, `workspace_unavailable`,
  `runtime_node_unavailable`, `runtime_node_revoked`, `capability_denied`,
  `channel_unauthenticated` (missing/invalid channel credential),
  `channel_unauthorized` (authenticated channel lacks this operation/scope),
  `profile_scope_denied`, `token_expired`, `replay_rejected`;
- identity/state: `not_found`, `identity_mismatch`, `stale_generation`,
  `stale_version`, `invalid_state`, `unsupported_version`, `corrupt_state`,
  `already_completed`, `idempotency_conflict`;
- filesystem/git: `unauthorized_root`, `path_escape`, `symlink_rejected`,
  `special_file_rejected`, `file_changed`, `not_git_repo`, `gitdir_unproven`,
  `remote_unavailable`, `base_not_found`, `name_collision`, `path_collision`,
  `bootstrap_denied`, `bootstrap_failed`, `dirty`, `unpushed`, `behind`,
  `conflicted`, `protected_branch`, `external_ownership`, `dangerous_path`,
  `nested_worktree`, `lock_timeout`;
- runtime: `unsupported_capability` (platform can never provide it),
  `capability_unavailable` (known capability is temporarily not ready),
  `unavailable` (whole provider/read model unavailable), `limit_exceeded`,
  `spawn_failed`, `auth_required`, `incompatible`, `sidecar_incompatible`,
  `timeout`, `cancelled`, `backpressure`, `sequence_gap`,
  `resync_required`, `checkpoint_corrupt`, `crash_loop`, `delivery_ambiguous`;
- browser/provider: `navigation_blocked`, `ssrf_blocked`, `permission_denied`,
  `cookie_import_failed`, `rate_limited`, `remote_host_untrusted`,
  `remote_changed`, `branch_protected`, `force_push_denied`;
- cleanup: `leased`, `ownership_unproven`, `plan_stale`, `cleanup_blocked`,
  `cleanup_partial`, `recovery_required`, `rollback_failed`.

Messages may change; code, retryability, and remediation shape are API. Unknown
host failures map to `invalid_state`/`unsupported_version`, never success.

## Failure behavior

Every UI surface distinguishes `loading`, `empty`, `unavailable`, `stale`,
`degraded`, `error`, and `ready`. Provider loss keeps UI and recoverable data
mounted. Switching runtime node clears previous-node private data before loading
new data.

Required adversarial cases include:

- loopback/origin/channel spoof and token replay;
- account/workspace/node/resource/generation crossover;
- path traversal, symlink/parent swap, special files, newline/option injection;
- shell/argv/env and bootstrap/teardown injection;
- OSC/title/link/clipboard/paste and oversized fragmented protocol input;
- duplicate/out-of-order/gapped events and ambiguous prompt delivery;
- dirty/unpushed/external/protected cleanup and crash at every transition;
- PID/PGID/port reuse and unrelated process replacement;
- browser SSRF/rebinding/redirect, profile crossover, stale takeover;
- cookie partial failure and secret logging;
- malicious PR/check/issue and plugin/theme manifests;
- disk full, permission loss, watcher overflow, runtime disconnect/revoke,
  sidecar incompatibility/crash loop, sleep/wake, app update/rollback.

## Consolidated limits registry

Distributed subsystem text remains normative; this table is the implementer's
single lookup. A lower upstream M10/M11 limit wins. Limit exhaustion returns
partial metadata plus `limit_exceeded` or the more specific typed error; it
never truncates silently or allocates an unbounded fallback.

| Surface               | M12 initial limit                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| center layout         | 8 leaves, depth 8, ratio 0.1–0.9                                                                                                                                                                                                                                               |
| command               | 256 KiB control body; 60-second expiry; 30-second clock skew                                                                                                                                                                                                                   |
| nonce/idempotency     | ≥128-bit nonce; key 1–128 printable ASCII; completed mutation 24 hours–7 days                                                                                                                                                                                                  |
| event                 | 256 KiB JSON; depth 32; string 64 KiB; 1,000 frames/s; page 500/default 100; 100,000/session or 30 days                                                                                                                                                                        |
| hook/OSC              | authenticated hook frame 8 KiB; OSC payload 2 KiB                                                                                                                                                                                                                              |
| terminal              | 64 KiB chunks; 4 MiB/10,000-chunk memory ring; 256 MiB/session; 2 GiB/workspace; 4,096 sealed segments/session; 8 subscribers; 1 MiB input/subscriber queue                                                                                                                    |
| terminal liveness     | 15-second heartbeat; unhealthy at 45 seconds; reconnect 250 ms exponential to 30 seconds; checkpoint ≤5 seconds and each 1 MiB                                                                                                                                                 |
| scanner               | depth 16; 100,000 entries; 10,000 packages; 2 MiB/manifest; 10 seconds; concurrency 8                                                                                                                                                                                          |
| watcher/status        | 250 ms coalesce; refresh concurrency 4; degraded fingerprint no faster than 60 seconds                                                                                                                                                                                         |
| include copy          | 1,000 regular files; 100 MiB total; 16 MiB/file                                                                                                                                                                                                                                |
| bootstrap/teardown    | 15 minutes/step; 10 MiB output; one owned process group                                                                                                                                                                                                                        |
| files                 | directory page 500; inline read/write 256 KiB on the control path; bulk via `file-bytes-v1` stream (64 MiB, 64 KiB frames, 1 MiB read credit); editable 8 MiB; preview 64 MiB; 30-second operation; tree plans: depth 64, 5,000 items, 256 MiB copy volume, 10-minute plan TTL |
| editor/diff           | reduced tokenization after 10,000 lines or 5 MiB; 10,000 hunks/20 MiB rendered diff before metadata fallback                                                                                                                                                                   |
| search                | 10,000 matches; 1,000 matched files; 50 MiB scan-result budget; 1 MiB emitted; 30 seconds                                                                                                                                                                                      |
| git child             | 60 seconds and 10 MiB output unless an operation-specific lower limit applies                                                                                                                                                                                                  |
| harness discovery     | 1 MiB input; 1,000 models/commands; 64 KiB/record; 10 seconds                                                                                                                                                                                                                  |
| cookie import         | 10,000 cookies; 16 MiB serialized; atomic transaction                                                                                                                                                                                                                          |
| screencast            | 15 FPS default/30 max; 4096×4096; 8 MiB/frame; one in-flight plus newest; 240 inputs/s                                                                                                                                                                                         |
| computer-use frames   | same bounded publication and input caps as screencast; consent record ≤60 seconds and single-use                                                                                                                                                                               |
| screenshot/annotation | 25 MiB/item; 1 GiB/workspace; 30 days unless user pins it                                                                                                                                                                                                                      |

Screenshot references include lane/profile provenance, origin, viewport, and redaction state. The bounded encoded bytes remain retrievable by reference until expiry; metadata-only capture records are not valid evidence.
| metrics | 2 s active, 10 s visible idle, 60 s hidden; concurrency 4/node; 5-second/1 MiB child limits; 720 points and 24 hours |
| usage refresh | provider backoff plus 60-second manual-refresh floor |
| cleanup lock/lease | lock acquire 30 s; heartbeat 5 s/stale consideration 30 s; lease heartbeat 15 s/suspect 45 s |

## Performance and retention budgets

These are release gates on reference hardware unless an owner-approved measured
ADR waiver changes them:

- Chat/Virtual initial graphs contain no Dev/xterm/CodeMirror/browser code;
- cached Dev shell useful paint within 200 ms after chunk load;
- terminal local input-to-paint p95 ≤16 ms under ordinary output and no source
  byte loss under the burst fixture;
- common interactions target <16 ms; no fixture interaction task >50 ms;
- 1,000 project/session rows and 100,000 files are virtualized;
- 10,000-line file and 10,000-hunk diff use worker/bounded fallback;
- hidden Dev has no steady subprocess or per-row polling storm;
- explicit caps apply to terminal, events, browser frames, screenshots,
  checkpoints, metrics, and usage caches;
- 24-hour multi-session soak has bounded descriptors, listeners, processes,
  memory, disk, and network queues.

## Compatibility, migrations, and waivers

- Wire, durable-record, layout, appearance, sidecar, hook, and checkpoint formats
  each carry an independent integer version. A decoder accepts only versions it
  names; new optional fields require backward tests, while removed/renamed or
  semantic fields require a new version and migration.
- Migrations are idempotent, journaled, tested from every released version, and
  retain the original record until the migrated replacement commits. Failure
  returns `corrupt_state`/`unsupported_version` plus export/reset remediation;
  it never silently rewrites or deletes the input.
- Sidecar protocol compatibility is an explicit matrix in the packaged app.
  Compatible old sessions drain; incompatible versions return
  `sidecar_incompatible`; no PID/port adoption fallback exists.
- Runtime-node or credential rotation invalidates channels/tokens but not durable
  user data. Reconnect reauthorizes and resynchronizes by cursor/generation.
- A limit, performance, or platform waiver requires an owner-accepted issue and
  same-commit ADR/spec/plan update naming measurement, affected platform,
  expiry, fallback UX, and follow-up. Authorization, tenant isolation, lossless
  cleanup, credential/profile boundaries, provenance, and Warp/OpenGrok rules
  are not waivable.

## Test contract

Deterministic CI fixtures MUST include fake PTY, disposable git remotes and
worktrees, fake RuntimeConnection, native/ACP/hook/transcript harness corpus,
browser/CDP/device/cookie fixtures, GitHub pagination/rate/mutation fixtures,
metrics/PID/port-reuse fixtures, and corrupt/disk-full persistence.

Required layers:

1. decoder/property tests for IDs, envelopes, versions, paths, state machines;
2. pure reducer tests for layout, status, event precedence, plans;
3. host unit tests with injected filesystem/process/network clocks;
4. disposable-repo and fake-PTY integration tests;
5. packaged macOS tests for M10 channel authorization, real Bun PTY, CEF/CDP,
   sidecar adoption/update;
6. Playwright owner journey across 320/768/1280/1920 px and 80/100/200% zoom;
7. WCAG 2.2 AA keyboard, screen-reader, focus, separator, reduced-motion and
   reduced-transparency checks;
8. performance commands and a 24-hour soak with retained results;
9. provenance/package scans described in the donor audit.

Named evidence commands (root `package.json`; each exits nonzero on failure
and prints a retained summary under git-ignored `artifacts/dev-runtime/`):
`test:packaged` (the packaged macOS evidence lane, below),
`test:security:dev-runtime` (shell-channel/browser/vault/terminal-input
suites), `test:performance:dev-runtime`, `test:soak:dev-runtime`, and
`test:bundle:dev-view` (lazy-chunk boundary). The visual lane
(`test:e2e:visual` plus the `Workspace visual lane` workflow) renders every
document of `apps/web/e2e/conventional-workspace.spec.ts` without CSS
transitions (`apps/web/e2e/helpers/visual.ts`) so captures are always the
settled frame; baseline regeneration stays a single owner-run pass on the
final merged tree.

`test:packaged` is the packaged macOS evidence lane: it builds the
Electrobun `.app` (including the **bundled terminal sidecar component**,
staged by the packaging lane at `Contents/Resources/app/dev-runtime-sidecar/`
from the same source entry), then runs the packaged proof suite against the
real bundled layout and retains one JSON artifact per proof under
git-ignored `artifacts/packaged/`:

1. **Install-location resolution + supervision proofs** (`supervision-smoke`):
   every packaged component's manifest label resolves inside the `.app` with
   its real SHA-256 digest (the sidecar on the bundled Bun runtime
   `Contents/MacOS/bun`, the launcher resolution-only), the four
   supervision proofs run with the sidecar launched from the bundled layout,
   and proof 0 additionally exercises the production composition path: the
   shell entry's own manifest loader (`loadPackagedManifestForEntry`) must
   resolve the same components with the same digests from the bundled entry
   directory, so the install-location proofs run against the exact boot path
   the shipped composition is fed from. A missing bundle is a labeled dev
   fallback, never packaged evidence.
2. **Terminal replay across a host restart** (`packaged-terminal-smoke`): a
   packaged sidecar boot, a separate host process creating a real PTY
   session with a durable checkpoint history exceeding the memory ring
   (eviction), the host exiting, and a fresh host re-adopting the same live
   sidecar — durable search serves the new host, the ring replays its
   covered window exactly once in order, and live delivery continues.
   The flood's durable total is read from the session's checksummed
   segment files, not summed from checkpoint footers: the sink auto-flushes
   its open buffer every `checkpointIntervalBytes` (1 MiB), so most of the
   flood never passes through a host-visible footer. The below-ring
   durable-bridge replay is proven on this lane: an attach at `sinceSeq 0`
   (strictly beyond the 4 MiB memory ring) is served by the durable
   checkpoints bridging `[0, ringOldest)` plus the whole live ring —
   exactly once, contiguous, in order, byte-faithful — and after a seeded,
   bounded retention-GC eviction (`evictOldestSealedSegments`, the same GC
   the write-time pass runs) removes the bridge floor, the same attach
   resyncs to the deterministic live-ring anchor, the SAME anchor on every
   retry, with zero data frames — never a partial replay. The historical
   socket write-drop defect it was once blocked on is fixed by the
   serialized drain-aware writer (the "Sidecar transport writes"
   contract); the `packaged-transport-defect-probe` stays only as a
   finding recorder.
3. **Worktree digest containment** (`packaged-worktree-smoke`): worktree
   creation through the production registrar over the M10 gate, dependency-
   template promotion and per-file CoW materialization into a registrar-
   created worktree, post-promotion digest-tamper refusal
   (`identity_mismatch`, nothing cloned), and envelope generation fencing
   (`stale_generation`). Host-side modules run on the packaged lane; running
   them inside the packaged app process arrives with the production
   composition root and stays named work, not packaged evidence.
4. **Browser/devices matrix** (`packaged-browser-matrix`): organized by the
   host's engine era — what its Bun reports for `Bun.WebView` — so every row
   passes on both host classes and the proof never leaves a lane crashed.
   Era-agnostic rows: lane registration through the M10 gate with per-kind
   profile identities; the human_embedded lane's typed
   `capability_unavailable` (the packaged CEF handle is unexposed); an
   SSRF-target navigation refused by the provider's admission gate before any
   engine involvement; the SSRF regression matrix on the per-hop admission
   gate (loopback, metadata, and both textual IPv4-mapped-IPv6 forms); the
   typed capability matrix; and real host device inventory through the gate.
   Engine-available rows (conditional on `Bun.WebView` existing): lane
   provisioning and admitted navigation against the proof's own loopback
   Adea-owned service, admitHop-gated redirect chains (admitted per hop, and
   refused mid-flight onto an unowned loopback port), screenshot publication
   with provider-admitted provenance, frame publication through a real minted
   `browser-frames-v1` grant attached before the view exists, and crash →
   typed recovery (an admitted-but-dead owned port yields `crash_loop` and the
   same lane recovers to ready by navigating again). The engine-seam row
   (runs on both eras, last) proves through `attachBrowserEngine(undefined)`
   that an admitted navigation without an attached engine is refused with
   typed `capability_unavailable` — the engine-less era contract — never
   faked.

The `bun test` wrappers in `apps/desktop/tests/` shell out to the same
scripts and skip loudly when the bundle has not been built; the packaged
lane is the enforcement point. Run packaged test files one at a time in
fresh worktrees.

No issue closes on fixture-only production integration. Unsupported platform
states remain deterministic fixtures, but the local packaged macOS path must
pass before M12 release. M12 also requires authorized fake
RuntimeConnection/revocation/scope-isolation fixtures against the shared remote
adapter. Production remote RuntimeConnection certification is explicitly owned
by M14 and is not a hidden M12 acceptance criterion.

Real-process lane contract (packaged macOS smokes): `bun test` executes every
test file on one shared process thread, so a synchronous stall in any file
silences the whole runner at apparent zero CPU — the last printed file header
(often the real-PTY smoke) is not evidence of where a run is stuck. Every
real-process lane therefore owns its own truth: deadline-based readiness
polls (never fixed attempt counts sized for an idle machine), a per-test
budget with headroom over the sum of its inner bounds, drained child pipes,
and teardown that escalates SIGTERM to SIGKILL on observed exit so no
evidence lane can leak a sidecar orphan or hang the shared runner. Fixture
helpers that shell out synchronously (`git` in the worktree fixtures) pass an
explicit spawn timeout for the same reason.

## Spec changes

Post-baseline contract changes are recorded here so issue mirrors and audits
can distinguish intentional spec evolution from drift:

- **2026-09-22 — #424: on-device usage adapters and provable cleanup facts.**
  The `usage` surface stopped being truthful-empty where the runtime can prove
  a number: on-device adapters serve harness session counts and wall-clock
  durations from the registrar's durable run history and terminal
  durable-history bytes from the sealed checkpoint segments (source
  `harness_protocol`, confidence `measured`, declared 60-second freshness,
  bounded reads — no shell, no network, no spawning). Provider-billed usage
  has no reviewed endpoint and stays a typed `capability_unavailable` row;
  file-stream bytes stay typed-unavailable until a durable transfer journal
  exists. Cleanup facts became provable-or-absent: the worktree facts seam
  joins durable records to live read-only observations — `pr_merged` (with
  source) from the GitHub provider's durable merge journal verified against
  the remote ref, `active_owned_resources` from the composed owned-resource
  census observed asynchronously, plus git clean/pushed, leases, and
  `archived_seconds` — and the cleanup-policy authority awaits either facts
  shape, failing closed on unknown worktrees and unobservable facts. Pinned by
  `apps/desktop/tests/dev-runtime-resources.test.ts`.
- **2026-09-22 — M10 #33 vault metadata migration.** Credential references now
  migrate from the retained `dev-runtime/vault/credentials.json` envelope into
  the reviewed WAL/full-sync `credentials.sqlite3` store. Strict metadata
  decoding refuses secret-shaped fields, scope-invalid records, duplicate IDs,
  and malformed versions before persistence; migration rollback, restart
  recovery, SQLite loss, corrupt-payload retention, and the downgrade-visible
  revocation tombstone are pinned by `apps/desktop/tests/dev-runtime-vault.test.ts`.
  The Bun.secrets and legacy OS-keychain key adapter remains unchanged.
- **2026-09-21 — #185: live supervision events under a crash-storm bound,
  and the managed Pi as a truthful-absence manifest component.** Two
  follow-ups to the packaged supervision wiring. (1) The supervision
  engine's exit/unhealthy observations now surface as a LIVE typed shell
  event (`supervision.componentEvent`, the same bus path
  `git.statusInvalidated` rides): crash (`exit`, `expected: false`),
  restart (`start` with `start`/`restart`/`auto-restart` cause), operator
  and upgrade stops, unresponsive recycles (`unhealthy`), unadoptable
  persisted launches, and `crash_loop` verdicts are observable without
  polling ("Local stack supervision"). Payloads are engine-authored and
  secret-free; the live surface is bounded per component and kind (5 per
  sliding 60 seconds) — events beyond the cap are coalesced into a
  `suppressed` counter carried by the kind's next emitted event, while the
  durable journal and audit ring record everything unbounded. The numbers
  align with the 5-failures/10-minutes restart policy, so an engine-native
  crash storm is never coalesced and anything faster than the policy cannot
  flood the stream. The composition attaches the engine's sink to the shell
  event bus after every recomposition, before the boot steps run. (2) The
  managed Pi registers as a packaged manifest component: the manifest schema
  gains an additive `installKind` (`bundled` — bundle-relative label, strict
  boot-time resolution, unchanged for existing components; `managed-data-dir`
  — data-dir-relative label under the owner-only data root, resolved with
  truthful-absence semantics), the managed Pi entry carries the driver's
  build-time pin (pinned version + archive digest, process health probe,
  phase 1, no adoption protocol, optional), and before the first ensure the
  component is truthfully absent — typed absence, `spawn_failed` starts that
  never burn the crash-loop budget, and drift surfaced as a digest mismatch
  the driver heals ("The managed Pi installation lifecycle"). The ownership
  boundary is unchanged: the driver installs, the engine observes/starts per
  policy and never installs. Pinned by
  `apps/desktop/tests/supervision-supervisor.test.ts` (emission + bound),
  `apps/desktop/tests/supervision-manifest.test.ts` (install-kind decode),
  `apps/desktop/tests/dev-runtime-managed-pi.test.ts` (registration,
  truthful absence, digest-match and drift resolutions, containment), and
  the packaged supervision smoke's proofs 5–6.

- **2026-09-21 — M12: in-process command dispatch (`dispatchLocal`) and
  renderer push consumption of git status invalidations.** Two closures of the
  watcher slice's handoffs, with no new registry operations (the 163 stand) and
  no wire or limits change. (1) The channel authority gained an in-process
  dispatch seam, `authority.dispatchLocal` ("Command envelope and
  authorization"): trusted shell code dispatches a fully-formed `DevCommand`
  through the same terminal steps the socket path runs — the exact
  `decodeDevCommand` structural decoder, the freshness/expiry window, scope
  admission via `authorizeCommand` (no channel identity on this lane),
  capability derivation, registered-provider invocation, and the shared
  `DevReply`/audit/refusal machinery — gated by a module-private
  `INTERNAL_DISPATCH_MARKER` whose absence or mismatch throws
  `channel_unauthenticated` before the command is examined (fail closed). The
  marker replaces only the proofs an internal caller satisfies structurally —
  trusted origin, channel credential/identity proof, and replay — because the
  envelope is authored in-process and holds no client-supplied bytes; resource
  binding and the generation fence stay with the provider exactly as for an
  external caller, and the lane's audit records carry no channel fields, making
  internal dispatches distinguishable in the audit trail. The git watcher
  lane's `readStatus` seam now dispatches the registered `dev.git.status`
  provider through this seam instead of calling the handler directly (the
  one-place upgrade the registrar's comment promised); watcher refreshes leave
  channel-less `command_accepted` audit records, and a lost race still
  resolves to an honestly empty cache. (2) The desktop `DevRuntimeService`
  gained an optional `events()` subscription surface ("Watcher-driven status
  invalidation"): typed, capability-checked (subscribe only on a granted
  `dev.git.read` snapshot — fail closed), generation-fenced delivery of
  `git.statusInvalidated` over the gateway's existing signed event stream via
  the bridge's existing `listen` seam (the frozen bridge contract is not
  widened). SSE payloads are structurally validated before delivery — a
  malformed frame is dropped, never trusted. The source-control pane's status
  cache and the files pane's marker cache consume pushes through one shared
  pure predicate (`pushInvalidationDecision`): same-generation
  `tree_changed`/`degraded` invalidates and repopulates through the
  capability-checked pull, a moved generation re-resolves the context, and
  other worktrees' events plus `refreshed`/`stopped` bookkeeping are ignored.
  Push never carries status bytes: with no event surface (web non-desktop
  runtime, or a bridge predating `listen`) panes keep generation-fenced pull
  unchanged. Pinned by `apps/desktop/tests/dev-runtime-dispatch-local.test.ts`
  (the seam contract plus socket-path parity),
  `apps/desktop/tests/dev-runtime-git-watcher-dispatch.test.ts` (the watcher
  read rides the gate, audited channel-less),
  `apps/web/test/desktop-event-surface.test.ts` (the renderer surface), and
  the extended `packages/dev-view/tests/status-cache.test.ts`.

- **2026-09-21 — #399 residue: the stream inbound validator is reconciled per
  direction (write frames carry byte offsets, not counters).** The generic
  inbound validator (`createStreamInbound`) required client sequences strictly
  above the grant's `fromSequence`, which is correct for sequence-counter
  frames but wrong for the write direction, whose frames carry byte-offset
  sequences — the first `file-bytes-v1` chunk legitimately equals
  `fromSequence` (`'0'`), so every WebSocket write attach would have been
  refused on its first frame (never fired in production: nothing attached via
  WebSocket; the relay had deferred offset contiguity to the provider). The
  validator is now grant-direction-aware on sequencing: `read` grants accept
  only client credit (`ack`) exactly as before — byte-for-byte unchanged —
  while `write` grants enforce byte-offset contiguity on byte-bearing `input`
  frames (first chunk exactly at `fromSequence`, every later chunk exactly at
  the running offset end = previous offset + bytes length; gaps, replays, and
  overlaps all close typed `incompatible`) and keep strictly increasing event
  sequences on byte-less `gesture`/`resize` frames that never fall behind
  bytes already consumed. Direction, generation fencing, and frame-bound
  checks are unchanged. The shell-side stream relay applies the shared
  discipline verbatim again (the write-direction deferral is gone); its relay
  legs (JSON/base64, ≤ 64 KiB frames, ≤ 128 KiB decode bound) are unchanged,
  and the provider's byte-exact atomic-write guarantees stand on top. Gateway
  consumers audited under the new write rule: the full-duplex WebSocket path
  has no production write attach today (file streams ride the relay; the
  terminal pane renders a placeholder; `browser-frames-v1`/`device-frames-v1`
  registers an unavailable stream), the `desktop-frames-v1` computer-use write
  path re-derives admission provider-side and now additionally requires
  byte-offset sequences from any future client, and read-direction behavior
  is identical. Pinned by the extended `shell-channel.test.ts` validator
  cases (first chunk at `fromSequence` passes; gapped, replayed, and
  overlapping offsets close typed) and the new `file-stream-relay.test.ts`
  offset-discipline case. No wire, registry, or limits change (the 163
  operations stand).

- **2026-09-21 — #31: the managed Pi installation lifecycle is real (zero
  manual Pi installation).** The managed Pi driver's archive resolution is no
  longer a test-only seam: the production chain is "installed at the pin →
  bundled archive (packaged app dir) → data-dir cache → one bounded fetch of
  a build-time pinned URL" ("The managed Pi installation lifecycle"). The URL
  embeds the exact pinned version (never a "latest" lookup) and is published
  together with the version and archive digest; downloads are hard-capped,
  deadline-bounded, and cached only after digest verification. The failure
  matrix is typed end to end (`capability_unavailable`, `unavailable`,
  `remote_unavailable`, `timeout`, `limit_exceeded`, `corrupt_state`,
  `incompatible`), including version drift: a `ready` record cache-hits only
  when the on-disk manifest still declares the pin, a drifted installation
  heals by reinstall, and a failed heal revokes the ready claim with a typed
  `incompatible` naming the drift. The fetch path carries a Bun
  runtime-version guard (adea#490) refusing older/unknown runtimes while
  local sources still install. Ensures are single-flight, and the composition
  gained an explicit `managedPiAutoInstall` opt-in boot warm (fire-and-forget,
  never run for scripted drivers) plus a `managedPiArchiveResolver` override
  for the default driver. No new registry operations (163 stand); the
  ownership boundary is unchanged — the driver installs/launches nothing but
  the pinned runtime and owns no decision-layer behavior. Pinned by
  `apps/desktop/tests/dev-runtime-managed-pi.test.ts`.
- **2026-09-21 — #185/#396 residues: boot reconcile adoption, the shell
  terminal lane's packaged sidecar, and the below-ring bridge replay.** The
  packaged shell entry now reconciles at boot ("Local stack supervision"):
  after the composition holds the engine, the durable launch journal is
  reconciled — a sidecar launch persisted by a previous app run is adopted
  through the full ownership re-proof (PID start identity + executable
  identity + observable group; never clobbering a launch the engine owns)
  or journaled as an unadoptable expected exit; a boot without an engine
  reconciles nothing, and the boot step reports outcomes from durable facts
  only (the engine's adoption audit joined against the journal), never
  throwing. The shell's terminal lane adopts its sidecar through one typed
  seam ("Sidecar adoption"): a packaged boot's spawn belongs to the
  supervision engine (the packaged adapter command — bundled Bun runtime +
  bundled entry — so the journal records it) and the adoption verdict is
  the engine's `evaluateAdoption`; a dev run keeps the dev fallback
  (source-tree entry); a packaged boot never falls back to a dev spawn.
  The packaged manifest's sidecar registration protocol is corrected to the
  wire constant `adea-terminal-sidecar` (it declared a name the sidecar
  never registers with, which would make the engine's name-and-major
  verdict refuse the real endpoint protocol); the supervision smoke's dev
  manifest is corrected the same way. The packaged terminal replay lane now
  proves the below-ring durable-bridge replay end to end ("`test:packaged`",
  terminal replay): a sinceSeq-0 attach beyond the 4 MiB ring is served by
  the durable bridge plus the whole live ring exactly once in order and
  byte-faithful, and a seeded, bounded retention-GC eviction
  (`evictOldestSealedSegments`) turns the same attach into the
  deterministic resync anchor on every retry with zero data frames — never
  a partial replay; the former "known transport boundary / documented
  handoff" note is closed. Supervision smoke timing: the smoke's engine
  construction now injects the clock and probe delay explicitly (the
  #185 timer-flake policy — grace windows measured on the injected clock in
  bounded probe ticks, never the engine's `setTimeout` default). No
  supervision state-machine semantics changed; no new registry operations.
  "Local stack supervision", "Sidecar adoption", and the packaged-lane
  terminal-replay item updated; pinned by
  `apps/desktop/tests/supervision-boot-reconcile.test.ts` and the extended
  `packaged-terminal-smoke` checks.
- **2026-09-21 — M12: the watcher-driven status invalidation lane is
  constructed in production, and the Dev View caches follow its honesty
  contract.** The git registrar now composes the previously unconstructed
  watcher module: one bounded watcher per ready worktree, reconciled on the
  git dispatch path against the live worktree record (created on the first
  ready sighting, `refence`d when the live generation moves, stopped and
  discarded when the record disappears or stops being ready — lifetime bound
  to the worktree's live/generation state, no polling, no second lifecycle
  authority). Production seams are the module defaults: recursive `fs.watch`
  through the deprecation-safe handle factory and the `setTimeout` coalesce
  scheduler, with one refresh gate (4) shared by a host's watchers; a
  platform that cannot watch degrades exactly once to the typed
  `mode: 'degraded'` snapshot and never refuses a command. The injected
  `readStatus` dispatches the REGISTERED `dev.git.status` provider with a
  full command envelope pinned to the live generation — the public path,
  never a private shortcut — so every admission proof re-runs as for an
  external caller and a lost race resolves to an honestly empty cache.
  Tree-moving mutations invalidate through the manual lane. Watcher events
  publish on the shell event bus as `git.statusInvalidated` (secret-free;
  the gateway's authenticated SSE stream carries them). Renderer-side, the
  source-control pane's status cache and the files pane's marker cache
  become generation-fenced client caches: invalidation and failed refreshes
  turn them UNDEFINED — never stale-fresh — a moved worktree generation
  refences them, and only a successful capability-checked dispatch
  repopulates them. No wire, registry, or limits change (the 163 operations
  and the watcher/status limits row stand). Pinned by the extended
  `apps/desktop/tests/git-status-watcher.test.ts` and the new
  `packages/dev-view/tests/status-cache.test.ts`.
- **2026-09-21 — #399 residue: the desktop client attach for `file-bytes-v1`.**
  `DevRuntimeService.streams()` is now production-bound on the desktop: the
  injected bridge signs stream-attach proofs inside its closure (the channel
  secret never leaves it), and a shell-side stream relay composed in the shell
  entry consumes the grant through the authority's real `attachStream`,
  applies the gateway's inbound frame discipline, and drives the real
  `file-bytes-v1` provider byte-halves over an in-memory session on the page's
  own channel — no second WebSocket exists (the bootstrap is consumed once per
  page, handshakes mint new channels, and grants are caller-channel-bound).
  Frames ride the signed event/invoke paths (base64 within the frame bound,
  strict send-order delivery); stream-backed open/save activate only when the
  bridge seam binds, and refused binds surface typed
  `capability_unavailable`. Residual (reconciled later the same day, see the
  wire-validator entry): the generic inbound validator's strictly-increasing
  client-sequence rule conflicted with the write
  direction's byte-offset sequences (first chunk equals `fromSequence`); the
  relay kept the validator's direction/generation/frame-bound checks and
  deferred offset contiguity to the provider until the validator was
  reconciled.
  No new registry operations (the 163 from the hunk-staging delta stand).
- **2026-09-21 — #399/#396 residues: checkpoint retention/GC and
  watcher-driven status invalidation.** Terminal durable history is now
  bounded by an explicit GC policy enforced at durable-write time
  ("Checkpoint retention and GC"): the spec's 256 MiB/session and
  2 GiB/workspace byte budgets plus a new named 4,096 sealed
  segments/session count cap; eviction is strictly oldest-sealed-first with
  the newest surviving segment kept, so the sealed chain stays contiguous
  from its oldest survivor forward and any pruned span resolves through the
  unchanged deterministic-resync anchor — never a partial replay. A live
  replay window is protected: the sidecar reserves the bridge span from
  `sinceSeq` for the duration of a durable bridge replay, a reserved
  segment (and everything newer) is never evicted, and a fully protected
  scope stays over budget truthfully. Deletion is atomic per segment
  (containment re-proof, same-directory tombstone rename, unlink; crashed
  tombstones are swept); quarantined bytes are never GC'd. The scope pass
  evicts the oldest eligible session whole after retention protection
  (active writer and live floors ineligible). Retention constants are
  exported from `terminal/retention.ts` (`CHECKPOINT_RETENTION`); no wire,
  durable-format, or registry change. Alongside it, the git status lane
  gained its watcher-driven invalidation contract ("Watcher-driven status
  invalidation"): one bounded recursive watcher per ready worktree root
  (deprecation-safe handle factory, one-time degrade to a ≤60-second
  demand-driven stat fingerprint), 250 ms burst coalescing into one
  invalidation and at most one refresh, refresh concurrency 4 through a
  shared gate with per-watcher in-flight dedupe, and generation-fenced
  cache/events/in-flight reads — the git provider is untouched (status
  flows through an injected `readStatus` seam). Limits registry terminal
  row updated with the sealed-segment cap; the watcher/status row is now
  implemented for this lane.
- **2026-09-21 — #399 residues: hunk-level staging and files-pane quick-open.**
  Added `dev.git.hunkStagingPlan`/`dev.git.hunkStagingCommit` (total operations
  163). The plan carries structured `DiffHunk` selections (≤ 200) and a
  `stage`/`unstage` direction; the provider never trusts client patch text —
  it re-runs the authoritative diff over the exact `git apply --cached`
  pre-image, locates every selected hunk by path plus `@@` header quadruple,
  and slices git's own output verbatim into the plan's patch (missing hunks
  are `stale_version`). The commit re-proves the worktree generation and the
  index fingerprint (`stale_generation`/`stale_version`), then applies the
  stored patch offline via fixed argv (`git apply --cached [--reverse]
--whitespace=nowarn`) with the patch on stdin; application failure is typed
  `invalid_state`, commits are single-use and reply with the re-read
  `GitStatus`. The source-control pane grows per-hunk stage/unstage buttons on
  its diff view (client-side splitting is the tested pure `splitFileHunks`
  model), additive to file-level stage/unstage. The files pane grows
  quick-open: a keyboard-first picker (Ctrl/Cmd+P or toolbar) over the paths
  loaded into the tree, fuzzy-ranked with bounded results (20), opening files
  through the existing identity-pinned open path. Fuzzy-over-loaded-paths is
  the accepted v1; a prebuilt whole-worktree index is an explicitly deferred
  future slice. Registry regenerated (163).
- **2026-09-21 — the shipped shell loads the packaged component manifest
  (#185 one-supervisor wiring).** The last #185 code gap: the production
  shell entry (`apps/desktop/shell/src/bun/index.ts`) never fed the
  composition root's `componentManifest` seam, so the shipped shell kept
  truthful-empty resource listings and never constructed the supervision
  engine. The entry now loads the manifest at boot — it locates the `.app`
  it runs from (`Contents/Resources/app` → bundle root) and resolves the
  component manifest through the packaging lane's strict install-location
  resolution (`loadPackagedManifestForEntry` in
  `apps/desktop/shell/scripts/packaged-install.ts`), the same resolution the
  packaged supervision smoke's proof 0 exercises. A repo dev run (no bundle)
  and a found bundle whose resolution or strict decode fails (missing or
  non-artifact install entries) load nothing: the shell logs the typed
  reason and boots the truthful no-supervision composition — truthful-empty
  listings, `capability_unavailable` stops — never fabricated state. The
  packaged supervision smoke's proof 0 now also asserts the entry loader
  resolves the same components and digests as the lane's own resolution, so
  the install-location proofs exercise the real composition path. No
  supervision state-machine semantics changed; no new registry operations.
  "Local stack supervision", "Host provider policy (M12 #424)", and the
  packaged-lane note updated; pinned by the three #185 wiring tests in
  `apps/desktop/tests/dev-runtime-composition.test.ts`.- **2026-09-20 — #399 residue: `file-bytes-v1` bulk stream, overwrite rename
  plan/commit, and recursive delete/copy plans.** Added six
  `dev.files.*Plan`/`*Commit` operations — `renameOverwrite` (pins BOTH the
  moving source and the colliding destination identity; the one sanctioned
  clobber), `deleteTree` (bounded dry-run enumeration: depth ≤ 64, ≤ 5,000
  items, per-item mtime/size facts, symlink/special-file refusal, explicit
  confirmation id), and `copyTree` (same enumeration plus a 256 MiB volume
  budget; destination must be free) — with `FileTreeMutationResult` as the
  commit reply DTO and `MutationPlan` as the plan reply. Plans expire after
  10 minutes, commits verify the plan digest and are single-use, and every
  commit re-proves the enumerated tree against the live lstat before
  touching anything (`plan_stale`/`file_changed` on drift). The desktop
  shell's files registrar additionally landed the `file-bytes-v1` gateway
  attach: `readStream`/`writeStream` mint single-use 60 s grants bound to the
  channel identity, the `workspace_root` resource generation, and the CAS
  file identity; attached reads pump 64 KiB `data` frames at byte-offset
  sequences with ≤ 1 MiB unacknowledged credit; attached writes accumulate
  generation-stamped chunks in an owner-only same-directory temp file and
  rename atomically only after length, digest, and identity re-proof —
  any mismatch discards the temp and reports `file_changed`. Bulk writes are
  byte-exact (`lf`/`crlf` policies are refused there with `invalid_state`);
  without a composed gateway the two stream operations stay
  typed-unavailable. Registry regenerated (total operations 161).
- **2026-09-20 — #400 deferred residues closed: the ACP lane prompt handoff
  and the harness-in-PTY spawn path.** The two residues the merged launch
  slice explicitly deferred. (1) The ACP lane's silent deferral becomes a
  typed handoff: `lane.deliverPrompt` (host-internal lane seam, no new
  operation; total operations unchanged at 155) receives the run/session-bound
  prompt, is generation-fenced and session-bound like every lane mutation,
  and either delivers through the lane's structured transport or refuses
  typed (`identity_mismatch`/`invalid_state`/`stale_generation`/`not_found`,
  or `capability_unavailable` for a driver without a delivery seam). An
  accepted handoff records one host `turn.user_input` provenance event
  (transport `acp`, connection identity, byte count, process identity);
  refusals record `capability.degraded`; both dedupe on `host:prompt:<runId>`;
  the host never touches the PTY input stream while a lane is live and never
  fabricates a harness turn event over the lane's tier. "Initial prompt
  delivery" updated; pinned by `dev-runtime-harness-prompt.test.ts` and the
  lane-level fence test in `dev-runtime-harness.test.ts`. (2) The
  harness-in-PTY spawn path: `dev.session.launchHarness` and
  `dev.session.launchDefault` accept an optional `attachTerminal` body flag,
  and the launch spawns the host-resolved installation executable (argv[0]
  alone) as the PTY child of a NEW session-bound terminal through the
  terminal runtime's `terminal.create` spawn patterns — BEFORE the run record
  and `run.starting` exist, so a failed spawn refuses typed `spawn_failed`
  with no fabricated run and an absent terminal runtime refuses
  `capability_unavailable`. The run DTO carries `terminalId`/
  `terminalGeneration` (additive, strict decoder updated; registry artifact
  regenerated), `run.starting` records transport `pty_process`, and later
  status derives ONLY from sidecar-OBSERVED terminations: first notice
  naming the bound terminal consumed, foreign terminals/generations inert,
  0 → completed, non-zero → failed, null (signalled) → disconnected (a
  signal is never an exit status), illegal edges demote to `disconnected`
  preserving the observed code, terminal states never overwritten, cancel
  signals nothing. New "Harness-in-PTY spawn (attachTerminal)" section; the
  Agents pane surfaces the binding additively ("in terminal" badge). Pinned
  by `dev-runtime-harness-pty-spawn.test.ts` (real in-process sidecar over
  the fake PTY plus a register-level rig with scripted exit subscription and
  injected clock).
- **2026-09-20 — repository registry providers and project archive/update
  (#398 follow-up).** The previously typed-unavailable `dev.repo.adopt`/
  `authorize`/`inspect`/`refresh` and `dev.project.update`/`archive`
  operations gained reachable production providers (total operations
  unchanged). The project/session register serves `dev.project.update` /
  `dev.project.archive`: mutable-field patches with group-membership
  consistency, archived-project freeze, and an archive flip that refuses
  while any session on the project is live; both bind the `project` resource
  at the record's version and publish `dev.project.updated`. A new durable
  repository registry (`dev-runtime/repos/registry.json`) serves the repo
  family over the import-minted `Project.repos` bindings: adopt re-proves
  kind/identity/containment under the authorized bookmark and records the
  canonical remote and default ref from local git config only; authorize
  binds a vault credential reference whose host must equal the remote's
  proven host; inspect computes read-only facts network-free; refresh probes
  the remote offline-safe (`git ls-remote origin HEAD`) and degrades the
  durable record to `stale`/`unavailable` typed truth. Strict
  `Repo`/`RepoInspection` decoders (plus the `dev.repo.list` page) installed;
  `dev.project.list`/`dev.project.get` reply decoders remain an explicit
  handoff for the project-registry slice. No acceptance criteria changed.

- **2026-09-20 — packaged macOS evidence lane (M12 packaged-evidence wave,
  #396/#397/#422/#185 re-closure evidence).** `test:packaged` now builds the
  bundled terminal sidecar component into the `.app`
  (`Contents/Resources/app/dev-runtime-sidecar/`) and runs the packaged proof
  suite against the real bundled layout, retaining one artifact per proof
  under `artifacts/packaged/`: install-location resolution with real artifact
  digests feeding the component manifest, the supervision proofs on the
  bundled layout, terminal durable-checkpoint replay across a host restart,
  worktree template materialization + digest-tamper refusal through the
  production registrar, and the browser/devices packaged matrix without a
  real engine (typed capability states; the engine lane stays named
  out-of-scope). Records the sidecar transport finding: Bun unix socket
  writes drop past the send buffer and the sidecar duplex never checks
  writability, so below-ring durable-bridge replay is blocked until the
  transport drains (`packaged-transport-defect-probe` retains the
  reproduction). No supervision or replay state-machine semantics changed.

- **2026-09-20 — #400 launch residues: initial prompt delivery, runtime-events
  e2e proof, pane mounts, and reset pinning.** `dev.session.launchHarness` and
  `dev.session.launchDefault` accept an optional bounded `initialPrompt`
  (1–64 KiB; total operations unchanged) delivered per launch step 7: guarded
  PTY input for PTY-backed launches (the terminal input authority's
  `prompt_delivery` single-writer takeover, per-chunk re-admission, one
  bounded submit, exactly-once per run via the idempotent-launch early return
  plus `host:prompt:<runId>` dedupe), explicit deferral to the ACP lane
  adapter while a live ACP lane owns the session, and canonical
  provenance-only `turn.user_input` (`workspace_private`) or
  `capability.degraded` events — never prompt content in the event log, never
  a launch failure from a delivery failure. New "Initial prompt delivery"
  section. The Agents pane mounts the harness status surface and the History
  pane the run-history rows (lazy-chunked, per "Runtime activity"). The
  reset-to-defaults contract (scope-wide vs per-project reset, version-0
  re-addressing, discovery/runs untouched) is documented and pinned.
- **2026-09-19 — supervised computer-use lanes (#472, planning slice).**
  Added the `dev.computeruse` operation family (`capabilities`, `lanes`,
  `laneCreate`, `laneClose`, `consent`, `attach`, `input`, `takeover`,
  `release`; total operations 148) and the `desktop-frames-v1` stream
  protocol, with the new "Computer use lanes" section: session-scoped lanes
  whose grants die with the runtime session, an authority gate that
  re-derives every admission from provider-owned state (scope binding,
  generation fencing, automation owner, issuance-backed single-use ≤60 s
  consent records tied to the #471 permission substrate, fresh-permission
  re-checks), a kill switch that revokes input authority immediately, stale
  input inert by generation, screencast-inherited frame/input bounds
  (15/30 FPS, 4096×4096, 8 MiB, 240 inputs/s), and honest capability probing
  — capture and accessibility-tree reading are typed
  `capability_unavailable` until the deferred native capture helper and an
  authorized AX bridge exist. Threat-model additions TM-015–TM-017
  (privileged-surface typing, secret capture, grant escalation) land with
  this slice.
- **2026-09-19 — M10 #33/#34 substrate-gap closure: spawn environment
  allowlist, executed rollback, and pinned failure-injection evidence.** The
  "Local stack supervision" rules gain two bullets: a supervised component
  child's environment starts from a positive allowlist of host keys plus the
  packaging lane's declared additions (the shell's whole environment is never
  inherited; argv arrays are handed to the OS verbatim), and an update
  rollback is executed against the real install layout — the failed artifact
  quarantined with raw bytes retained, the explicit staged previous install
  restored only after it proves complete, an implicit rollback refused, and
  component data locations never touched. No supervision state-machine
  semantics changed. The paragraph is now also pinned by the
  environment-contract, failure-injection (gateway loss, duplicate remote
  command replay, host sleep/wake clock jump, supervision ledger expiry),
  vault key-role-confusion, shell/argv/OSC injection adversarial, and
  executed-rollback test files.
- **2026-09-19 — Dev View product completion, preferences trust, and App
  Library activation trust (#395/#425).** Added the "Durable project/session
  authority (desktop host)" section: the shell register is the canonical,
  durably persisted project/session/archive authority with transactional
  `ArchiveRecord` commits, scope/generation/version enforcement, and a
  one-time retained seed from the legacy projection; client selection now
  enforces scope, generation, revocation, freshness, and archive state with
  deterministic, self-converging `devProject`/`devSession` deep links and
  accessible pointer+keyboard reordering. Specified the appearance/rail
  storage recovery-envelope contract (unread originals survive later valid
  writes) and the compiled trusted first-party entry registry with ordered
  fail-closed activation reasons (`untrusted-entry`, `integrity-failure`,
  `plan-unverified`, `stale`). No registry operations were added or changed.
- **2026-09-19 — project registry providers, monorepo scan, and contextual
  sidebar wiring (#398).** The previously typed-unavailable
  `dev.group.create`/`update`/`delete`, `dev.project.import`/`create`, and
  `dev.project.scan` operations gained reachable production providers.
  Import/create are served by the durable project/session register (snapshot
  writes keep project and group membership consistent; import resolves the
  authorized root bookmark fail-closed and refuses duplicates with
  `identity_mismatch`); scan is a companion provider whose canonical root
  comes only from the bookmark recheck, with fingerprint-keyed caching,
  fingerprint-bound cursors (`stale_version` on a moved scan), and partial
  results carrying `budget_exhausted`/`cancelled` diagnostics. Group
  `update`/`delete` require the `group` envelope resource binding; `delete`
  additionally requires an empty group and a `confirmationId`. Additive
  `Project.repos` bindings record the authoritative
  `repoId`/`rootBookmarkId`/`canonicalRoot` triple. Fixed the shared request
  decoder's field splitting so `<=`-bounded array types (`string[]<=32`) may
  precede another body field without being mis-parsed as a generic; this was
  a latent defect for mid-body bounded arrays and changes no documented
  shapes. Success replies for the six operations now decode through strict
  provider-owned decoders.
- **2026-09-19 — control-plane composition and fail-closed approvals
  (remediation gate).** Hardened the host control plane without changing the
  operation registry:
  - **Authenticated identity binding.** The Dev Runtime scope is never
    injected as a renderer global. The shell binds
    `(account, workspace, runtime node)` once per authentication over the
    signed legacy channel (`desktop_identity_bind`, `desktop_identity_scope`,
    `desktop_identity_unbind`), verifying the presented desktop session
    against the cloud (`GET /api/workspaces` proves liveness and workspace
    membership) and the runtime-node pairing read model (node must be paired).
    The gate refuses a command whose scope differs from the verified binding
    **before** capability derivation and dispatch, re-proves node eligibility
    on every privileged operation (no TTL cache: a revoked node fails the
    next command), and revokes every channel on rebind, workspace switch, or
    unbind — reconnects must complete a fresh trusted handshake.
  - **Owner approvals are issuance-backed.** `createOwnerApprovalVerifier`
    records an authoritative issuance (owner prompt/setting) and consumption
    requires that exact record: scope-bound, action-bound, expiry-checked,
    single-use, maximum 10-minute window. `approvalVerifier` is a required
    constructor parameter of the vault, root-bookmark, and project-grant
    authorities; a missing verifier fails construction, so a caller-supplied
    non-empty string is never owner consent.
  - **Keychain failure taxonomy.** The vault key store classifies every
    `security` CLI outcome (`item_not_found`, `keychain_locked`,
    `access_denied`, `malformed_output`, `process_failure`, `timeout`,
    `unavailable_executable`). Only item-not-found permits first-time key
    generation; every other outcome fails closed without generating or
    overwriting a key. If CLI stderr contains conflicting signals, locked or
    denied takes precedence over item-not-found; a mixed diagnostic never
    permits first-time generation. Lookups re-validate base64 strictly.
  - **Production registration matrix.** The composition root
    (`apps/desktop/shell/src/dev-runtime/index.ts`) registers every provider
    with a reachable implementation — capability snapshot, project/session
    projection (including canonical `dev.session.create` with worktree-proof
    validation and `dev.session.transferInput` generation fencing), browser
    and device lanes, the worktree service (registrar at
    `worktrees/register.ts`), terminal (when the sidecar adopts), and the
    grant authorities — and fills every remaining registry operation with a
    typed-unavailable provider that names the missing host adapter. The
    composition bootstraps with a restored binding or recomposes on rebind.
  - **Launch bootstrap document gate.** The one-time launch bootstrap is
    injected only into document loads that present trusted browser fetch
    metadata (`Sec-Fetch-Dest: document` with a trusted `Sec-Fetch-Site`);
    header-less local processes receive HTML without the credential, so the
    launch capability cannot be retrieved by omitting Origin/Sec-Fetch
    headers and cannot be reused without passing the trusted-origin gate.
    Pinned by `apps/desktop/tests/dev-runtime-composition.test.ts` (boots the
    actual registration graph and enumerates the operation/provider matrix),
    `apps/desktop/tests/dev-runtime-approvals.test.ts`, and
    `apps/desktop/tests/dev-runtime-vault-keychain.test.ts`.
- **2026-09-19 — host-correctness tightening (#396/#397/#185).** Terminal:
  attach below the memory ring now replays a contiguous durable checkpoint
  bridge exactly once, in order, before live delivery, and a genuinely
  unavailable span resyncs at the deterministically derived oldest covered
  sequence (spec "Output and replay" updated); the sidecar durably captures
  every ring chunk even for terminals adopted into a fresh process.
  Supervision: exits are observed, never assumed — stop/restart wait for
  observed termination with bounded SIGTERM→SIGKILL escalation and
  `stop_unconfirmed` retains the launch record and blocks replacement;
  the ownership proof now includes executable identity and observable
  process group; readiness derives health at decision time (spec "Local
  stack supervision" updated). Worktrees: template materialization
  recomputes the promoted content digest from disk immediately before the
  first clone (stat fingerprints are a pre-check only, per the existing
  "content-digest-verified at materialization" rule), and include-copy
  application re-proves structural containment per item. No new registry
  operations; no limit changes.

- **2026-09-18 — worktree lifecycle implementation detail (#397).** Added the
  worktree-name retirement registry (fixed pool, permanent retirement,
  watermark compaction) and the per-project dependency-template cache
  (digest-validated, approved immutable promotion, one build per project,
  CoW materialization with identity reproofs) to the Worktree lifecycle
  section. Both follow the CoW-first materialization rule: per-file
  `copyFile` clones, never stream loops and never bulk directory clones.
- **2026-09-17 — foundation-gap resolution.** Defined the authoritative typed
  Dev provider projection and canonical Dev↔Chat `RuntimeSession` invariants;
  made layout preferences explicitly session-scoped; introduced the V2 utility
  envelope with independent left/right slots and V1 migration requirements;
  required leaf-only focus restoration; clarified that unbounded file offsets,
  lengths, and byte counts use `uint64-string`; and moved production remote-node
  certification to M14 while retaining remote-ready fake-node fixtures in M12.

- **2026-09-18 — local stack supervision substrate (M10 #185).** Added the
  "Local stack supervision" section: the desktop shell is the single
  supervisor for the bundled local stack, specified as the component-manifest
  model (strict decode, compatibility gate, sequential startup order,
  explicit rollback targets, optional-component baseline) plus the
  supervision rules (launch-record identity with pre-signal recheck,
  5-in-10-minutes crash-loop verdict that survives restarts, probe health
  defaults, idempotent starts, adopt/drain_upgrade/sidecar_incompatible
  handshake, owner-only quarantined records, bounded secret-free audit).
  This transcribes the supervision authority M12 consumes; it adds no Dev
  Runtime registry operations and changes no acceptance criteria.

- **2026-09-18 — browser and device lanes implementation (#422).** Landed the
  lane host adapters and UI behind the existing registry (no new operations):
  browser lanes derive an immutable profile identity from
  `(account, workspace, runtime node, session, kind)`, so human and
  task-owned lanes can never share a profile; takeover and release are the
  only generation-incrementing ownership transfers and input granted under an
  old generation is inert; screencast publication keeps one in-flight plus
  the newest complete frame under credit backpressure with the spec's
  15/30 FPS, 4096×4096, 8 MiB, and 240 inputs/s limits enforced; navigation
  revalidates scheme, credentials, and every resolved address on each hop and
  admits loopback only for a proven Adea-owned service (loopback ports 80/443
  are never owned); cookie import is a previewed plan/commit transaction —
  digest-bound, scoped to the imported registrable families, excluding
  non-transplantable origins (google.com) unless explicitly overridden, and
  fully rolled back on any failure or cancellation with values never logged;
  the port inventory scans loopback listeners only (no LAN probe), marks
  Adea-owned services from launch metadata, keeps vanished ports stale, and
  associates a confirmed listener with the ready task-owned browser lane for
  the same runtime session when one exists. Unknown, unconfirmed, and stale
  rows never receive a new preview association and remain non-actionable;
  device inventory is capability-gated `xcrun simctl`/`adb` with fixed argv
  templates bound to verified inventory IDs, and stops only an Adea-launched,
  still-identity-matching process (user-booted devices detach, never shut
  down). `dev.browser.attach`/`input`/`screenshot` and
  `dev.device.attach`/`input`/`screenshot` replies are typed
  `capability_unavailable` at the provider layer until the channel-identity
  grant-minting seam and the #400 agent-event attachment land; agent-event
  attachment remains explicitly unavailable for #422 closure.

- **2026-09-16 — contract completeness audit fixes.** Added the missing
  operations the M12 issue bodies already require: `dev.group.*`
  (create/update/delete/list/reorder) for #398; `dev.session.archive` and
  `dev.session.unarchive` producing `ArchiveRecord` for #395; `dev.browser.input`,
  `dev.browser.lanes`, and `dev.browser.profilePolicies` for #422;
  `dev.github.pullRequests` for #423; `dev.terminal.list`,
  `dev.terminal.shellProfiles`, `dev.device.sessions`, and
  `dev.worktree.cleanupJobs` for disconnect/restart rediscovery;
  `dev.project.bookmarks` and `dev.repo.credentialRefs` defining the
  authorized-root and vault-reference seams; and `dev.files.readStream`/
  `dev.files.writeStream` plus the `file-bytes-v1` protocol for bulk file
  transfer. Corrected `dev.github.updatePlan.expectedVersion` from `string` to
  `integer`, added `Group.colorToken` and `RuntimeSession.displayName`, defined
  the `GroupMutableFields`, `RootBookmark`, `CredentialRef`, `ShellProfile`,
  `ProfilePolicy`, and `CleanupJobRecord` DTOs, capped inline file content at
  the 256 KiB control limit, and promoted the terminal UX requirements
  (styled default profile with system-terminal opt-out, bottom editor with
  raw-mode escape, authenticated prompt blocks, deferred link sharing, and the
  AGPL clean-room boundary) from #396. Total operations: 133. Issue bodies for
  #394/#397/#400/#424 were corrected to the pinned Muxy revision
  `5c5be8697c57a2fe70cda97fdbaf7c912e2e31b6`; #394 remains closed.
  `RuntimeSession.terminalId` is documented as the primary terminal only —
  `dev.terminal.list` enumerates a session's split-leaf terminals — and
  `dev.appearance`/`dev.appLibrary` are clarified as capability-snapshot-only
  grants with `dev.capability.snapshot` as their sole consumer.

## What pins this

As implementation lands, each row MUST be replaced or augmented with exact test
files in the same commit:

- `scripts/docs-boundary.test.ts` — this spec is routed and links resolve;
- M10 channel/desktop boundary tests — no loopback or browsed-page privilege;
- `packages/types` contract/property tests — envelope and state decoders;
  `packages/types/tests/dev-runtime.test.ts` pins the `RootBookmark` and
  `CredentialRef` grant DTOs and the success page decoders for
  `dev.project.bookmarks` and `dev.repo.credentialRefs` (M10 #34), and the
  `Repo`/`RepoInspection` registry DTOs with the reply-decoder matrix for
  `dev.repo.adopt`/`authorize`/`inspect`/`refresh`/`list` and
  `dev.project.update`/`archive` (#398 follow-up);
- `packages/types/tests/dev-runtime-computeruse.test.ts` — #472 wire
  contract: every `dev.computeruse.*` request body and success reply decodes,
  authority fields are rejected, stale generations and forged consent ids
  fail closed at the decoder layer;
- `apps/desktop/tests/dev-runtime-computeruse.test.ts` — #472 lane
  lifecycle and authority gate: session-scoped lanes with immutable
  generation fencing on takeover/release/close, kill-switch immediacy,
  stale-generation input inertness, consent records that are issuance-backed,
  scope/generation-bound, single-use, ≤60 s, and refusal when the #471
  permission state is not granted or not fresh, bounded desktop-frame
  publication (one in-flight plus newest, 240 inputs/s), fixed-argv host
  tooling templates with scripted runners (no real capture or input in CI),
  and typed-unavailable classification for capture and AX-tree reading;
- `apps/desktop/tests/shell-channel.test.ts` — the M10 channel/desktop
  boundary: no loopback or browsed-page privilege (trusted-origin gate,
  bootstrap handshake, proof/replay/expiry refusals, single-use grants,
  full-duplex attach, secret-free audit);
- `packages/types/tests/dev-runtime-browser-device.test.ts` — #422 wire
  contract: every `dev.browser.*`/`dev.device.*` request body and success
  reply decodes, lane crossover and stale generations fail closed, and
  gesture/viewport/cookie limits bind on the stream;
- `apps/desktop/tests/dev-runtime-browser.test.ts` — lane/profile identity
  separation, takeover generation fencing, screencast bounded publication and
  stale-input inertness, cookie import scope/atomic rollback/secret-free
  results, loopback-only port inventory with stale handling, screenshot
  provenance and limits;
- `apps/desktop/tests/dev-runtime-browser-providers.test.ts` — provider
  preconditions behind the M10 gate: scope identity, generation binding, SSRF
  refusals recorded as policy diagnostics, and typed-unavailable engine
  seams;
- `apps/desktop/tests/dev-runtime-devices.test.ts` — simctl/adb inventory
  parsing fixtures, fixed argv templates, gesture pixel clamping, and
  launch-identity stop rules including adopt-never-kill.
- `packages/types` contract/property tests
  (`packages/types/tests/dev-runtime.test.ts`) — envelope, channel, stream,
  and state decoders;
- `packages/dev-view` unit/component tests — layout/status/accessibility;
  `packages/dev-view/tests/selection.test.ts` pins selection enforcement
  (scope, generation, revocation, freshness, archive recovery);
  `packages/dev-view/tests/sidebar-reorder.test.ts` pins the pointer and
  keyboard reorder model; `packages/dev-view/tests/archive-shelf-model.test.ts`
  pins the restore flow, the destructive-delete confirmation gate, and the
  explicit `dev.session.delete` handoff;
  `apps/desktop/tests/project-session-register.test.ts` pins the durable
  project/session authority: restart survival without fixtures, transactional
  archive records, scope/generation/version rejection, fail-closed corruption,
  scope-partitioned A-to-B-to-A restart, legacy-source mode/symlink checks,
  duplicate-row refusal, and the legacy-seed migration.
  `apps/desktop/tests/host-store.test.ts` pins
  the shared SQLite boundary's WAL/full-sync setup, scope isolation, format
  guard, corruption retention, restart recovery, and interrupted migration
  retry, native-state refusal after SQLite loss, and stale-source refusal after
  SQLite loss;
  `apps/desktop/tests/repo-registry.test.ts`
  pins the repository registry (#398 follow-up): adopt-time
  containment/identity proof with durable restart, unknown/stale/foreign-scope
  refusals, out-of-root containment refusal before any write, read-only
  inspect facts with dirty detection and stale-generation fencing,
  host-matched credential authorization, offline-safe refresh (`stale` /
  `unavailable` typed truth, version kept when nothing moved), and remote
  redaction;
  `packages/ui/tests/appearance.test.ts` pins the storage-level recovery
  envelope round-trips; `packages/workspace-ui/tests/unit/app-library.test.ts`
  pins the compiled trusted entry registry and every activation rejection;
  `apps/web/e2e/dev-view.spec.ts` and `apps/web/e2e/appearance.spec.ts` pin the
  deep-link recovery, reorder, shelf, zoom/reduced-motion, and CSP-safe
  journeys;
- macOS permissions (#471): `apps/desktop/tests/shell-permissions.test.ts`
  pins the probe outcome matrix, fixed-argv discipline, settings deep-link
  table, and the `desktop_permissions_*` bridge commands;
  `packages/dev-view/tests/permissions-model.test.ts` pins presentation,
  action affordances, live-region announcements, and honest degradation;
  `packages/types/tests/desktop-permissions.test.ts` pins the DTO universes
  and the permission-id guard;
- computer use (#472): `packages/dev-view/tests/computeruse-model.test.ts`
  pins the pane model — capability rows rendered from the injected service
  port only, consent/takeover/release affordances gated on lane state,
  capture/AX-tree unavailable guidance naming the missing piece, and no
  fixture capability states;
- desktop Dev Runtime unit/integration tests — filesystem, worktree, terminal,
  process, browser, provider, cleanup;
  `apps/desktop/tests/terminal-pty-adapter.test.ts`,
  `apps/desktop/tests/terminal-manager.test.ts`,
  `apps/desktop/tests/terminal-checkpoints.test.ts`,
  `apps/desktop/tests/terminal-input-authority.test.ts`,
  `apps/desktop/tests/terminal-shell-integration.test.ts`,
  `apps/desktop/tests/terminal-sidecar.test.ts`,
  `apps/desktop/tests/terminal-channel.test.ts`, and the real-PTY packaged
  smoke `apps/desktop/tests/terminal-pty-smoke.test.ts` pin the Terminal
  protocol, sidecar adoption, shell integration, and input authority sections
  (issue #396);
  `packages/dev-view/tests/terminal-transport.test.ts` and
  `packages/dev-view/tests/terminal-renderer-editor.test.ts` pin the client
  transport, renderer fallback policy, command blocks, and bottom editor;
  `apps/desktop/tests/dev-runtime-roots.test.ts`,
  `apps/desktop/tests/dev-runtime-vault.test.ts`, and
  `apps/desktop/tests/dev-runtime-grants.test.ts` pin the M10 #34
  authorized-root containment/identity rechecks, vault enrollment/resolution,
  and project grant binding;
- `apps/desktop/tests/dev-runtime-approvals.test.ts` pins the fail-closed
  owner-approval verifier (mandatory construction, issuance-bound single-use
  consumption, replay/expiry/wrong-scope/forgery refusals);
- `apps/desktop/tests/dev-runtime-vault-keychain.test.ts` pins the keychain
  failure taxonomy (only item-not-found permits first-time generation);
- `apps/desktop/tests/dev-runtime-vault-bun-secrets.test.ts` pins the
  application-level Bun.secrets migration, runtime-version fallback, exact
  key read-back, locked/denied/unavailable refusals, legacy-key retention, and
  key-mismatch fail-closed behavior, including sealed-vault access after a
  runtime downgrade;
- `apps/desktop/tests/dev-runtime-vault.test.ts` also pins the credential
  metadata migration, retained legacy source, restart/rollback recovery,
  SQLite loss refusal, scope filtering, corruption retention, downgrade-visible
  revocation tombstones, and the absence of plaintext or key material from
  SQLite;
- `scripts/test-m10-33-packaged-vault.mjs` bundles
  `apps/desktop/shell/scripts/packaged-vault-smoke.ts` and executes the real
  adapter with the Bun runtime from a macOS app bundle. Its disposable
  Keychain journey proves legacy-slot retention across upgrade/downgrade and
  records redacted denied/locked/mismatched-store refusals with parent and
  child cleanup;
- `apps/desktop/tests/dev-runtime-composition.test.ts` boots the actual shell
  registration graph and pins the operation/provider matrix, the
  scope-before-dispatch gate ordering, revocation and refused-rebind
  behavior, and the typed-unavailable host capability results;
- `apps/desktop/tests/dev-runtime-harness-launch.test.ts` pins the #400
  launch orchestration: the clean-desktop managed-Pi root default, user
  preference authority (version fencing, default exclusivity, disabled-never-
  auto-launched), typed refusals for unlaunchable explicit defaults, the
  launchDefault resolution order with the install remediation gap, and the
  observed `dev.harness.runStatus` machine (legal edges, illegal edges,
  terminal refusals, generation/scope fencing, canonical event emission);
- `apps/desktop/tests/dev-runtime-harness-status.test.ts` pins the pure
  transition table edge-by-edge, idempotent same-state replays, typed
  refusal codes, event-kind mapping, and the bounded run-history store
  (terminal-first eviction that never drops a live run, the 50-entry
  transition journal, scope isolation) on injected clocks;
- `apps/desktop/tests/dev-runtime-harness-events.test.ts` pins the canonical
  event log (per-generation sequencing, dedupe vs `idempotency_conflict`,
  bounded retention, bounded reads, scope isolation, live subscriptions),
  the `dev.session.events` grant path (caller-identity binding, single-use
  attach with channel-secret proof, foreign-channel refusal), and the
  runtime-events-v1 handler (bounded newest-frame replay, live push,
  stale-generation close, read-only discipline);
  `apps/desktop/tests/harness-events-channel.test.ts` proves the full
  websocket attach end-to-end over a real channel gateway (grant mint →
  signed attach → `opened` → bounded CBOR replay → live push → ack →
  single-use attach replay refusal → generation-fenced `stale_generation`
  close);
- `apps/desktop/tests/dev-runtime-harness-prompt.test.ts` pins the
  launch→prompt-delivery residues: exactly-once fenced delivery into the
  session PTY through the `prompt_delivery` input authority (with provenance
  events and no prompt content), typed non-delivery without a live terminal,
  ACP-lane deferral, and single-writer fencing (a superseded user writer is
  rejected before the PTY);
- `packages/types/tests/dev-runtime-harness.test.ts` pins the #400 wire
  contract: every new request body and success reply (preferences, run
  status, launchDefault, the events stream grant) decodes strictly and
  credential-shaped or malformed extras fail closed;
- `packages/dev-view/tests/harness-status-model.test.ts` and
  `packages/dev-view/tests/run-history-model.test.ts` pin the Agents/History
  pane presentation models: truthful status labels (unknown stays unknown),
  terminal-fallback surfacing, installation display distinctions, bounded
  newest-first history rows, injected-clock elapsed times, and
  redaction-by-construction;
- `apps/desktop/tests/project-scan.test.ts` pins the monorepo scanner's
  prune-first discovery, workspace declaration parsing, symlink refusal,
  ignore handling (including the negation diagnostic), malformed-manifest
  diagnostics, package/entry/time budgets, cancellation, and fingerprints;
- `apps/desktop/tests/project-registry.test.ts` pins the project registry
  providers: group placement/update/delete fencing, import root resolution,
  duplicate refusal, atomic group membership, restart persistence, scan
  cache/cursor/partial semantics, and the strict reply decoders;
- `packages/dev-view/tests/scan-preview-model.test.ts` pins the sidebar's
  scan preview/duplicate/notice/import-plan presentation model;
- web/desktop Playwright owner journey;
- named Dev Runtime performance and soak commands
  (`test:performance:dev-runtime`, `test:soak:dev-runtime`) and the packaged,
  security, and bundle lanes (`test:packaged`, `test:security:dev-runtime`,
  `test:bundle:dev-view`), each writing its summary under
  `artifacts/dev-runtime/`;
- package/provenance denylist tests.

Until those files exist, the matching implementation issue remains open; prose
alone is not evidence of implemented behavior.
