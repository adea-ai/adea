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
  | 'dev.harness.read'
  | 'dev.harness.manage'
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
  state: HarnessRunState
  generation: number
  startedAt?: string
  finishedAt?: string
  version: number
}

// Managed Pi driver (#31): the Agent HQ-owned installation read model. The
// pinned version and its archive digest are build-time constants; a genuine
// host absence reports `failed` with a typed `capability_unavailable`
// reason and never fabricates an installation.
type ManagedPiInstallState = 'absent' | 'resolving' | 'installing' | 'ready' | 'failed'
type ManagedPiStatus = {
  scope: Scope
  driverId: string
  driverVersion: string
  pinnedVersion: string
  state: ManagedPiInstallState
  installationId?: string
  resolvedVersion?: string
  executableIdentity?: string
  executableLabel?: string
  lastErrorCode?: DevErrorCode
  lastError?: string
  observedAt: string
  generation: number
}

// ACP lane (#32): one negotiated connection bound to the canonical
// RuntimeSession. A required capability the harness does not advertise
// makes the connection ineligible (state `failed` with the missing set
// recorded); native history is a separate capability and is never
// fabricated. Close bumps the generation so stale bindings are inert.
type AcpConnectionState = 'connecting' | 'ready' | 'disconnected' | 'closed' | 'failed'
type AcpConnection = {
  id: string
  scope: Scope
  runtimeSessionId: string
  harnessInstallationId: string
  driverId: string
  driverVersion: string
  negotiatedProtocolVersion: string
  requiredCapabilities: string[]
  negotiatedCapabilities: string[]
  missingRequiredCapabilities: string[]
  sessionOperations: string[]
  limitations: string[]
  history: 'available' | 'unavailable'
  state: AcpConnectionState
  closeReason?: string
  observedAt: string
  generation: number
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
}
type UsageRecord = {
  id: string
  ownerId: string
  provider: string
  quantity: string
  unit: string
  costMicros?: string
  source: string
  confidence: 'authoritative' | 'measured' | 'estimated'
  observedAt: string
}
type RetainedDataRecord = {
  id: string
  ownerId: string
  kind: 'terminal' | 'checkpoint' | 'screenshot' | 'browser_profile' | 'log'
  byteLength: string
  protected: boolean
  expiresAt?: string
  observedAt: string
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

`packages/data` owns the scoped query keys and cancellation/invalidation seam;
`packages/state` owns only ephemeral selected IDs and presentation state. The
`DevRuntimeService`/provider adapter maps registry replies into this projection
and never creates a second session, event, approval, credential, or runtime-node
authority.

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
  | `dev.session.${'create' | 'get' | 'list' | 'launchHarness' | 'resumeHarness' | 'cancelHarness' | 'events' | 'transferInput' | 'archive' | 'unarchive'}`
  | `dev.harness.${'managedPiStatus' | 'managedPiInstall' | 'acpConnect' | 'acpConnections' | 'acpClose' | 'runs'}`
  | `dev.files.${'list' | 'stat' | 'read' | 'write' | 'create' | 'rename' | 'delete' | 'copy' | 'search' | 'openExternal' | 'readStream' | 'writeStream'}`
  | `dev.git.${'status' | 'history' | 'diff' | 'stage' | 'unstage' | 'discardPlan' | 'discardCommit' | 'commit' | 'fetch' | 'checkpoint' | 'restorePlan' | 'restoreCommit'}`
  | `dev.browser.${'laneCreate' | 'laneClose' | 'lanes' | 'attach' | 'navigate' | 'targets' | 'viewport' | 'screenshot' | 'annotate' | 'inspect' | 'diagnostics' | 'takeover' | 'release' | 'input' | 'cookieImportPlan' | 'cookieImportCommit' | 'profileReset' | 'profilePolicies'}`
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
`dev.runtime.stream.attach.v1` (terminal/browser/device bulk stream negotiated
from an authorized execute reply). The normative
[`dev-runtime-operations.json`](./dev-runtime-operations.json) registry provides
all 139 operation names, exact body shapes, exact reply types, complete required
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

A remote client never connects directly to an arbitrary host port. It uses the
authorized RuntimeConnection route, whose host repeats scope/generation checks.
A host refusal is not translated into local success.

Defaults:

- command expiry: 60 seconds; maximum accepted clock skew: 30 seconds;
- credential-vault master keys are held by the host OS credential store (macOS
  Keychain in the desktop lane), never by a `vault.key` file in app data;
  unavailable or denied stores fail closed;
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
Frames after `close`, frames in the wrong direction, out-of-order client input,
oversize frames, stale generations, or sequence wrap are rejected and close
the stream. `data`/`input` bytes are never JSON/base64-transcoded. Browser/device
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

| Family              | Required operations                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dev.capability`    | `snapshot`                                                                                                                                                                                                                                       |
| `dev.group`         | `list`, `create`, `update`, `delete`, `reorder`                                                                                                                                                                                                  |
| `dev.project`       | `list`, `get`, `import`, `clone`, `scan`, `create`, `update`, `reorder`, `archive`, `bookmarks`                                                                                                                                                  |
| `dev.repo`          | `list`, `inspect`, `refresh`, `authorize`, `adopt`, `credentialRefs`                                                                                                                                                                             |
| `dev.worktree`      | `list`, `create`, `retryBootstrap`, `lease`, `releaseLease`, `mergePlan`, `mergeCommit`, `archive`, `unarchive`, `cleanupPlan`, `cleanupCommit`, `cleanupResume`, `cleanupJobs`                                                                  |
| `dev.terminal`      | `create`, `attach`, `detach`, `input`, `resize`, `signal`, `terminate`, `checkpoint`, `search`, `historyDelete`, `list`, `shellProfiles`                                                                                                         |
| `dev.session`       | `create`, `get`, `list`, `launchHarness`, `resumeHarness`, `cancelHarness`, `events`, `transferInput`, `archive`, `unarchive`                                                                                                                    |
| `dev.harness`       | `managedPiStatus`, `managedPiInstall`, `acpConnect`, `acpConnections`, `acpClose`, `runs`                                                                                                                                                        |
| `dev.files`         | `list`, `stat`, `read`, `write`, `create`, `rename`, `delete`, `copy`, `search`, `openExternal`, `readStream`, `writeStream`                                                                                                                     |
| `dev.git`           | `status`, `history`, `diff`, `stage`, `unstage`, `discardPlan`, `discardCommit`, `commit`, `fetch`, `checkpoint`, `restorePlan`, `restoreCommit`                                                                                                 |
| `dev.browser`       | `laneCreate`, `laneClose`, `lanes`, `attach`, `navigate`, `targets`, `viewport`, `screenshot`, `annotate`, `inspect`, `diagnostics`, `takeover`, `release`, `input`, `cookieImportPlan`, `cookieImportCommit`, `profileReset`, `profilePolicies` |
| `dev.device`        | `list`, `sessions`, `start`, `attach`, `input`, `screenshot`, `stop`                                                                                                                                                                             |
| `dev.github`        | `account`, `repository`, `issues`, `milestones`, `pullRequest`, `pullRequests`, `checks`, `pushPlan`, `pushCommit`, `createPullRequest`, `updatePlan`, `updateCommit`, `mergePlan`, `mergeCommit`                                                |
| `dev.resources`     | `snapshot`, `processes`, `ports`, `metrics`, `usage`, `stopPlan`, `stopCommit`, `retainedData`                                                                                                                                                   |
| `dev.cleanupPolicy` | `list`, `createDraft`, `approve`, `disable`, `evaluate`                                                                                                                                                                                          |
| `dev.appearance`    | client preference only; privileged host command only for capability snapshot                                                                                                                                                                     |
| `dev.appLibrary`    | existing verified catalog/install-plan authority; no new dynamic-code command                                                                                                                                                                    |

`dev.appearance` and `dev.appLibrary` intentionally have no operation in this
contract: `dev.capability.snapshot` is their only consumer — it reports each as
granted or typed-unavailable for the scope, and the client falls back to local
preference storage or the existing verified App Library surfaces accordingly.

Capability/resource binding is deny-by-default:

| Family        | Read operations                                                             | Mutation operations                                                                                         | Resource kind                                       |
| ------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| capability    | authenticated channel; no feature capability (this snapshot reports grants) | none                                                                                                        | no resource                                         |
| group         | `dev.project.read`                                                          | `dev.project.manage`                                                                                        | `group` except top-level list/create/reorder        |
| project       | `dev.project.read`                                                          | `dev.project.manage`                                                                                        | `project` except top-level list/create/import/clone |
| repo          | `dev.repo.read`                                                             | `dev.repo.manage`                                                                                           | `repository`                                        |
| worktree      | `dev.worktree.read`                                                         | `dev.worktree.manage`; cleanup additionally `dev.cleanup.approve`                                           | `worktree`                                          |
| terminal      | `dev.terminal.attach`                                                       | input requires `dev.terminal.input`; lifecycle/signal requires `dev.terminal.manage`                        | `terminal`                                          |
| session       | `dev.session.read`                                                          | harness lifecycle/input transfer requires `dev.session.manage`                                              | `runtime_session`                                   |
| harness       | `dev.harness.read`                                                          | install/connect/close requires `dev.harness.manage`                                                         | `runtime_session` (`acpConnect`), `acp_connection` (`acpClose`); reads carry no resource |
| files         | `dev.files.read`                                                            | `dev.files.write`                                                                                           | `workspace_path` plus current root identity         |
| git           | `dev.git.read`                                                              | `dev.git.write`; commit/restore/discard additionally require their current M11 approval when policy says so | `repository` or `worktree` as named by request      |
| browser       | `dev.browser.read`                                                          | `dev.browser.control`; cookie/profile additionally `dev.browser.cookies`                                    | `browser_lane`                                      |
| device        | `dev.device.read`                                                           | `dev.device.control`                                                                                        | `device_session`                                    |
| github        | `dev.github.read`                                                           | `dev.github.write`; merge/push additionally require plan digest and current M11 approval/policy             | `repository` or `pull_request`                      |
| resources     | `dev.resources.read`                                                        | stop requires `dev.resources.stop`; destructive cleanup also requires `dev.cleanup.approve`                 | target process/port/worktree resource               |
| cleanupPolicy | `dev.resources.read`                                                        | create/approve/disable requires `dev.cleanup.approve`; evaluate executes nothing                            | `cleanup_policy`                                    |

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
  session first after retention protection;
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

Restart loops allow 5 failures in 10 minutes, then stop and surface
`crash_loop`. Window/app close detaches; explicit termination signals only the
owned process group after start-identity recheck.

### Local stack supervision

The desktop shell is the one supervisor for the bundled local stack (M10
#185): Control Plane, managed Pi, optional Cortana, local drivers, and the
Dev Runtime sidecar all register with the lifecycle below; M12 adapters never
supervise their own processes and M12 adds no second supervisor. The
bundled **component manifest** records, per component, the exact product
version, platform/architecture, artifact digest and signature, app-version
compatibility window, install and data locations, startup phase, declared
dependencies, health probe, registration protocol, explicit rollback target,
and required/optional flag. Its strict decoder returns
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
  versions and digests for diagnostics.

This paragraph is pinned by `apps/desktop/tests/supervision-manifest.test.ts`,
`apps/desktop/tests/supervision-supervisor.test.ts`, and
`apps/desktop/tests/supervision-records.test.ts`. The rules are additionally
proven against real processes by the packaged supervision smoke lane —
`apps/desktop/shell/scripts/supervision-smoke.ts` with
`apps/desktop/shell/src/supervision/process-adapter.ts` (the real macOS
adapter: spawn, `ps`-observed launch identity validated against its expected
row shape and fail-closed when unparseable, signal) — gated to darwin like the
terminal PTY smoke and pinned by
`apps/desktop/tests/supervision-packaged-smoke.test.ts`. The smoke proves
launch-record identity against the live OS, exit confirmed only by observation
(including an already-dead process confirmed without a signal), SIGTERM→SIGKILL
escalation with child-side testimony that SIGTERM was delivered and ignored,
and reconcile after supervisor restart (adoption of the still-running launch,
expected-exit journaling for a dead one, and refusal — without signalling — of
a forged record that fails the real-OS identity recheck). Its boundary is
explicit: the supervised `dev-runtime-sidecar` component is the real bundled
sidecar entry and the smoke child is a real process, but a complete packaged
run additionally needs the Electrobun-bundled application binary plus the
packaging lane's install-location resolution feeding the component manifest;
the smoke documents that gap rather than faking the evidence.

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

### Harness runtime substrate (#31 managed Pi, #32 ACP lane)

The substrate is the M10 command surface that #400 launches through; the Dev
Runtime performs no model-facing harness engineering (no compaction, no prompt
rewriting, no task planning — harnesses own their internal loops) and never
manages Pi processes directly. Every operation dispatches through the
authenticated gate, is scope-bound, and re-checks the envelope resource
binding (kind, id, generation) against the canonical `RuntimeSession` record
before the provider acts.

Managed Pi (#31) is the consumer zero-config path and the initial global
default harness lane on a clean desktop. The `ManagedPiDriver` installs a
pinned, digest-verified Pi build into an Agent HQ-owned location
(`dev.harness.managedPiInstall`, idempotent): the pinned version and its
archive digest are build-time constants, never network-resolved; a cached,
current installation short-circuits with no writes and no probing; the
archive is hash-verified before any byte reaches the install root; installs
stage and atomically swap, and a failed install/update rolls back without
degrading the previous managed version or touching any user-managed Pi
configuration. Acceptance is "no manual Pi installation required": a clean
supported desktop reaches `ready` through the gate alone. A genuine host
absence (unsupported platform, no bundled/cached archive, failed write) is a
typed `capability_unavailable`/`corrupt_state` error through the gate and a
truthful `failed`/degraded status record — never a fake installation, and
never a fabricated session.

The ACP lane (#32) connects a supported local harness speaking ACP and maps
it onto the canonical `RuntimeSession` (`dev.harness.acpConnect`): spawn uses
a fixed argv template over the host-resolved installation record (never
renderer input); the handshake negotiates protocol version, capabilities,
session operations, and limitations within bounded bytes and time. A required
capability the harness does not advertise makes the connection ineligible
(typed `incompatible`; the failed connection record is retained as
diagnostic evidence). Optional capability absence only degrades the record
explicitly. Native history/load/replay is a separate negotiated capability
(`AcpConnection.history`); it is surfaced with provenance or reported
`unavailable` and never fabricated, and Agent HQ conversations never depend
on it. Native authentication, tools, and configuration remain with the
external harness and are never mutated. Close (`dev.harness.acpClose`) is
generation-fenced and bumps the connection generation, so stale bindings are
inert. Run status/history is the paged `dev.harness.runs` read model.

`dev.session.launchHarness` is idempotent per (session, installation,
AgentProfile, model) on a live run and binds the created `HarnessRun` to the
session with a generation bump (`lifecycle: 'active'`,
`activeHarnessRunId`). `dev.session.resumeHarness` creates a new
`HarnessRun` generation under the same compatible session and marks the
prior run `disconnected`. `dev.session.cancelHarness` cancels the named
run (already-terminal runs refuse with `already_completed`), closes the
session's live ACP lane best-effort, and moves the session to
`'disconnected'` with the run cleared. Launching against an installation
that is not ready refuses with a typed error and a remediation pointing at
`dev.harness.managedPiInstall`; an unknown installation is `not_found`.

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

Screenshots/annotations carry origin, viewport, time, lane/profile, and
redaction provenance; maximum 25 MiB each and workspace retention limits apply.
Browser page content cannot invoke Adea commands through origin or loopback.

Responsive emulation is always available. iOS uses verified `xcrun simctl`
inventory; Android uses verified `adb`/emulator inventory. Commands use fixed
argv templates and inventory IDs. Starting/stopping is explicit, and Adea stops
only a still-identity-matching process it launched. Physical devices require a
separate pairing/grant.

## GitHub provider

`RemoteSourceProvider` exposes host-neutral IDs and DTOs. GitHub response objects
never enter UI state. Reads prefer API/GraphQL and use ETags/cursors; `gh` is an
authenticated transport option, never output to scrape.

Credentials are host/account scoped. Enterprise hosts require explicit trust;
github.com credentials are never sent elsewhere. All mutation results are
reread before success. PR create uses an idempotency/reconciliation key and
searches for an existing matching head/base after timeout.

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

Theme imports are deferred until signed App Library support and require a known
license/provenance or explicit `unknown/unverified`; “User supplied” does not
prove redistribution permission.

M12 App Library can activate only a bundled first-party entry ID after existing
catalog signature/digest/install-plan checks. No downloaded JS, `eval`, remote
module URL, arbitrary postinstall, or empty placeholder view. Optional rail
items can hide/reorder, but active/core Chat/Dev/Virtual remain recoverable via
App Library or Reset Navigation.

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

| Surface               | M12 initial limit                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| center layout         | 8 leaves, depth 8, ratio 0.1–0.9                                                                                                                        |
| command               | 256 KiB control body; 60-second expiry; 30-second clock skew                                                                                            |
| nonce/idempotency     | ≥128-bit nonce; key 1–128 printable ASCII; completed mutation 24 hours–7 days                                                                           |
| event                 | 256 KiB JSON; depth 32; string 64 KiB; 1,000 frames/s; page 500/default 100; 100,000/session or 30 days                                                 |
| hook/OSC              | authenticated hook frame 8 KiB; OSC payload 2 KiB                                                                                                       |
| terminal              | 64 KiB chunks; 4 MiB/10,000-chunk memory ring; 256 MiB/session; 2 GiB/workspace; 8 subscribers; 1 MiB input/subscriber queue                            |
| terminal liveness     | 15-second heartbeat; unhealthy at 45 seconds; reconnect 250 ms exponential to 30 seconds; checkpoint ≤5 seconds and each 1 MiB                          |
| scanner               | depth 16; 100,000 entries; 10,000 packages; 2 MiB/manifest; 10 seconds; concurrency 8                                                                   |
| watcher/status        | 250 ms coalesce; refresh concurrency 4; degraded fingerprint no faster than 60 seconds                                                                  |
| include copy          | 1,000 regular files; 100 MiB total; 16 MiB/file                                                                                                         |
| bootstrap/teardown    | 15 minutes/step; 10 MiB output; one owned process group                                                                                                 |
| files                 | directory page 500; inline read/write 256 KiB on the control path; bulk via `file-bytes-v1` stream; editable 8 MiB; preview 64 MiB; 30-second operation |
| editor/diff           | reduced tokenization after 10,000 lines or 5 MiB; 10,000 hunks/20 MiB rendered diff before metadata fallback                                            |
| search                | 10,000 matches; 1,000 matched files; 50 MiB scan-result budget; 1 MiB emitted; 30 seconds                                                               |
| git child             | 60 seconds and 10 MiB output unless an operation-specific lower limit applies                                                                           |
| harness discovery     | 1 MiB input; 1,000 models/commands; 64 KiB/record; 10 seconds                                                                                           |
| cookie import         | 10,000 cookies; 16 MiB serialized; atomic transaction                                                                                                   |
| screencast            | 15 FPS default/30 max; 4096×4096; 8 MiB/frame; one in-flight plus newest; 240 inputs/s                                                                  |
| screenshot/annotation | 25 MiB/item; 1 GiB/workspace; 30 days unless user pins it                                                                                               |

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

No issue closes on fixture-only production integration. Unsupported platform
states remain deterministic fixtures, but the local packaged macOS path must
pass before M12 release. M12 also requires authorized fake
RuntimeConnection/revocation/scope-isolation fixtures against the shared remote
adapter. Production remote RuntimeConnection certification is explicitly owned
by M14 and is not a hidden M12 acceptance criterion.

## Spec changes

Post-baseline contract changes are recorded here so issue mirrors and audits
can distinguish intentional spec evolution from drift:

- **2026-09-19 — harness runtime substrate (#31 managed Pi, #32 ACP lane).**
  Added the `dev.harness` family (`managedPiStatus`, `managedPiInstall`,
  `acpConnect`, `acpConnections`, `acpClose`, `runs`) with the
  `dev.harness.read`/`dev.harness.manage` capabilities, the `acp_connection`
  resource kind, the `AgentProfileRef` and `HarnessRun` wire DTOs (with the
  `dev.session.launchHarness`/`resumeHarness`/`cancelHarness` success
  decoders), and the `ManagedPiStatus`/`AcpConnection` read models. The
  managed Pi driver installs a pinned, digest-verified build into an
  Agent HQ-owned location with zero manual steps (clean-desktop default
  lane), never touches user-managed Pi configuration, and reports genuine
  host absence as typed `capability_unavailable` — never a fabricated
  installation. The ACP lane negotiates protocol/capabilities within bounded
  bytes and time, refuses required-unsupported capabilities as ineligible,
  records native history as a separate never-fabricated capability, and
  binds every connection and run to the canonical `RuntimeSession` identity
  with scope and generation fencing (launch idempotent, resume a new run
  generation, cancel fences and disconnects the session). The Dev Runtime
  performs no model-facing harness engineering. Pinned by
  `packages/types/tests/dev-runtime-harness.test.ts` and
  `apps/desktop/tests/dev-runtime-harness.test.ts`; matrix rows in
  `apps/desktop/tests/dev-runtime-composition.test.ts`. Total operations:
  139.
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
    overwriting a key, and lookups re-validate base64 strictly.
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
- **2026-09-19 — packaged supervision smoke lane (M10 #185/#34).** The
  supervision rules are now proven against real processes on the packaged app
  path: `shell/src/supervision/process-adapter.ts` is the real macOS adapter
  (ps-observed launch identity, validated against its expected row shape and
  fail-closed when unparseable, so an identity is never guessed; spawn and
  signal; ESRCH between recheck and signal reads as the exit the observation
  loop then sees), and `shell/scripts/supervision-smoke.ts` proves
  launch-record identity, exit-by-observation (including already-dead without
  a signal), SIGTERM→SIGKILL escalation with child-side delivery testimony,
  and reconcile-after-restart (adopt / expected-exit journal / forged-record
  refusal without signalling), pinned by
  `apps/desktop/tests/supervision-packaged-smoke.test.ts` (darwin-gated like
  the terminal PTY smoke). The lane states its own boundary: a complete
  packaged run additionally needs the Electrobun-bundled app binary and the
  packaging lane's install-location resolution feeding the manifest ("Local
  stack supervision" updated). No supervision rule changed. Record-store
  retention is now test-injectable (`maxRecords`, default unchanged at
  1,000) so the prune semantics no longer depend on 1,100 real appends of
  wall-clock I/O.
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

> > > > > > > 49452cc (feat(shell): supervise the bundled local component stack)

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
  Adea-owned services from launch metadata, and keeps vanished ports stale;
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
  `dev.project.bookmarks` and `dev.repo.credentialRefs` (M10 #34);
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
- `apps/desktop/tests/dev-runtime-composition.test.ts` boots the actual shell
  registration graph and pins the operation/provider matrix, the
  scope-before-dispatch gate ordering, revocation and refused-rebind
  behavior, and the typed-unavailable host capability results;
- web/desktop Playwright owner journey;
- named Dev Runtime performance and soak commands;
- package/provenance denylist tests.

Until those files exist, the matching implementation issue remains open; prose
alone is not evidence of implemented behavior.
