import {
  devOperationDefinitions,
  devOperations,
  devRuntimeTransportMethods,
  devStreamProtocolDefinitions,
} from './dev-runtime-registry'
import { isMacPermissionId, type MacPermissionId } from './desktop-permissions'

export {
  devOperationDefinitions,
  devOperations,
  devRuntimeTransportMethods,
  devStreamProtocolDefinitions,
}

export type DevOperation = (typeof devOperations)[number]
// The registry never carries a command capability for appearance or the App
// Library (client preference only), but dev.capability.snapshot reports both,
// so the capability universe is the registry set plus these two.
export type DevCapability =
  | (typeof devOperationDefinitions)[DevOperation]['capabilities'][number]
  | 'dev.appearance.read'
  | 'dev.appLibrary.manage'
export type DevStreamProtocol = keyof typeof devStreamProtocolDefinitions

export type Scope = Readonly<{
  accountId: string
  workspaceId: string
  runtimeNodeId: string
}>

export type DevResourceBinding = Readonly<{
  kind: string
  id: string
  generation: number
}>

export type DevCommand<
  K extends DevOperation = DevOperation,
  T = Readonly<Record<string, unknown>>,
> = Readonly<{
  schemaVersion: 1
  operation: K
  requestId: string
  nonce: string
  idempotencyKey?: string
  issuedAt: string
  expiresAt: string
  scope: Scope
  capabilities: readonly DevCapability[]
  resource?: DevResourceBinding
  body: T
}>

export const devErrorCodes = [
  'unauthenticated',
  'unauthorized',
  'workspace_unavailable',
  'runtime_node_unavailable',
  'runtime_node_revoked',
  'capability_denied',
  'channel_unauthenticated',
  'channel_unauthorized',
  'token_expired',
  'replay_rejected',
  'not_found',
  'identity_mismatch',
  'stale_generation',
  'stale_version',
  'invalid_state',
  'unsupported_version',
  'corrupt_state',
  'already_completed',
  'idempotency_conflict',
  'unauthorized_root',
  'path_escape',
  'symlink_rejected',
  'special_file_rejected',
  'file_changed',
  'not_git_repo',
  'gitdir_unproven',
  'remote_unavailable',
  'base_not_found',
  'name_collision',
  'path_collision',
  'bootstrap_denied',
  'bootstrap_failed',
  'dirty',
  'unpushed',
  'behind',
  'conflicted',
  'protected_branch',
  'external_ownership',
  'dangerous_path',
  'nested_worktree',
  'lock_timeout',
  'unsupported_capability',
  'capability_unavailable',
  'unavailable',
  'limit_exceeded',
  'spawn_failed',
  'auth_required',
  'incompatible',
  'sidecar_incompatible',
  'profile_scope_denied',
  'remote_host_untrusted',
  'force_push_denied',
  'timeout',
  'cancelled',
  'backpressure',
  'sequence_gap',
  'resync_required',
  'checkpoint_corrupt',
  'crash_loop',
  'delivery_ambiguous',
  'navigation_blocked',
  'ssrf_blocked',
  'permission_denied',
  'cookie_import_failed',
  'rate_limited',
  'remote_changed',
  'branch_protected',
  'leased',
  'ownership_unproven',
  'plan_stale',
  'cleanup_blocked',
  'cleanup_partial',
  'recovery_required',
  'rollback_failed',
] as const

export type DevErrorCode = (typeof devErrorCodes)[number]
export type DevError = Readonly<{
  code: DevErrorCode
  retryable: boolean
  message: string
  remediation?: Readonly<{ action: string; parameters?: Readonly<Record<string, string>> }>
  currentVersion?: number
  observedAt?: string
}>

export type DevReply<K extends DevOperation = DevOperation, T = unknown> =
  | Readonly<{
      schemaVersion: 1
      operation: K
      requestId: string
      ok: true
      value: T
      observedAt: string
    }>
  | Readonly<{
      schemaVersion: 1
      operation: K
      requestId: string
      ok: false
      error: DevError
    }>

export type CapabilitySnapshot = Readonly<{
  scope: Scope
  granted: readonly DevCapability[]
  unavailable: readonly Readonly<{ capability: DevCapability; reason: DevErrorCode }>[]
  channelGeneration: number
  observedAt: string
}>

export type FileIdentity = Readonly<{
  device?: string
  inode?: string
  birthtimeNs?: string
  mtimeNs: string
  size: string
  contentSha256?: string
}>

export type WorkspacePath = Readonly<{
  worktreeId: string
  rootIdentity: FileIdentity
  relativePath: string
}>

// ─── Files / search DTOs (#399) ─────────────────────────────────────────────
// Exact shapes from the dev-runtime spec; the registry `reply` names resolve
// to these types and reject unknown keys.

export type FileEntry = Readonly<{
  path: WorkspacePath
  identity: FileIdentity
  kind: 'file' | 'directory' | 'symlink' | 'special'
  size: string
  observedAt: string
}>

export type FileReadResult = Readonly<{
  entry: FileEntry
  offset: string
  bytes: Uint8Array
  eof: boolean
  eol: 'lf' | 'crlf' | 'mixed' | 'none'
  encoding: 'utf8' | 'binary'
}>

export type FileWriteResult = Readonly<{
  entry: FileEntry
  previousIdentity: FileIdentity
  atomic: true
}>

export type FileMutationResult = Readonly<{
  path: WorkspacePath
  previousIdentity: FileIdentity
  state: 'deleted'
}>

/** Dry-run-enumerated tree mutation result (#399 recursive delete/copy).
 *  `items` counts the entries the confirmed commit processed; `totalBytes`
 *  carries the observed byte total for copies (zero for deletes). */
export type FileTreeMutationResult = Readonly<{
  path: WorkspacePath
  state: 'deleted' | 'copied'
  items: number
  totalBytes: string
  observedAt: string
}>

export type SearchMatch = Readonly<{
  path: WorkspacePath
  identity: FileIdentity
  line: number
  column: number
  preview: string
  ranges: ReadonlyArray<{ start: number; end: number }>
}>

export type ExternalOpenResult = Readonly<{
  accepted: true
  path: WorkspacePath
  applicationLabel?: string
}>

// ─── Local git / diff DTOs (#399) ───────────────────────────────────────────

export type GitStatusEntry = Readonly<{
  path: WorkspacePath
  staged: string
  unstaged: string
  untracked: boolean
}>

export type GitStatus = Readonly<{
  worktreeId: string
  headRef?: string
  headSha?: string
  indexSha: string
  entries: ReadonlyArray<GitStatusEntry>
  observedAt: string
}>

export type GitCommit = Readonly<{
  sha: string
  parents: ReadonlyArray<string>
  authorName: string
  authoredAt: string
  subject: string
  body?: string
}>

export type DiffHunk = Readonly<{
  path: WorkspacePath
  oldPath?: WorkspacePath
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: ReadonlyArray<{ kind: 'context' | 'add' | 'delete'; text: string }>
}>

export type GitFetchResult = Readonly<{
  remoteName: string
  before: Readonly<Record<string, string>>
  after: Readonly<Record<string, string>>
  observedAt: string
}>

export type GitCheckpoint = Readonly<{
  id: string
  worktreeId: string
  baseSha?: string
  treeSha: string
  createdAt: string
  label?: string
}>

// ─── GitHub remote source control (#423) ────────────────────────────────────
//
// Host-neutral DTOs: GitHub response objects never enter UI state. Every
// field is decoded strictly from the provider transport (`gh` JSON is
// untrusted input), and fields the API cannot prove stay absent rather than
// fabricated. `version` is the provider's local optimistic-concurrency token
// for a read model: it bumps whenever the server-side `updatedAt` moves.

export type GitHubAccount = Readonly<{
  provider: 'github'
  host: string
  login: string
  name?: string
  profileUrl?: string
  observedAt: string
}>

export type GitHubRepository = Readonly<{
  repoId: string
  provider: 'github'
  host: string
  owner: string
  name: string
  fullName: string
  defaultBranch: string
  url: string
  visibility: 'public' | 'private'
  fork: boolean
  freshness: 'fresh' | 'stale'
  observedAt: string
}>

export type GitHubAheadBehind = Readonly<{
  ahead: number
  behind: number
}>

export type GitHubPullRequest = Readonly<{
  id: string
  repoId: string
  number: number
  host: string
  owner: string
  repo: string
  title: string
  body?: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  headRef: string
  headSha: string
  baseRef: string
  baseSha: string
  authorLogin?: string
  url: string
  mergeable: 'mergeable' | 'conflicting' | 'unknown'
  reviewDecision?: 'approved' | 'changes_requested' | 'review_required'
  aheadBehind?: GitHubAheadBehind
  labels: readonly string[]
  version: number
  updatedAt: string
  observedAt: string
  /** createPullRequest reconciled onto an already-open PR instead of duplicating. */
  reconciled?: boolean
}>

export type GitHubCheck = Readonly<{
  id: string
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion?:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'stale'
  detailsUrl?: string
  startedAt?: string
  completedAt?: string
}>

export type GitHubIssue = Readonly<{
  id: string
  number: number
  title: string
  state: 'open' | 'closed'
  url: string
  labels: readonly string[]
  milestone?: string
  updatedAt: string
}>

export type GitHubMilestone = Readonly<{
  id: string
  number: number
  title: string
  state: 'open' | 'closed'
  dueOn?: string
  openIssues: number
  closedIssues: number
  url: string
}>

export type GitPushResult = Readonly<{
  repoId: string
  worktreeId: string
  ref: string
  remoteName: string
  headSha: string
  remoteSha: string
  forced: boolean
  upstreamSet: boolean
  observedAt: string
}>

export type GitUpdateBranchResult = Readonly<{
  pullRequestId: string
  worktreeId: string
  strategy: 'merge'
  state: 'merged' | 'conflicted' | 'up_to_date'
  previousHeadSha: string
  headSha?: string
  conflictedPaths?: readonly string[]
  /** Exact recovery actions when state is `conflicted`; never executed implicitly. */
  recovery?: Readonly<{ abort: string; continue: string }>
  observedAt: string
}>

export type PaneLeaf = Readonly<{
  kind: 'leaf'
  id: string
  pane: 'terminal' | 'editor'
  resourceId?: string
}>
export type PaneSplit = Readonly<{
  kind: 'split'
  id: string
  direction: 'row' | 'column'
  ratio: number
  children: readonly [PaneNode, PaneNode]
}>
export type PaneNode = PaneLeaf | PaneSplit

export type DevUtilityPane =
  | 'files'
  | 'source_control'
  | 'browser'
  | 'devices'
  | 'agents'
  | 'history'

export type DevLayoutPreferencesV1 = Readonly<{
  schemaVersion: 1
  scope: Scope
  projectId: string
  runtimeSessionId: string
  center: PaneNode
  utility: readonly Readonly<{
    pane: DevUtilityPane
    side: 'left' | 'right'
    visible: boolean
    size: number
    lastNonzeroSize: number
  }>[]
  focusMode: boolean
  focusTargetId?: string
}>

export type DevUtilityPreference = Readonly<{
  pane: DevUtilityPane
  side: 'left' | 'right'
  order: number
  visible: boolean
  size: number
  lastNonzeroSize: number
  fullWidth: boolean
}>

/**
 * V2 is the first implementation-complete format. The six utility panes are
 * present exactly once. At most one pane is visible per side; both sides may
 * be visible simultaneously. No utility field confers runtime authority.
 */
export type DevLayoutPreferencesV2 = Readonly<{
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
  /** MUST identify a leaf in center, never a split node. */
  focusTargetId?: string
}>

export type ArchiveRecord = Readonly<{
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
}>

export type RuntimeSession = Readonly<{
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
  lifecycle:
    | 'preparing'
    | 'ready'
    | 'active'
    | 'disconnected'
    | 'completed'
    | 'failed'
    | 'cancelled'
  archived: boolean
  projection: 'structured' | 'authenticated_hook' | 'terminal_fallback'
  generation: number
  version: number
}>

export type Project = Readonly<{
  id: string
  scope: Scope
  name: string
  groupIds: readonly string[]
  repoIds: readonly string[]
  /** Authoritative repository bindings minted at import (#398). */
  repos?: readonly ProjectRepoBinding[]
  preferredRuntimeNodeId?: string
  defaultBaseRef?: string
  bootstrapWorkflowId?: string
  defaultHarnessId?: string
  lifecycle: 'importing' | 'cloning' | 'scanning' | 'ready' | 'archived' | 'failed'
  version: number
}>

// An imported project binds each repository to the authorized root bookmark
// that proves it: the canonical host path never comes from a client body, it
// is resolved through the roots authority at import time.
export type ProjectRepoBinding = Readonly<{
  repoId: string
  rootBookmarkId: string
  canonicalRoot: string
}>

export type Group = Readonly<{
  id: string
  scope: Scope
  name: string
  colorToken?: string
  projectIds: readonly string[]
  sortKey: string
  version: number
}>

// One scanner recommendation: a preview of an importable workspace package.
// Scanning never executes install/bootstrap commands; `suggestedScripts` are
// manifest-declared names surfaced for confirmation, never run by the host.
export type ProjectScanEntry = Readonly<{
  /** Workspace package name from its manifest, or the directory basename. */
  name: string
  /** '/'-separated path of the package directory relative to the scan root. */
  relativeDir: string
  /** Manifest path relative to the scan root that proved this candidate. */
  manifestPath: string
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'cargo' | 'pip' | 'poetry' | 'uv' | 'unknown'
  /** Toolchain markers observed beside the manifest. */
  languages: readonly string[]
  /** Manifest-declared script names offered as bootstrap/check previews. */
  suggestedScripts: readonly string[]
  /** Per-entry diagnostics (`malformed_manifest`, `manifest_too_large`). */
  diagnostics: readonly string[]
}>

// `dev.project.scan` reply. A partial page is a successful answer whose
// `diagnostics` say why it stopped (`budget_exhausted`, `cancelled`) — never a
// silent truncation and never a failed command for a successful partial scan.
export type ProjectScanPage = Readonly<{
  rootBookmarkId: string
  items: readonly ProjectScanEntry[]
  partial: boolean
  diagnostics: readonly string[]
  observedAt: string
  nextCursor?: string
}>

// A repository binding (#398): the canonical remote identity is redacted
// before any DTO — embedded user-info is removed, the full nested namespace
// path is preserved, and the credential secret never enters a reply.
export type RedactedRemote = Readonly<{
  provider: 'github' | 'gitlab' | 'other'
  host: string
  ownerPath: string
  displayUrl: string
}>

// One authorized source: a git checkout or a plain folder bound to the
// runtime through an authorized root bookmark. `lifecycle` is repo truth:
// `authorizing` (binding known, identity not yet proven), `ready` (adopted
// and proven), `stale` (remote could not be re-proven), `unavailable`
// (canonical root missing on disk), `refreshing` (transient, never
// persisted as a reply state).
export type Repo = Readonly<{
  id: string
  scope: Scope
  kind: 'git' | 'folder'
  lifecycle: 'authorizing' | 'ready' | 'unavailable' | 'stale' | 'refreshing'
  canonicalRoot: string
  gitCommonDirIdentity?: FileIdentity
  remote?: RedactedRemote
  defaultRef?: string
  projectIds: readonly string[]
  version: number
}>

// Read-only `dev.repo.inspect` reply: repo record plus fresh on-disk facts
// computed from the canonical root with local git reads only — no network.
export type RepoInspection = Readonly<{
  repo: Repo
  rootIdentity: FileIdentity
  headRef?: string
  headSha?: string
  dirty: boolean
  observedAt: string
}>

// A RootBookmark is a durable grant that a directory or repository root has
// been authorized by the owner. M10's authorized-root flow mints and revokes
// bookmarks; M12 consumes them but cannot mint one.
export type RootBookmark = Readonly<{
  id: string
  scope: Scope
  label: string
  kind: 'directory' | 'repository'
  canonicalRoot: string
  rootIdentity: FileIdentity
  state: 'active' | 'stale' | 'revoked'
  generation: number
  version: number
}>

// A CredentialRef identifies vault-held credential material without exposing
// it. The secret never enters a command body, reply, event, or log.
export type CredentialRef = Readonly<{
  id: string
  scope: Scope
  label: string
  host: string
  kind: 'git_https' | 'github_token' | 'ssh_key' | 'other'
  state: 'ready' | 'expired' | 'revoked' | 'unknown'
  version: number
}>

// M10 discovery is the sole authority for harness installation truth; Dev View
// renders these projections and never re-probes. `executableIdentity` uses
// host-native path form inside authorized host DTOs only — remote clients
// receive the redacted `executableLabel` unless granted path detail.
export type HarnessProtocol = 'native' | 'acp' | 'pty'
export type HarnessAuthState = 'ready' | 'required' | 'expired' | 'unknown'
export type HarnessHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
export type HarnessModel = Readonly<{
  id: string
  displayName: string
  capabilities: readonly string[]
}>
export type HarnessInstallation = Readonly<{
  id: string
  scope: Scope
  executableIdentity: string
  executableLabel: string
  protocol: HarnessProtocol
  version?: string
  auth: HarnessAuthState
  health: HarnessHealth
  capabilities: readonly string[]
  models: readonly HarnessModel[]
  observedAt: string
  generation: number
}>
export type RuntimeConnectionTransport = 'direct_local' | 'remote_gateway'
export type RuntimeConnectionProvenance = 'user_managed' | 'managed'
export type RuntimeConnectionFreshness = 'fresh' | 'stale'
export type HarnessAcpAvailability = 'available' | 'adapter_required' | 'unavailable'
export type RuntimeConnectionBlocker = Readonly<{
  code: DevErrorCode
  message: string
}>
export type RuntimeConnectionEligibility = Readonly<{
  eligible: boolean
  blockers: readonly RuntimeConnectionBlocker[]
}>
// One RuntimeConnection candidate: a discovered installation joined with its
// driver identity, eligibility, and diagnostics metadata. `freshness` is
// derived on read from `observedAt` and never stored.
export type RuntimeConnectionInventoryEntry = Readonly<{
  id: string
  scope: Scope
  family: string
  displayName: string
  driverId: string
  driverVersion: string
  provenance: RuntimeConnectionProvenance
  executableIdentity: string
  executableLabel: string
  protocol: HarnessProtocol
  acpAvailability: HarnessAcpAvailability
  acpVersion?: string
  version?: string
  auth: HarnessAuthState
  health: HarnessHealth
  capabilities: readonly string[]
  sessionOperations: readonly string[]
  entitlementHints: readonly string[]
  limitations: readonly string[]
  eligibility: RuntimeConnectionEligibility
  transport: RuntimeConnectionTransport
  models: readonly HarnessModel[]
  observedAt: string
  generation: number
}>
export type RuntimeConnectionInventorySnapshot = Readonly<{
  scope: Scope
  items: readonly RuntimeConnectionInventoryEntry[]
  freshness: readonly RuntimeConnectionFreshness[]
  observedAt: string
}>

// ─── Harness runtime substrate (#31 managed Pi / #32 ACP lane) ──────────────
//
// Wire DTOs for the harness-runtime substrate that #400 launches through. The
// substrate owns the managed-Pi installation lifecycle and the ACP lane
// connection; it never fabricates a session or a run, and it performs no
// model-facing harness engineering (no compaction, no prompt rewriting, no
// task planning — harnesses own their internal loops).

export type AgentProfileRef = Readonly<{
  id: string
  version: number
  displayName: string
  capabilityPolicyVersion: number
}>

export type HarnessRunState =
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

export type HarnessRun = Readonly<{
  id: string
  scope: Scope
  runtimeSessionId: string
  installationId: string
  agentProfile: AgentProfileRef
  modelId?: string
  /**
   * Present when the run was launched with the `attachTerminal` intent: the
   * harness process was spawned as the sidecar PTY child of this terminal,
   * at this terminal generation (#400). The binding is provenance of where
   * the run's process lives — exit facts are still only ever OBSERVED
   * through the sidecar, never assumed.
   */
  terminalId?: string
  terminalGeneration?: number
  state: HarnessRunState
  generation: number
  startedAt?: string
  finishedAt?: string
  version: number
}>

export type ManagedPiInstallState = 'absent' | 'resolving' | 'installing' | 'ready' | 'failed'

export type ManagedPiStatus = Readonly<{
  scope: Scope
  driverId: string
  driverVersion: string
  /** The build-time pinned version; never resolved from the network. */
  pinnedVersion: string
  state: ManagedPiInstallState
  /** Stable installation identity once ready (joins to launch/resume). */
  installationId?: string
  /** The version actually observed after install; equals pinnedVersion on success. */
  resolvedVersion?: string
  executableIdentity?: string
  executableLabel?: string
  lastErrorCode?: DevErrorCode
  lastError?: string
  observedAt: string
  generation: number
}>

// One user-expressed harness preference on a runtime node (#400), versioned
// per account/workspace/runtime node. Preferences reference installations by
// stable ID and never store credential values. A disabled preference is never
// auto-launched. On a clean desktop the STORED list is empty: the effective
// projection synthesizes the managed-Pi-first root default until the user
// expresses a preference (owner decision, 2026-09-16).
export type HarnessPreference = Readonly<{
  scope: Scope
  harnessInstallationId: string
  enabled: boolean
  sortKey: string
  projectId?: string
  default: boolean
  agentProfileId?: string
  modelId?: string
  version: number
}>

/** The mutable patch for `dev.harness.preferenceUpdate`. Clearing the
 * preferred profile/model is a whole-record reset (`preferenceReset`). */
export type HarnessPreferenceMutableFields = Readonly<{
  enabled?: boolean
  default?: boolean
  sortKey?: string
  agentProfileId?: string
  modelId?: string
}>

export type AcpConnectionState = 'connecting' | 'ready' | 'disconnected' | 'closed' | 'failed'
export type AcpHistoryCapability = 'available' | 'unavailable'

export type AcpConnection = Readonly<{
  id: string
  scope: Scope
  /** The canonical RuntimeSession this lane is bound to (never a second type). */
  runtimeSessionId: string
  harnessInstallationId: string
  driverId: string
  driverVersion: string
  negotiatedProtocolVersion: string
  requiredCapabilities: readonly string[]
  negotiatedCapabilities: readonly string[]
  missingRequiredCapabilities: readonly string[]
  sessionOperations: readonly string[]
  limitations: readonly string[]
  /** Native ACP history is a separate capability and is never fabricated. */
  history: AcpHistoryCapability
  state: AcpConnectionState
  closeReason?: string
  observedAt: string
  generation: number
}>

// ─── Terminal runtime (#396) ────────────────────────────────────────────────
// Wire DTOs for the integrated terminal. Health is orthogonal to state; the
// lifecycle machine and limits are normative in docs/specs/dev-runtime.md
// ("Terminal protocol", "Sidecar adoption").

export type TerminalState = 'creating' | 'running' | 'detached' | 'terminating' | 'exited'

export type TerminalHealth = 'healthy' | 'degraded' | 'replay_required' | 'faulted'

export type TerminalRecord = Readonly<{
  id: string
  scope: Scope
  runtimeSessionId: string
  worktreeId: string
  sidecarId: string
  processRecordId: string
  state: TerminalState
  health: TerminalHealth
  /** Canonical unsigned decimal: next output sequence (last + 1). */
  lastSeq: string
  generation: number
}>

export type TerminalCheckpoint = Readonly<{
  id: string
  terminalId: string
  generation: number
  /** Canonical unsigned decimal: checkpoint covers through this sequence. */
  throughSequence: string
  segmentSha256: string
  /** Canonical unsigned decimal byte length. */
  byteLength: string
  createdAt: string
}>

export type TerminalSearchMatch = Readonly<{
  terminalId: string
  generation: number
  sequence: string
  byteOffset: string
  preview: string
}>

export type ShellProfile = Readonly<{
  id: string
  scope: Scope
  label: string
  argv: readonly string[]
  envAllowlistKeys: readonly string[]
  builtin: boolean
  version: number
}>

export const runtimeEventKinds = [
  'session.created',
  'session.starting',
  'session.ready',
  'session.disconnected',
  'session.resumed',
  'session.completed',
  'session.failed',
  'session.cancelled',
  'run.created',
  'run.starting',
  'run.ready',
  'run.disconnected',
  'run.resumed',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'turn.user_input',
  'turn.assistant_delta',
  'turn.assistant_message',
  'turn.result',
  'tool.requested',
  'tool.started',
  'tool.progress',
  'tool.completed',
  'tool.failed',
  'approval.requested',
  'approval.resolved',
  'approval.expired',
  'question.requested',
  'question.resolved',
  'question.expired',
  'file.observed',
  'checkpoint.observed',
  'subagent.observed',
  'usage.observed',
  'terminal.command_started',
  'terminal.command_finished',
  'terminal.cwd_changed',
  'terminal.transcript_reference',
  'capability.degraded',
  'capability.restored',
] as const
export type RuntimeEventKind = (typeof runtimeEventKinds)[number]
export const dataClassifications = [
  'public',
  'workspace_metadata',
  'workspace_private',
  'credential',
  'restricted_local',
] as const
export type DataClassification = (typeof dataClassifications)[number]

export type RuntimeEvent = Readonly<{
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
}>

export type DevRuntimePage<T> = Readonly<{
  items: readonly T[]
  nextCursor?: string
  observedAt: string
}>

// ─── Browser and device lanes (#422) ────────────────────────────────────────
//
// DTOs for the ADR 0006 lane model: the human embedded lane, the task-owned
// agent lane, and the external user-context lane never share a profile, and
// every device attachment is capability-gated. Field shapes are transcribed
// from the Dev Runtime spec's core domain model; the registry validates the
// same shapes through `namedType`.

export const browserLaneStates = [
  'provisioning',
  'ready',
  'navigating',
  'suspended',
  'closing',
  'closed',
  'crashed',
  'recovering',
] as const
export type BrowserLaneState = (typeof browserLaneStates)[number]

export const deviceSessionStates = [
  'discovering',
  'available',
  'starting',
  'attached',
  'suspended',
  'stopping',
  'stopped',
] as const
export type DeviceSessionState = (typeof deviceSessionStates)[number]

export type BrowserLane = Readonly<{
  id: string
  scope: Scope
  runtimeSessionId: string
  kind: 'human_embedded' | 'task_owned' | 'user_context'
  profileId: string
  state: BrowserLaneState
  automationOwner: 'none' | 'agent' | 'human_takeover'
  generation: number
}>

/** A named lane-permission policy; hosts mint it, lanes record the one used. */
export type ProfilePolicy = Readonly<{
  id: string
  scope: Scope
  label: string
  allowedPermissions: readonly string[]
  version: number
}>

export type DeviceSession = Readonly<{
  id: string
  scope: Scope
  runtimeSessionId: string
  inventoryId: string
  kind: 'responsive' | 'ios_simulator' | 'android_emulator' | 'physical'
  state: DeviceSessionState
  processRecordId?: string
  generation: number
}>

export type BrowserTarget = Readonly<{
  id: string
  browserLaneId: string
  type: 'page' | 'frame' | 'worker'
  url: string
  title: string
  generation: number
}>

export type BrowserNavigation = Readonly<{
  browserLaneId: string
  targetId: string
  finalUrl: string
  status?: number
  generation: number
  observedAt: string
}>

export type BrowserAnnotation = Readonly<{
  targetId: string
  kind: 'point' | 'rect' | 'text'
  x: number
  y: number
  width?: number
  height?: number
  text?: string
  id: string
  screenshotId: string
  createdAt: string
}>

export type BrowserInspection = Readonly<{
  targetId: string
  nodeId?: string
  role?: string
  name?: string
  bounds?: Readonly<{ x: number; y: number; width: number; height: number }>
  observedAt: string
}>

export type BrowserDiagnostic = Readonly<{
  id: string
  level: 'info' | 'warning' | 'error'
  category: 'console' | 'network' | 'crash' | 'policy'
  message: string
  observedAt: string
}>

export type ScreenshotRef = Readonly<{
  id: string
  scope: Scope
  ownerId: string
  laneKind: 'human_embedded' | 'task_owned' | 'user_context' | 'device'
  profileId?: string
  origin: string
  viewport: Readonly<{ width: number; height: number; deviceScaleFactor: number }>
  redacted: boolean
  contentType: 'image/png' | 'image/jpeg' | 'image/webp'
  byteLength: string
  width: number
  height: number
  sha256: string
  expiresAt: string
}>

export type CookieImportResult = Readonly<{
  browserLaneId: string
  imported: number
  skipped: number
  rolledBack: boolean
  observedAt: string
}>

export type DeviceInventoryItem = Readonly<{
  id: string
  kind: DeviceSession['kind']
  name: string
  platform: string
  state: 'available' | 'busy' | 'offline' | 'unauthorized'
  generation: number
  observedAt: string
}>

// ─── #472 computer-use lanes ────────────────────────────────────────────────
// A computer-use lane is a session-scoped grant over the execution host's
// real desktop. The wire shape mirrors BrowserLane: immutable identity,
// generation fences every authority transfer, and no capability state is
// embedded — capability truth lives in the capability report, probed through
// the #471 permissions substrate, never asserted by callers.

export const computerUseLaneStates = ['idle', 'granted', 'suspended', 'closed', 'crashed'] as const
export type ComputerUseLaneState = (typeof computerUseLaneStates)[number]

export type ComputerUseLane = Readonly<{
  id: string
  scope: Scope
  runtimeSessionId: string
  state: ComputerUseLaneState
  automationOwner: 'none' | 'agent' | 'human_takeover'
  generation: number
}>

export const computerUseCapabilityIds = ['input', 'capture', 'ax_tree'] as const
export type ComputerUseCapabilityId = (typeof computerUseCapabilityIds)[number]

/**
 * One capability row of the report. `state` mirrors the honest probe
 * taxonomy: `available` only when a probe plus host tool prove it, `denied`
 * when the TCC service refused, `not_determined` when a consent prompt is
 * pending, and `unavailable` (with `missingPiece`) when this lane has no way
 * to prove or provide the capability — never a stand-in for denied/granted.
 */
export type ComputerUseCapabilityRow = Readonly<{
  id: ComputerUseCapabilityId
  state: 'available' | 'denied' | 'not_determined' | 'unavailable'
  /** Present exactly when `state` is `unavailable`. */
  unavailableReason?: 'capability_unavailable' | 'unsupported_platform'
  /** The exact missing piece for `unavailable` rows. */
  missingPiece?: string
  /** The #471 permission the capability depends on, when one does. */
  permissionId?: MacPermissionId
  probedAt: string
}>

export type ComputerUseCapabilityReport = Readonly<{
  hostPlatform: 'macos' | 'other' | 'unknown'
  capabilities: readonly ComputerUseCapabilityRow[]
  probedAt: string
}>

/**
 * An issuance-backed, single-use consent record. It binds one owner
 * confirmation to one lane/generation, carries the digest of the #471
 * permission snapshot it was minted against, and expires within 60 seconds.
 */
export type ComputerUseConsent = Readonly<{
  consentId: string
  computerUseLaneId: string
  runtimeSessionId: string
  scope: Scope
  generation: number
  permissionDigest: string
  createdAt: string
  expiresAt: string
}>

export type PortRecord = Readonly<{
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
}>

// #424 runtime resources: processes, metrics, usage, and retained data. A
// process row exists only when the host can prove it from a launch record
// (durable journal entry matched against the supervision snapshot); a reused
// PID or an unprovable launch is never listed as owned, so no stop path can
// exist for it.
export type ProcessOwnerKind =
  | 'terminal'
  | 'harness'
  | 'server'
  | 'browser'
  | 'device'
  | 'bootstrap'
  | 'git'

export type ProcessRecord = Readonly<{
  id: string
  scope: Scope
  runtimeSessionId?: string
  worktreeId?: string
  ownerKind: ProcessOwnerKind
  ownerId: string
  pid: number
  startIdentity: string
  executableIdentity: string
  processGroupIdentity?: string
  generation: number
  state: 'starting' | 'running' | 'stopping' | 'exited' | 'unknown'
}>

export type ResourceMetric = Readonly<{
  ownerId: string
  cpuPercent?: number
  residentBytes?: string
  readBytes?: string
  writeBytes?: string
  observedAt: string
  confidence: 'authoritative' | 'measured' | 'estimated'
  // #424 additive isolation: every point is keyed by runtime node scope and
  // launch generation so metrics from another node or generation never merge.
  processRecordId?: string
  runtimeSessionId?: string
  worktreeId?: string
  generation?: number
}>

export type UsageSource = 'official_api' | 'harness_protocol' | 'local_transcript_estimate'

export type UsageRecord = Readonly<{
  id: string
  ownerId: string
  provider: string
  quantity: string
  unit: string
  costMicros?: string
  source: UsageSource
  confidence: 'authoritative' | 'measured' | 'estimated'
  observedAt: string
  // #424 additive adapter-contract fields: safe display label, period,
  // remaining, freshness, and the typed failure when the adapter could not
  // observe usage (failure rows carry explicit `unknown` quantities, never 0).
  accountLabel?: string
  period?: Readonly<{ from: string; to: string }>
  remaining?: string
  capturedAt?: string
  expiresAt?: string
  failure?: Readonly<{ code: DevErrorCode; message: string }>
}>

export type RetainedDataRecord = Readonly<{
  id: string
  ownerId: string
  kind: 'terminal' | 'checkpoint' | 'screenshot' | 'browser_profile' | 'log' | 'dependency_template'
  byteLength: string
  protected: boolean
  expiresAt?: string
  observedAt: string
  // #424 additive: scope isolation and a safe display label for breakdowns.
  scope?: Scope
  label?: string
}>

export type ResourceSnapshot = Readonly<{
  processes: readonly ProcessRecord[]
  ports: readonly PortRecord[]
  metrics: readonly ResourceMetric[]
  retainedData: readonly RetainedDataRecord[]
  observedAt: string
}>

export type CleanupPredicate = Readonly<
  | { kind: 'clean' }
  | { kind: 'pushed' }
  | { kind: 'pull_request_merged' }
  | { kind: 'no_active_leases' }
  | { kind: 'no_active_owned_resources' }
  | { kind: 'archived_for'; seconds: number }
>

export type CleanupPolicy = Readonly<{
  id: string
  scope: Scope
  projectId: string
  version: number
  state: 'draft' | 'approved' | 'disabled' | 'expired' | 'superseded'
  approvedBy?: string
  approvedAt?: string
  expiresAt?: string
  predicates: readonly CleanupPredicate[]
  allowedSteps: readonly CleanupStepKind[]
}>

export type CleanupPolicyEvaluation = Readonly<{
  policyId: string
  worktreeId: string
  matched: boolean
  facts: Readonly<Record<string, string>>
  blockers: readonly CleanupBlocker[]
  evaluatedAt: string
  /** Evaluation observes facts only; it never executes a cleanup step. */
  executesNothing: true
}>

export type CleanupBlocker = Readonly<{
  code: DevErrorCode
  resourceId?: string
  message: string
}>

/** Plan digest for a plan/commit mutation pair; the commit rejects changed facts. */
export type MutationPlan = Readonly<{
  id: string
  operation: DevOperation
  scope: Scope
  resource: Readonly<{ kind: string; id: string; generation: number }>
  factVersions: Readonly<Record<string, string>>
  steps: readonly Readonly<{
    id: string
    kind: string
    targetId: string
    dependsOn: readonly string[]
  }>[]
  blockers: readonly CleanupBlocker[]
  requiredApprovalIds: readonly string[]
  digest: string
  expiresAt: string
}>

const cleanupBlockerKeys = ['code', 'message'] as const
const cleanupBlockerOptionalKeys = ['resourceId'] as const

function decodeCleanupBlocker(value: unknown, path: string): CleanupBlocker {
  const item = record(value, path)
  exactKeys(item, [...cleanupBlockerKeys], [...cleanupBlockerOptionalKeys], path)
  literal(item.code, devErrorCodes, `${path}.code`)
  if (item.resourceId !== undefined) stringValue(item.resourceId, `${path}.resourceId`, 1, 256)
  stringValue(item.message, `${path}.message`, 1, 4096)
  return value as CleanupBlocker
}

function decodeMutationPlan(value: unknown): MutationPlan {
  const item = record(value, 'mutationPlan')
  exactKeys(
    item,
    [
      'id',
      'operation',
      'scope',
      'resource',
      'factVersions',
      'steps',
      'blockers',
      'requiredApprovalIds',
      'digest',
      'expiresAt',
    ],
    [],
    'mutationPlan'
  )
  if (!uuidPattern.test(stringValue(item.id, 'mutationPlan.id')))
    fail('mutationPlan.id', 'expected lowercase UUID')
  const operation = item.operation
  if (typeof operation !== 'string' || !(operation in devOperationDefinitions))
    fail('mutationPlan.operation', 'unknown operation')
  decodeScope(item.scope, 'mutationPlan.scope')
  resourceBinding(item.resource, 'mutationPlan.resource')
  const factVersions = record(item.factVersions, 'mutationPlan.factVersions')
  for (const [key, entry] of Object.entries(factVersions)) {
    stringValue(key, 'mutationPlan.factVersions key', 1, 256)
    stringValue(entry, `mutationPlan.factVersions.${key}`, 1, 4096)
  }
  if (!Array.isArray(item.steps)) fail('mutationPlan.steps', 'expected array')
  if (item.steps.length > 10_000) fail('mutationPlan.steps', 'steps exceed 10,000')
  item.steps.forEach((step, index) => {
    const stepItem = record(step, `mutationPlan.steps[${index}]`)
    exactKeys(stepItem, ['id', 'kind', 'targetId', 'dependsOn'], [], `mutationPlan.steps[${index}]`)
    stringValue(stepItem.id, `mutationPlan.steps[${index}].id`, 1, 256)
    stringValue(stepItem.kind, `mutationPlan.steps[${index}].kind`, 1, 128)
    stringValue(stepItem.targetId, `mutationPlan.steps[${index}].targetId`, 0, 4096)
    validateType('string[]', stepItem.dependsOn, `mutationPlan.steps[${index}].dependsOn`)
  })
  if (!Array.isArray(item.blockers)) fail('mutationPlan.blockers', 'expected array')
  item.blockers.forEach((blocker, index) =>
    decodeCleanupBlocker(blocker, `mutationPlan.blockers[${index}]`)
  )
  validateType('string[]', item.requiredApprovalIds, 'mutationPlan.requiredApprovalIds')
  if (!sha256Pattern.test(stringValue(item.digest, 'mutationPlan.digest')))
    fail('mutationPlan.digest', 'expected sha256')
  timestamp(item.expiresAt, 'mutationPlan.expiresAt')
  return value as MutationPlan
}

/** Strict decoder for the plan/commit mutation plan DTO. */
export function decodeDevMutationPlan(value: unknown): MutationPlan {
  return decodeMutationPlan(value)
}

const objectPrototype = Object.prototype
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
const uint64Pattern = /^(?:0|[1-9]\d*)$/
const sha256Pattern = /^[0-9a-f]{64}$/
const gitShaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
// Stable provider-scoped identifiers minted by the GitHub provider slice
// (#423): `gh:<owner>/<repo>#<number>` for PRs/issues, `ghm:` for milestones.
const githubPullRequestIdPattern = /^gh:[A-Za-z0-9-]{1,100}\/[A-Za-z0-9._-]{1,100}#\d{1,9}$/
const githubMilestoneIdPattern = /^ghm:[A-Za-z0-9-]{1,100}\/[A-Za-z0-9._-]{1,100}#\d{1,9}$/
const authorityBodyKeys = new Set([
  'schemaVersion',
  'operation',
  'requestId',
  'nonce',
  'idempotencyKey',
  'issuedAt',
  'expiresAt',
  'scope',
  'capabilities',
  'resource',
  'channelId',
  'clientCredentialId',
  'proof',
])

function fail(path: string, message: string): never {
  throw new TypeError(`${path}: ${message}`)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== objectPrototype && Object.getPrototypeOf(value) !== null)
  ) {
    fail(path, 'expected object')
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string
) {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown key')
  for (const key of required) if (!(key in value)) fail(`${path}.${key}`, 'required')
}

function stringValue(value: unknown, path: string, min = 0, max = Number.POSITIVE_INFINITY) {
  if (typeof value !== 'string' || value.length < min || value.length > max)
    fail(path, `expected string length ${min}..${max}`)
  return value
}

function integerValue(
  value: unknown,
  path: string,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER
) {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    fail(path, `expected integer ${min}..${max}`)
  return value as number
}

function finiteNumber(value: unknown, path: string, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    fail(path, `expected finite number ${min}..${max}`)
  return value
}

function timestamp(value: unknown, path: string) {
  const text = stringValue(value, path)
  if (!timestampPattern.test(text) || Number.isNaN(Date.parse(text)))
    fail(path, 'expected UTC timestamp')
  return text
}

function splitTopLevel(source: string, separator: string): string[] {
  const parts: string[] = []
  let start = 0
  let braces = 0
  let brackets = 0
  let parentheses = 0
  let angles = 0
  let quote: string | undefined
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!
    if (quote) {
      if (character === quote && source[index - 1] !== '\\') quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === '{') braces += 1
    else if (character === '}') braces -= 1
    else if (character === '[') brackets += 1
    else if (character === ']') brackets -= 1
    else if (character === '(') parentheses += 1
    else if (character === ')') parentheses -= 1
    else if (character === '<') {
      // `<=N` is an inclusive cap in the registry DSL, not a nesting open:
      // without this, every field after a `Uint8Array<=N` / `T[]<=N` field
      // was swallowed and rejected as an unknown key.
      if (source[index + 1] !== '=') angles += 1
    } else if (character === '>') {
      if (angles > 0) angles -= 1
    } else if (
      character === separator &&
      braces === 0 &&
      brackets === 0 &&
      parentheses === 0 &&
      angles === 0
    ) {
      parts.push(source.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(source.slice(start).trim())
  return parts.filter(Boolean)
}

function assertNoAuthorityFields(value: unknown, path = 'body') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoAuthorityFields(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object' || value instanceof Uint8Array) return
  for (const [key, child] of Object.entries(value)) {
    if (authorityBodyKeys.has(key)) fail(`${path}.${key}`, 'authority field is forbidden in body')
    assertNoAuthorityFields(child, `${path}.${key}`)
  }
}

const cleanupSteps = [
  'stop_owned_resource',
  'run_teardown',
  'quarantine_worktree',
  'unregister_worktree',
  'delete_quarantine',
  'delete_branch',
  'prune_retained_data',
] as const
export type CleanupStepKind = (typeof cleanupSteps)[number]

function namedType(name: string, value: unknown, path: string): unknown {
  if (name === 'ArchiveRecord') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'id',
        'scope',
        'runtimeSessionId',
        'worktreeId',
        'state',
        'archivedAt',
        'archivedBy',
        'generation',
      ],
      ['reason', 'restoredAt'],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.runtimeSessionId, `${path}.runtimeSessionId`, 1, 256)
    stringValue(item.worktreeId, `${path}.worktreeId`, 1, 256)
    literal(item.state, ['archived', 'restoring', 'restored'], `${path}.state`)
    timestamp(item.archivedAt, `${path}.archivedAt`)
    stringValue(item.archivedBy, `${path}.archivedBy`, 1, 256)
    if (item.reason !== undefined) stringValue(item.reason, `${path}.reason`, 0, 512)
    integerValue(item.generation, `${path}.generation`, 0)
    if (item.restoredAt !== undefined) timestamp(item.restoredAt, `${path}.restoredAt`)
    return value
  }
  // #422 browser/device DTOs. Shapes mirror the Dev Runtime spec's core
  // domain model; the registry bodies and replies validate through here.
  if (name === 'BrowserLane') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'id',
        'scope',
        'runtimeSessionId',
        'kind',
        'profileId',
        'state',
        'automationOwner',
        'generation',
      ],
      [],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.runtimeSessionId, `${path}.runtimeSessionId`, 1, 256)
    literal(item.kind, ['human_embedded', 'task_owned', 'user_context'], `${path}.kind`)
    stringValue(item.profileId, `${path}.profileId`, 1, 256)
    literal(item.state, browserLaneStates, `${path}.state`)
    literal(item.automationOwner, ['none', 'agent', 'human_takeover'], `${path}.automationOwner`)
    integerValue(item.generation, `${path}.generation`, 0)
    return value
  }
  if (name === 'ProfilePolicy') {
    const item = record(value, path)
    exactKeys(item, ['id', 'scope', 'label', 'allowedPermissions', 'version'], [], path)
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.label, `${path}.label`, 1, 128)
    validateType('string[]', item.allowedPermissions, `${path}.allowedPermissions`)
    integerValue(item.version, `${path}.version`, 1)
    return value
  }
  if (name === 'DeviceSession') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'scope', 'runtimeSessionId', 'inventoryId', 'kind', 'state', 'generation'],
      ['processRecordId'],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.runtimeSessionId, `${path}.runtimeSessionId`, 1, 256)
    stringValue(item.inventoryId, `${path}.inventoryId`, 1, 256)
    literal(
      item.kind,
      ['responsive', 'ios_simulator', 'android_emulator', 'physical'],
      `${path}.kind`
    )
    literal(item.state, deviceSessionStates, `${path}.state`)
    if (item.processRecordId !== undefined)
      stringValue(item.processRecordId, `${path}.processRecordId`, 1, 256)
    integerValue(item.generation, `${path}.generation`, 0)
    return value
  }
  // #472 computer-use lanes. Shapes mirror the spec's "Computer use lanes"
  // section; capability rows carry their own probe time and never embed a
  // caller-supplied state.
  if (name === 'ComputerUseLane') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'scope', 'runtimeSessionId', 'state', 'automationOwner', 'generation'],
      [],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.runtimeSessionId, `${path}.runtimeSessionId`, 1, 256)
    literal(item.state, computerUseLaneStates, `${path}.state`)
    literal(item.automationOwner, ['none', 'agent', 'human_takeover'], `${path}.automationOwner`)
    integerValue(item.generation, `${path}.generation`, 0)
    return value
  }
  if (name === 'ComputerUseCapabilityRow') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'state', 'probedAt'],
      ['unavailableReason', 'missingPiece', 'permissionId'],
      path
    )
    literal(item.id, computerUseCapabilityIds, `${path}.id`)
    literal(item.state, ['available', 'denied', 'not_determined', 'unavailable'], `${path}.state`)
    if (item.unavailableReason !== undefined) {
      if (item.state !== 'unavailable')
        fail(`${path}.unavailableReason`, 'state is not unavailable')
      literal(
        item.unavailableReason,
        ['capability_unavailable', 'unsupported_platform'],
        `${path}.unavailableReason`
      )
    }
    if (item.missingPiece !== undefined) {
      if (item.state !== 'unavailable') fail(`${path}.missingPiece`, 'state is not unavailable')
      stringValue(item.missingPiece, `${path}.missingPiece`, 1, 512)
    }
    if (item.permissionId !== undefined) {
      if (!isMacPermissionId(item.permissionId))
        fail(`${path}.permissionId`, 'unknown permission id')
    }
    timestamp(item.probedAt, `${path}.probedAt`)
    return value
  }
  if (name === 'ComputerUseCapabilityReport') {
    const item = record(value, path)
    exactKeys(item, ['hostPlatform', 'capabilities', 'probedAt'], [], path)
    literal(item.hostPlatform, ['macos', 'other', 'unknown'], `${path}.hostPlatform`)
    if (!Array.isArray(item.capabilities)) fail(`${path}.capabilities`, 'expected array')
    if (item.capabilities.length > computerUseCapabilityIds.length)
      fail(`${path}.capabilities`, 'more capability rows than capability ids')
    const seen = new Set<string>()
    item.capabilities.forEach((entry, index) => {
      const row = namedType(
        'ComputerUseCapabilityRow',
        entry,
        `${path}.capabilities[${index}]`
      ) as ComputerUseCapabilityRow
      if (seen.has(row.id)) fail(`${path}.capabilities`, 'duplicate capability row')
      seen.add(row.id)
    })
    timestamp(item.probedAt, `${path}.probedAt`)
    return value
  }
  if (name === 'ComputerUseConsent') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'consentId',
        'computerUseLaneId',
        'runtimeSessionId',
        'scope',
        'generation',
        'permissionDigest',
        'createdAt',
        'expiresAt',
      ],
      [],
      path
    )
    if (!uuidPattern.test(stringValue(item.consentId, `${path}.consentId`)))
      fail(`${path}.consentId`, 'expected lowercase UUID')
    stringValue(item.computerUseLaneId, `${path}.computerUseLaneId`, 1, 256)
    stringValue(item.runtimeSessionId, `${path}.runtimeSessionId`, 1, 256)
    decodeScope(item.scope, `${path}.scope`)
    integerValue(item.generation, `${path}.generation`, 0)
    if (!sha256Pattern.test(stringValue(item.permissionDigest, `${path}.permissionDigest`)))
      fail(`${path}.permissionDigest`, 'expected sha256')
    timestamp(item.createdAt, `${path}.createdAt`)
    timestamp(item.expiresAt, `${path}.expiresAt`)
    return value
  }
  if (name === 'BrowserTarget') {
    const item = record(value, path)
    exactKeys(item, ['id', 'browserLaneId', 'type', 'url', 'title', 'generation'], [], path)
    stringValue(item.id, `${path}.id`, 1, 256)
    stringValue(item.browserLaneId, `${path}.browserLaneId`, 1, 256)
    literal(item.type, ['page', 'frame', 'worker'], `${path}.type`)
    stringValue(item.url, `${path}.url`, 1, 4096)
    stringValue(item.title, `${path}.title`, 0, 2048)
    integerValue(item.generation, `${path}.generation`, 0)
    return value
  }
  if (name === 'BrowserNavigation') {
    const item = record(value, path)
    exactKeys(
      item,
      ['browserLaneId', 'targetId', 'finalUrl', 'generation', 'observedAt'],
      ['status'],
      path
    )
    stringValue(item.browserLaneId, `${path}.browserLaneId`, 1, 256)
    stringValue(item.targetId, `${path}.targetId`, 1, 256)
    stringValue(item.finalUrl, `${path}.finalUrl`, 1, 4096)
    if (item.status !== undefined) integerValue(item.status, `${path}.status`, 100, 599)
    integerValue(item.generation, `${path}.generation`, 0)
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'BrowserAnnotation') {
    const item = record(value, path)
    const kind = literal(item.kind, ['point', 'rect', 'text'], `${path}.kind`)
    exactKeys(
      item,
      ['targetId', 'kind', 'x', 'y', 'id', 'screenshotId', 'createdAt'],
      ['width', 'height', 'text'],
      path
    )
    stringValue(item.targetId, `${path}.targetId`, 1)
    finiteNumber(item.x, `${path}.x`, 0, 1)
    finiteNumber(item.y, `${path}.y`, 0, 1)
    if (item.width !== undefined) finiteNumber(item.width, `${path}.width`, 0, 1)
    if (item.height !== undefined) finiteNumber(item.height, `${path}.height`, 0, 1)
    if (item.text !== undefined) stringValue(item.text, `${path}.text`, 0, 4096)
    if (kind === 'rect' && (item.width === undefined || item.height === undefined))
      fail(path, 'rect annotation requires width and height')
    if (kind === 'text' && item.text === undefined) fail(path, 'text annotation requires text')
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    stringValue(item.screenshotId, `${path}.screenshotId`, 1, 256)
    timestamp(item.createdAt, `${path}.createdAt`)
    return value
  }
  if (name === 'BrowserInspection') {
    const item = record(value, path)
    exactKeys(item, ['targetId', 'observedAt'], ['nodeId', 'role', 'name', 'bounds'], path)
    stringValue(item.targetId, `${path}.targetId`, 1)
    if (item.nodeId !== undefined) stringValue(item.nodeId, `${path}.nodeId`, 1, 256)
    if (item.role !== undefined) stringValue(item.role, `${path}.role`, 1, 128)
    if (item.name !== undefined) stringValue(item.name, `${path}.name`, 0, 2048)
    if (item.bounds !== undefined) {
      const bounds = record(item.bounds, `${path}.bounds`)
      exactKeys(bounds, ['x', 'y', 'width', 'height'], [], `${path}.bounds`)
      for (const key of ['x', 'y', 'width', 'height'] as const)
        finiteNumber(bounds[key], `${path}.bounds.${key}`)
    }
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'BrowserDiagnostic') {
    const item = record(value, path)
    exactKeys(item, ['id', 'level', 'category', 'message', 'observedAt'], [], path)
    stringValue(item.id, `${path}.id`, 1, 256)
    literal(item.level, ['info', 'warning', 'error'], `${path}.level`)
    literal(item.category, ['console', 'network', 'crash', 'policy'], `${path}.category`)
    stringValue(item.message, `${path}.message`, 1, 4096)
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'ScreenshotRef') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'id',
        'scope',
        'ownerId',
        'laneKind',
        'origin',
        'viewport',
        'redacted',
        'contentType',
        'byteLength',
        'width',
        'height',
        'sha256',
        'expiresAt',
      ],
      ['profileId'],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.ownerId, `${path}.ownerId`, 1, 256)
    literal(
      item.laneKind,
      ['human_embedded', 'task_owned', 'user_context', 'device'],
      `${path}.laneKind`
    )
    if (item.profileId !== undefined) stringValue(item.profileId, `${path}.profileId`, 1, 256)
    stringValue(item.origin, `${path}.origin`, 1, 2048)
    const viewport = record(item.viewport, `${path}.viewport`)
    integerValue(viewport.width, `${path}.viewport.width`, 1, 4096)
    integerValue(viewport.height, `${path}.viewport.height`, 1, 4096)
    if (
      typeof viewport.deviceScaleFactor !== 'number' ||
      !Number.isFinite(viewport.deviceScaleFactor) ||
      viewport.deviceScaleFactor <= 0 ||
      viewport.deviceScaleFactor > 8
    )
      fail(`${path}.viewport.deviceScaleFactor`, 'expected a positive finite scale factor')
    if (typeof item.redacted !== 'boolean') fail(`${path}.redacted`, 'expected boolean')
    literal(item.contentType, ['image/png', 'image/jpeg', 'image/webp'], `${path}.contentType`)
    uint64String(item.byteLength, `${path}.byteLength`)
    integerValue(item.width, `${path}.width`, 1, 4096)
    integerValue(item.height, `${path}.height`, 1, 4096)
    if (!sha256Pattern.test(stringValue(item.sha256, `${path}.sha256`)))
      fail(`${path}.sha256`, 'expected sha256')
    timestamp(item.expiresAt, `${path}.expiresAt`)
    return value
  }
  if (name === 'CookieImportResult') {
    const item = record(value, path)
    exactKeys(item, ['browserLaneId', 'imported', 'skipped', 'rolledBack', 'observedAt'], [], path)
    stringValue(item.browserLaneId, `${path}.browserLaneId`, 1, 256)
    integerValue(item.imported, `${path}.imported`, 0)
    integerValue(item.skipped, `${path}.skipped`, 0)
    if (typeof item.rolledBack !== 'boolean') fail(`${path}.rolledBack`, 'expected boolean')
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'DeviceInventoryItem') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'kind', 'name', 'platform', 'state', 'generation', 'observedAt'],
      [],
      path
    )
    stringValue(item.id, `${path}.id`, 1, 256)
    literal(
      item.kind,
      ['responsive', 'ios_simulator', 'android_emulator', 'physical'],
      `${path}.kind`
    )
    stringValue(item.name, `${path}.name`, 1, 256)
    stringValue(item.platform, `${path}.platform`, 1, 64)
    literal(item.state, ['available', 'busy', 'offline', 'unauthorized'], `${path}.state`)
    integerValue(item.generation, `${path}.generation`, 0)
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'PortRecord') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'scope', 'protocol', 'host', 'port', 'owner', 'state', 'observedAt'],
      ['processRecordId', 'runtimeSessionId', 'generation'],
      path
    )
    stringValue(item.id, `${path}.id`, 1, 256)
    decodeScope(item.scope, `${path}.scope`)
    literal(item.protocol, ['tcp', 'udp'], `${path}.protocol`)
    stringValue(item.host, `${path}.host`, 1, 253)
    integerValue(item.port, `${path}.port`, 1, 65_535)
    literal(item.owner, ['adea', 'external', 'unknown'], `${path}.owner`)
    if (item.processRecordId !== undefined)
      stringValue(item.processRecordId, `${path}.processRecordId`, 1, 256)
    if (item.runtimeSessionId !== undefined)
      stringValue(item.runtimeSessionId, `${path}.runtimeSessionId`, 1, 256)
    if (item.generation !== undefined) integerValue(item.generation, `${path}.generation`, 0)
    literal(item.state, ['observed', 'stale', 'gone'], `${path}.state`)
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  // #424 runtime-resource DTOs.
  if (name === 'ProcessRecord') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'id',
        'scope',
        'ownerKind',
        'ownerId',
        'pid',
        'startIdentity',
        'executableIdentity',
        'generation',
        'state',
      ],
      ['runtimeSessionId', 'worktreeId', 'processGroupIdentity'],
      path
    )
    stringValue(item.id, `${path}.id`, 1, 256)
    decodeScope(item.scope, `${path}.scope`)
    literal(
      item.ownerKind,
      ['terminal', 'harness', 'server', 'browser', 'device', 'bootstrap', 'git'],
      `${path}.ownerKind`
    )
    stringValue(item.ownerId, `${path}.ownerId`, 1, 256)
    integerValue(item.pid, `${path}.pid`, 1)
    stringValue(item.startIdentity, `${path}.startIdentity`, 1, 256)
    stringValue(item.executableIdentity, `${path}.executableIdentity`, 1, 1024)
    if (item.runtimeSessionId !== undefined)
      stringValue(item.runtimeSessionId, `${path}.runtimeSessionId`, 1, 256)
    if (item.worktreeId !== undefined) stringValue(item.worktreeId, `${path}.worktreeId`, 1, 256)
    if (item.processGroupIdentity !== undefined)
      stringValue(item.processGroupIdentity, `${path}.processGroupIdentity`, 1, 256)
    integerValue(item.generation, `${path}.generation`, 0)
    literal(item.state, ['starting', 'running', 'stopping', 'exited', 'unknown'], `${path}.state`)
    return value
  }
  if (name === 'ResourceMetric') {
    const item = record(value, path)
    exactKeys(
      item,
      ['ownerId', 'observedAt', 'confidence'],
      [
        'cpuPercent',
        'residentBytes',
        'readBytes',
        'writeBytes',
        'processRecordId',
        'runtimeSessionId',
        'worktreeId',
        'generation',
      ],
      path
    )
    stringValue(item.ownerId, `${path}.ownerId`, 1, 256)
    if (item.cpuPercent !== undefined) finiteNumber(item.cpuPercent, `${path}.cpuPercent`, 0, 1e6)
    for (const key of ['residentBytes', 'readBytes', 'writeBytes'] as const)
      if (item[key] !== undefined) stringValue(item[key], `${path}.${key}`, 1, 40)
    timestamp(item.observedAt, `${path}.observedAt`)
    literal(item.confidence, ['authoritative', 'measured', 'estimated'], `${path}.confidence`)
    if (item.processRecordId !== undefined)
      stringValue(item.processRecordId, `${path}.processRecordId`, 1, 256)
    if (item.runtimeSessionId !== undefined)
      stringValue(item.runtimeSessionId, `${path}.runtimeSessionId`, 1, 256)
    if (item.worktreeId !== undefined) stringValue(item.worktreeId, `${path}.worktreeId`, 1, 256)
    if (item.generation !== undefined) integerValue(item.generation, `${path}.generation`, 0)
    return value
  }
  if (name === 'UsageRecord') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'ownerId', 'provider', 'quantity', 'unit', 'source', 'confidence', 'observedAt'],
      ['costMicros', 'accountLabel', 'period', 'remaining', 'capturedAt', 'expiresAt', 'failure'],
      path
    )
    stringValue(item.id, `${path}.id`, 1, 256)
    stringValue(item.ownerId, `${path}.ownerId`, 1, 256)
    stringValue(item.provider, `${path}.provider`, 1, 128)
    stringValue(item.quantity, `${path}.quantity`, 1, 64)
    stringValue(item.unit, `${path}.unit`, 1, 64)
    if (item.costMicros !== undefined) stringValue(item.costMicros, `${path}.costMicros`, 1, 64)
    literal(
      item.source,
      ['official_api', 'harness_protocol', 'local_transcript_estimate'],
      `${path}.source`
    )
    literal(item.confidence, ['authoritative', 'measured', 'estimated'], `${path}.confidence`)
    if (item.accountLabel !== undefined)
      stringValue(item.accountLabel, `${path}.accountLabel`, 1, 256)
    if (item.period !== undefined) {
      const period = record(item.period, `${path}.period`)
      exactKeys(period, ['from', 'to'], [], `${path}.period`)
      timestamp(period.from, `${path}.period.from`)
      timestamp(period.to, `${path}.period.to`)
    }
    if (item.remaining !== undefined) stringValue(item.remaining, `${path}.remaining`, 1, 64)
    if (item.capturedAt !== undefined) timestamp(item.capturedAt, `${path}.capturedAt`)
    if (item.expiresAt !== undefined) timestamp(item.expiresAt, `${path}.expiresAt`)
    if (item.failure !== undefined) {
      const failure = record(item.failure, `${path}.failure`)
      exactKeys(failure, ['code', 'message'], [], `${path}.failure`)
      literal(failure.code, devErrorCodes, `${path}.failure.code`)
      stringValue(failure.message, `${path}.failure.message`, 1, 4096)
    }
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'RetainedDataRecord') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'ownerId', 'kind', 'byteLength', 'protected', 'observedAt'],
      ['expiresAt', 'scope', 'label'],
      path
    )
    stringValue(item.id, `${path}.id`, 1, 256)
    stringValue(item.ownerId, `${path}.ownerId`, 1, 256)
    literal(
      item.kind,
      ['terminal', 'checkpoint', 'screenshot', 'browser_profile', 'log', 'dependency_template'],
      `${path}.kind`
    )
    stringValue(item.byteLength, `${path}.byteLength`, 1, 40)
    if (typeof item.protected !== 'boolean') fail(`${path}.protected`, 'expected boolean')
    if (item.expiresAt !== undefined) timestamp(item.expiresAt, `${path}.expiresAt`)
    if (item.scope !== undefined) decodeScope(item.scope, `${path}.scope`)
    if (item.label !== undefined) stringValue(item.label, `${path}.label`, 1, 256)
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'ResourceSnapshot') {
    const item = record(value, path)
    exactKeys(item, ['processes', 'ports', 'metrics', 'retainedData', 'observedAt'], [], path)
    if (!Array.isArray(item.processes)) fail(`${path}.processes`, 'expected array')
    if (!Array.isArray(item.ports)) fail(`${path}.ports`, 'expected array')
    if (!Array.isArray(item.metrics)) fail(`${path}.metrics`, 'expected array')
    if (!Array.isArray(item.retainedData)) fail(`${path}.retainedData`, 'expected array')
    for (const [index, entry] of item.processes.entries())
      namedType('ProcessRecord', entry, `${path}.processes[${index}]`)
    for (const [index, entry] of item.ports.entries())
      namedType('PortRecord', entry, `${path}.ports[${index}]`)
    for (const [index, entry] of item.metrics.entries())
      namedType('ResourceMetric', entry, `${path}.metrics[${index}]`)
    for (const [index, entry] of item.retainedData.entries())
      namedType('RetainedDataRecord', entry, `${path}.retainedData[${index}]`)
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'CleanupPolicy') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'scope', 'projectId', 'version', 'state', 'predicates', 'allowedSteps'],
      ['approvedBy', 'approvedAt', 'expiresAt'],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.projectId, `${path}.projectId`, 1, 256)
    integerValue(item.version, `${path}.version`, 1)
    literal(item.state, ['draft', 'approved', 'disabled', 'expired', 'superseded'], `${path}.state`)
    if (!Array.isArray(item.predicates)) fail(`${path}.predicates`, 'expected array')
    for (const [index, entry] of item.predicates.entries())
      namedType('CleanupPredicate', entry, `${path}.predicates[${index}]`)
    if (!Array.isArray(item.allowedSteps)) fail(`${path}.allowedSteps`, 'expected array')
    for (const [index, entry] of item.allowedSteps.entries())
      namedType('CleanupStepKind', entry, `${path}.allowedSteps[${index}]`)
    if (item.approvedBy !== undefined) stringValue(item.approvedBy, `${path}.approvedBy`, 1, 256)
    if (item.approvedAt !== undefined) timestamp(item.approvedAt, `${path}.approvedAt`)
    if (item.expiresAt !== undefined) timestamp(item.expiresAt, `${path}.expiresAt`)
    return value
  }
  if (name === 'CleanupPolicyEvaluation') {
    const item = record(value, path)
    exactKeys(
      item,
      ['policyId', 'worktreeId', 'matched', 'facts', 'blockers', 'evaluatedAt', 'executesNothing'],
      [],
      path
    )
    stringValue(item.policyId, `${path}.policyId`, 1, 256)
    stringValue(item.worktreeId, `${path}.worktreeId`, 1, 256)
    if (typeof item.matched !== 'boolean') fail(`${path}.matched`, 'expected boolean')
    if (typeof item.facts !== 'object' || item.facts === null || Array.isArray(item.facts))
      fail(`${path}.facts`, 'expected record')
    for (const [key, entry] of Object.entries(item.facts))
      stringValue(entry, `${path}.facts.${key}`, 0, 256)
    if (!Array.isArray(item.blockers)) fail(`${path}.blockers`, 'expected array')
    for (const [index, entry] of item.blockers.entries())
      decodeCleanupBlocker(entry, `${path}.blockers[${index}]`)
    timestamp(item.evaluatedAt, `${path}.evaluatedAt`)
    if (item.executesNothing !== true)
      fail(`${path}.executesNothing`, 'evaluation must never execute')
    return value
  }
  if (name === 'MutationPlan') return decodeMutationPlan(value)
  if (name === 'CleanupBlocker') return decodeCleanupBlocker(value, path)
  if (name === "DeviceSession['kind']")
    return literal(value, ['responsive', 'ios_simulator', 'android_emulator', 'physical'], path)
  if (name === "ComputerUseLane['state']") return literal(value, computerUseLaneStates, path)
  if (name === 'DeviceGesture') {
    const item = record(value, path)
    const kind = literal(item.kind, ['tap', 'swipe', 'key', 'text'], `${path}.kind`)
    if (kind === 'tap') {
      exactKeys(item, ['kind', 'x', 'y'], [], path)
      finiteNumber(item.x, `${path}.x`, 0, 1)
      finiteNumber(item.y, `${path}.y`, 0, 1)
      return value
    }
    if (kind === 'swipe') {
      exactKeys(item, ['kind', 'fromX', 'fromY', 'toX', 'toY', 'durationMs'], [], path)
      for (const key of ['fromX', 'fromY', 'toX', 'toY'] as const)
        finiteNumber(item[key], `${path}.${key}`, 0, 1)
      integerValue(item.durationMs, `${path}.durationMs`, 10, 10_000)
      return value
    }
    if (kind === 'key') {
      exactKeys(item, ['kind', 'code', 'action'], [], path)
      stringValue(item.code, `${path}.code`, 1, 128)
      literal(item.action, ['down', 'up'], `${path}.action`)
      return value
    }
    exactKeys(item, ['kind', 'text'], [], path)
    stringValue(item.text, `${path}.text`, 0, 4096)
    return value
  }
  if (name === 'CleanupStepKind') return literal(value, cleanupSteps, path)
  if (name === 'LeaseOwnerKind')
    return literal(value, ['terminal', 'harness', 'browser', 'device', 'server', 'editor'], path)
  if (name === 'FileIdentity') {
    const item = record(value, path)
    exactKeys(item, ['mtimeNs', 'size'], ['device', 'inode', 'birthtimeNs', 'contentSha256'], path)
    for (const key of ['mtimeNs', 'size', 'device', 'inode', 'birthtimeNs'] as const)
      if (item[key] !== undefined) stringValue(item[key], `${path}.${key}`)
    if (
      item.contentSha256 !== undefined &&
      !sha256Pattern.test(stringValue(item.contentSha256, `${path}.contentSha256`))
    )
      fail(`${path}.contentSha256`, 'expected sha256')
    return value
  }
  if (name === 'WorkspacePath') {
    const item = record(value, path)
    exactKeys(item, ['worktreeId', 'rootIdentity', 'relativePath'], [], path)
    stringValue(item.worktreeId, `${path}.worktreeId`, 1)
    namedType('FileIdentity', item.rootIdentity, `${path}.rootIdentity`)
    const relative = stringValue(item.relativePath, `${path}.relativePath`, 1)
    if (relative !== '.') {
      // '.' is the canonical spelling of the worktree root itself; every
      // other path must be a normalized relative path.
      if (
        relative.includes('\0') ||
        relative.includes('\\') ||
        relative.startsWith('/') ||
        /^[A-Za-z]:/.test(relative) ||
        relative.split('/').some((part) => !part || part === '.' || part === '..')
      )
        fail(`${path}.relativePath`, 'expected normalized relative path')
    }
    return value
  }
  if (name === 'FileEntry') {
    const item = record(value, path)
    exactKeys(item, ['path', 'identity', 'kind', 'size', 'observedAt'], [], path)
    namedType('WorkspacePath', item.path, `${path}.path`)
    namedType('FileIdentity', item.identity, `${path}.identity`)
    literal(item.kind, ['file', 'directory', 'symlink', 'special'], `${path}.kind`)
    if (!uint64Pattern.test(stringValue(item.size, `${path}.size`)))
      fail(`${path}.size`, 'expected uint64 string')
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'FileReadResult') {
    const item = record(value, path)
    exactKeys(item, ['entry', 'offset', 'bytes', 'eof', 'eol', 'encoding'], [], path)
    namedType('FileEntry', item.entry, `${path}.entry`)
    if (!uint64Pattern.test(stringValue(item.offset, `${path}.offset`)))
      fail(`${path}.offset`, 'expected uint64 string')
    if (!(item.bytes instanceof Uint8Array)) fail(`${path}.bytes`, 'expected Uint8Array')
    if (typeof item.eof !== 'boolean') fail(`${path}.eof`, 'expected boolean')
    literal(item.eol, ['lf', 'crlf', 'mixed', 'none'], `${path}.eol`)
    literal(item.encoding, ['utf8', 'binary'], `${path}.encoding`)
    return value
  }
  if (name === 'FileWriteResult') {
    const item = record(value, path)
    exactKeys(item, ['entry', 'previousIdentity', 'atomic'], [], path)
    namedType('FileEntry', item.entry, `${path}.entry`)
    namedType('FileIdentity', item.previousIdentity, `${path}.previousIdentity`)
    if (item.atomic !== true) fail(`${path}.atomic`, 'expected true')
    return value
  }
  if (name === 'FileMutationResult') {
    const item = record(value, path)
    exactKeys(item, ['path', 'previousIdentity', 'state'], [], path)
    namedType('WorkspacePath', item.path, `${path}.path`)
    namedType('FileIdentity', item.previousIdentity, `${path}.previousIdentity`)
    literal(item.state, ['deleted'], `${path}.state`)
    return value
  }
  if (name === 'FileTreeMutationResult') {
    const item = record(value, path)
    exactKeys(item, ['path', 'state', 'items', 'totalBytes', 'observedAt'], [], path)
    namedType('WorkspacePath', item.path, `${path}.path`)
    literal(item.state, ['deleted', 'copied'], `${path}.state`)
    integerValue(item.items, `${path}.items`, 0)
    if (!uint64Pattern.test(stringValue(item.totalBytes, `${path}.totalBytes`)))
      fail(`${path}.totalBytes`, 'expected canonical uint64 string')
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'SearchMatch') {
    const item = record(value, path)
    exactKeys(item, ['path', 'identity', 'line', 'column', 'preview', 'ranges'], [], path)
    namedType('WorkspacePath', item.path, `${path}.path`)
    namedType('FileIdentity', item.identity, `${path}.identity`)
    integerValue(item.line, `${path}.line`, 1)
    integerValue(item.column, `${path}.column`, 1)
    stringValue(item.preview, `${path}.preview`, 0, 4096)
    if (!Array.isArray(item.ranges)) fail(`${path}.ranges`, 'expected array')
    item.ranges.forEach((entry: unknown, index: number) => {
      const rangePath = `${path}.ranges[${index}]`
      const range = record(entry, rangePath)
      exactKeys(range, ['start', 'end'], [], rangePath)
      const start = integerValue(range.start, `${rangePath}.start`, 0)
      const end = integerValue(range.end, `${rangePath}.end`, 0)
      if (end < start) fail(rangePath, 'range end must not precede start')
    })
    return value
  }
  if (name === 'ExternalOpenResult') {
    const item = record(value, path)
    exactKeys(item, ['accepted', 'path'], ['applicationLabel'], path)
    if (item.accepted !== true) fail(`${path}.accepted`, 'expected true')
    namedType('WorkspacePath', item.path, `${path}.path`)
    if (item.applicationLabel !== undefined)
      stringValue(item.applicationLabel, `${path}.applicationLabel`, 1, 128)
    return value
  }
  if (name === 'GitStatus') {
    const item = record(value, path)
    exactKeys(
      item,
      ['worktreeId', 'indexSha', 'entries', 'observedAt'],
      ['headRef', 'headSha'],
      path
    )
    stringValue(item.worktreeId, `${path}.worktreeId`, 1)
    if (item.headRef !== undefined) stringValue(item.headRef, `${path}.headRef`, 1, 512)
    if (item.headSha !== undefined) {
      if (!gitShaPattern.test(stringValue(item.headSha, `${path}.headSha`)))
        fail(`${path}.headSha`, 'expected git sha')
    }
    if (!sha256Pattern.test(stringValue(item.indexSha, `${path}.indexSha`)))
      fail(`${path}.indexSha`, 'expected sha256')
    timestamp(item.observedAt, `${path}.observedAt`)
    if (!Array.isArray(item.entries)) fail(`${path}.entries`, 'expected array')
    item.entries.forEach((entry: unknown, index: number) => {
      const entryPath = `${path}.entries[${index}]`
      const entryItem = record(entry, entryPath)
      exactKeys(entryItem, ['path', 'staged', 'unstaged', 'untracked'], [], entryPath)
      namedType('WorkspacePath', entryItem.path, `${entryPath}.path`)
      stringValue(entryItem.staged, `${entryPath}.staged`, 1, 8)
      stringValue(entryItem.unstaged, `${entryPath}.unstaged`, 1, 8)
      if (typeof entryItem.untracked !== 'boolean')
        fail(`${entryPath}.untracked`, 'expected boolean')
    })
    return value
  }
  if (name === 'GitCommit') {
    const item = record(value, path)
    exactKeys(item, ['sha', 'parents', 'authorName', 'authoredAt', 'subject'], ['body'], path)
    if (!gitShaPattern.test(stringValue(item.sha, `${path}.sha`)))
      fail(`${path}.sha`, 'expected git sha')
    if (!Array.isArray(item.parents)) fail(`${path}.parents`, 'expected array')
    item.parents.forEach((parent: unknown, index: number) => {
      if (!gitShaPattern.test(stringValue(parent, `${path}.parents[${index}]`)))
        fail(`${path}.parents[${index}]`, 'expected git sha')
    })
    stringValue(item.authorName, `${path}.authorName`, 1, 256)
    timestamp(item.authoredAt, `${path}.authoredAt`)
    stringValue(item.subject, `${path}.subject`, 1, 4096)
    if (item.body !== undefined) stringValue(item.body, `${path}.body`, 0, 65_536)
    return value
  }
  if (name === 'DiffHunk') {
    const item = record(value, path)
    exactKeys(
      item,
      ['path', 'oldStart', 'oldLines', 'newStart', 'newLines', 'lines'],
      ['oldPath'],
      path
    )
    namedType('WorkspacePath', item.path, `${path}.path`)
    if (item.oldPath !== undefined) namedType('WorkspacePath', item.oldPath, `${path}.oldPath`)
    integerValue(item.oldStart, `${path}.oldStart`, 0)
    integerValue(item.oldLines, `${path}.oldLines`, 0)
    integerValue(item.newStart, `${path}.newStart`, 0)
    integerValue(item.newLines, `${path}.newLines`, 0)
    if (!Array.isArray(item.lines)) fail(`${path}.lines`, 'expected array')
    item.lines.forEach((entry: unknown, index: number) => {
      const linePath = `${path}.lines[${index}]`
      const line = record(entry, linePath)
      exactKeys(line, ['kind', 'text'], [], linePath)
      literal(line.kind, ['context', 'add', 'delete'], `${linePath}.kind`)
      stringValue(line.text, `${linePath}.text`, 0, 65_536)
    })
    return value
  }
  if (name === 'GitFetchResult') {
    const item = record(value, path)
    exactKeys(item, ['remoteName', 'before', 'after', 'observedAt'], [], path)
    stringValue(item.remoteName, `${path}.remoteName`, 1, 256)
    for (const key of ['before', 'after'] as const) {
      const refs = record(item[key], `${path}.${key}`)
      for (const [ref, sha] of Object.entries(refs)) {
        stringValue(ref, `${path}.${key} ref`, 1, 512)
        if (!gitShaPattern.test(stringValue(sha, `${path}.${key}.${ref}`)))
          fail(`${path}.${key}.${ref}`, 'expected git sha')
      }
    }
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'GitCheckpoint') {
    const item = record(value, path)
    exactKeys(item, ['id', 'worktreeId', 'treeSha', 'createdAt'], ['baseSha', 'label'], path)
    stringValue(item.id, `${path}.id`, 1, 256)
    stringValue(item.worktreeId, `${path}.worktreeId`, 1)
    if (item.baseSha !== undefined) {
      if (!gitShaPattern.test(stringValue(item.baseSha, `${path}.baseSha`)))
        fail(`${path}.baseSha`, 'expected git sha')
    }
    if (!gitShaPattern.test(stringValue(item.treeSha, `${path}.treeSha`)))
      fail(`${path}.treeSha`, 'expected git sha')
    timestamp(item.createdAt, `${path}.createdAt`)
    if (item.label !== undefined) stringValue(item.label, `${path}.label`, 0, 128)
    return value
  }
  // #423 GitHub remote source-control DTOs. Strict shapes over untrusted
  // provider transport; unknowable provider facts stay absent.
  if (name === 'GitHubAccount') {
    const item = record(value, path)
    exactKeys(item, ['provider', 'host', 'login', 'observedAt'], ['name', 'profileUrl'], path)
    literal(item.provider, ['github'], `${path}.provider`)
    stringValue(item.host, `${path}.host`, 1, 253)
    stringValue(item.login, `${path}.login`, 1, 100)
    if (item.name !== undefined) stringValue(item.name, `${path}.name`, 0, 256)
    if (item.profileUrl !== undefined) stringValue(item.profileUrl, `${path}.profileUrl`, 1, 512)
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'GitHubRepository') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'repoId',
        'provider',
        'host',
        'owner',
        'name',
        'fullName',
        'defaultBranch',
        'url',
        'visibility',
        'fork',
        'freshness',
        'observedAt',
      ],
      [],
      path
    )
    stringValue(item.repoId, `${path}.repoId`, 1, 128)
    literal(item.provider, ['github'], `${path}.provider`)
    stringValue(item.host, `${path}.host`, 1, 253)
    stringValue(item.owner, `${path}.owner`, 1, 100)
    stringValue(item.name, `${path}.name`, 1, 100)
    stringValue(item.fullName, `${path}.fullName`, 1, 201)
    stringValue(item.defaultBranch, `${path}.defaultBranch`, 1, 256)
    stringValue(item.url, `${path}.url`, 1, 512)
    literal(item.visibility, ['public', 'private'], `${path}.visibility`)
    if (typeof item.fork !== 'boolean') fail(`${path}.fork`, 'expected boolean')
    literal(item.freshness, ['fresh', 'stale'], `${path}.freshness`)
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'GitHubAheadBehind') {
    const item = record(value, path)
    exactKeys(item, ['ahead', 'behind'], [], path)
    integerValue(item.ahead, `${path}.ahead`, 0)
    integerValue(item.behind, `${path}.behind`, 0)
    return value
  }
  if (name === 'GitHubPullRequest') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'id',
        'repoId',
        'number',
        'host',
        'owner',
        'repo',
        'title',
        'state',
        'draft',
        'headRef',
        'headSha',
        'baseRef',
        'baseSha',
        'url',
        'mergeable',
        'labels',
        'version',
        'updatedAt',
        'observedAt',
      ],
      ['body', 'authorLogin', 'reviewDecision', 'aheadBehind', 'reconciled'],
      path
    )
    if (!githubPullRequestIdPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected gh:<owner>/<repo>#<number>')
    stringValue(item.repoId, `${path}.repoId`, 1, 128)
    integerValue(item.number, `${path}.number`, 1)
    stringValue(item.host, `${path}.host`, 1, 253)
    stringValue(item.owner, `${path}.owner`, 1, 100)
    stringValue(item.repo, `${path}.repo`, 1, 100)
    stringValue(item.title, `${path}.title`, 0, 1024)
    if (item.body !== undefined) stringValue(item.body, `${path}.body`, 0, 65_536)
    literal(item.state, ['open', 'closed', 'merged'], `${path}.state`)
    if (typeof item.draft !== 'boolean') fail(`${path}.draft`, 'expected boolean')
    stringValue(item.headRef, `${path}.headRef`, 1, 512)
    if (!gitShaPattern.test(stringValue(item.headSha, `${path}.headSha`)))
      fail(`${path}.headSha`, 'expected git sha')
    stringValue(item.baseRef, `${path}.baseRef`, 1, 512)
    if (!gitShaPattern.test(stringValue(item.baseSha, `${path}.baseSha`)))
      fail(`${path}.baseSha`, 'expected git sha')
    if (item.authorLogin !== undefined) stringValue(item.authorLogin, `${path}.authorLogin`, 1, 100)
    stringValue(item.url, `${path}.url`, 1, 512)
    literal(item.mergeable, ['mergeable', 'conflicting', 'unknown'], `${path}.mergeable`)
    if (item.reviewDecision !== undefined)
      literal(
        item.reviewDecision,
        ['approved', 'changes_requested', 'review_required'],
        `${path}.reviewDecision`
      )
    if (item.aheadBehind !== undefined)
      namedType('GitHubAheadBehind', item.aheadBehind, `${path}.aheadBehind`)
    if (!Array.isArray(item.labels)) fail(`${path}.labels`, 'expected array')
    item.labels.forEach((label: unknown, index: number) =>
      stringValue(label, `${path}.labels[${index}]`, 0, 256)
    )
    integerValue(item.version, `${path}.version`, 0)
    timestamp(item.updatedAt, `${path}.updatedAt`)
    timestamp(item.observedAt, `${path}.observedAt`)
    if (item.reconciled !== undefined && typeof item.reconciled !== 'boolean')
      fail(`${path}.reconciled`, 'expected boolean')
    return value
  }
  if (name === 'GitHubCheck') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'name', 'status'],
      ['conclusion', 'detailsUrl', 'startedAt', 'completedAt'],
      path
    )
    stringValue(item.id, `${path}.id`, 1, 64)
    stringValue(item.name, `${path}.name`, 1, 256)
    literal(item.status, ['queued', 'in_progress', 'completed'], `${path}.status`)
    if (item.conclusion !== undefined)
      literal(
        item.conclusion,
        [
          'success',
          'failure',
          'neutral',
          'cancelled',
          'skipped',
          'timed_out',
          'action_required',
          'stale',
        ],
        `${path}.conclusion`
      )
    if (item.detailsUrl !== undefined) stringValue(item.detailsUrl, `${path}.detailsUrl`, 1, 512)
    if (item.startedAt !== undefined) timestamp(item.startedAt, `${path}.startedAt`)
    if (item.completedAt !== undefined) timestamp(item.completedAt, `${path}.completedAt`)
    return value
  }
  if (name === 'GitHubIssue') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'number', 'title', 'state', 'url', 'labels', 'updatedAt'],
      ['milestone'],
      path
    )
    if (!githubPullRequestIdPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected gh:<owner>/<repo>#<number>')
    integerValue(item.number, `${path}.number`, 1)
    stringValue(item.title, `${path}.title`, 0, 1024)
    literal(item.state, ['open', 'closed'], `${path}.state`)
    stringValue(item.url, `${path}.url`, 1, 512)
    if (!Array.isArray(item.labels)) fail(`${path}.labels`, 'expected array')
    item.labels.forEach((label: unknown, index: number) =>
      stringValue(label, `${path}.labels[${index}]`, 0, 256)
    )
    if (item.milestone !== undefined) stringValue(item.milestone, `${path}.milestone`, 0, 256)
    timestamp(item.updatedAt, `${path}.updatedAt`)
    return value
  }
  if (name === 'GitHubMilestone') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'number', 'title', 'state', 'openIssues', 'closedIssues', 'url'],
      ['dueOn'],
      path
    )
    if (!githubMilestoneIdPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected ghm:<owner>/<repo>#<number>')
    integerValue(item.number, `${path}.number`, 1)
    stringValue(item.title, `${path}.title`, 0, 512)
    literal(item.state, ['open', 'closed'], `${path}.state`)
    if (item.dueOn !== undefined) timestamp(item.dueOn, `${path}.dueOn`)
    integerValue(item.openIssues, `${path}.openIssues`, 0)
    integerValue(item.closedIssues, `${path}.closedIssues`, 0)
    stringValue(item.url, `${path}.url`, 1, 512)
    return value
  }
  if (name === 'GitPushResult') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'repoId',
        'worktreeId',
        'ref',
        'remoteName',
        'headSha',
        'remoteSha',
        'forced',
        'upstreamSet',
        'observedAt',
      ],
      [],
      path
    )
    stringValue(item.repoId, `${path}.repoId`, 1, 128)
    stringValue(item.worktreeId, `${path}.worktreeId`, 1, 256)
    stringValue(item.ref, `${path}.ref`, 1, 512)
    stringValue(item.remoteName, `${path}.remoteName`, 1, 256)
    if (!gitShaPattern.test(stringValue(item.headSha, `${path}.headSha`)))
      fail(`${path}.headSha`, 'expected git sha')
    if (!gitShaPattern.test(stringValue(item.remoteSha, `${path}.remoteSha`)))
      fail(`${path}.remoteSha`, 'expected git sha')
    for (const key of ['forced', 'upstreamSet'] as const)
      if (typeof item[key] !== 'boolean') fail(`${path}.${key}`, 'expected boolean')
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'GitUpdateBranchResult') {
    const item = record(value, path)
    exactKeys(
      item,
      ['pullRequestId', 'worktreeId', 'strategy', 'state', 'previousHeadSha', 'observedAt'],
      ['headSha', 'conflictedPaths', 'recovery'],
      path
    )
    if (!githubPullRequestIdPattern.test(stringValue(item.pullRequestId, `${path}.pullRequestId`)))
      fail(`${path}.pullRequestId`, 'expected gh:<owner>/<repo>#<number>')
    stringValue(item.worktreeId, `${path}.worktreeId`, 1, 256)
    literal(item.strategy, ['merge'], `${path}.strategy`)
    literal(item.state, ['merged', 'conflicted', 'up_to_date'], `${path}.state`)
    if (!gitShaPattern.test(stringValue(item.previousHeadSha, `${path}.previousHeadSha`)))
      fail(`${path}.previousHeadSha`, 'expected git sha')
    if (item.headSha !== undefined) {
      if (!gitShaPattern.test(stringValue(item.headSha, `${path}.headSha`)))
        fail(`${path}.headSha`, 'expected git sha')
    }
    if (item.conflictedPaths !== undefined) {
      if (!Array.isArray(item.conflictedPaths)) fail(`${path}.conflictedPaths`, 'expected array')
      item.conflictedPaths.forEach((entry: unknown, index: number) =>
        stringValue(entry, `${path}.conflictedPaths[${index}]`, 1, 4096)
      )
    }
    if (item.recovery !== undefined) {
      const recovery = record(item.recovery, `${path}.recovery`)
      exactKeys(recovery, ['abort', 'continue'], [], `${path}.recovery`)
      stringValue(recovery.abort, `${path}.recovery.abort`, 1, 256)
      stringValue(recovery.continue, `${path}.recovery.continue`, 1, 256)
    }
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'BrowserAnnotationInput') {
    const item = record(value, path)
    const kind = literal(item.kind, ['point', 'rect', 'text'], `${path}.kind`)
    exactKeys(item, ['targetId', 'kind', 'x', 'y'], ['width', 'height', 'text'], path)
    stringValue(item.targetId, `${path}.targetId`, 1)
    finiteNumber(item.x, `${path}.x`, 0, 1)
    finiteNumber(item.y, `${path}.y`, 0, 1)
    if (item.width !== undefined) finiteNumber(item.width, `${path}.width`, 0, 1)
    if (item.height !== undefined) finiteNumber(item.height, `${path}.height`, 0, 1)
    if (item.text !== undefined) stringValue(item.text, `${path}.text`, 0, 4096)
    if (kind === 'rect' && (item.width === undefined || item.height === undefined))
      fail(path, 'rect annotation requires width and height')
    if (kind === 'text' && item.text === undefined) fail(path, 'text annotation requires text')
    return value
  }
  if (name === 'CleanupPredicate') {
    const item = record(value, path)
    const kind = literal(
      item.kind,
      [
        'clean',
        'pushed',
        'pull_request_merged',
        'no_active_leases',
        'no_active_owned_resources',
        'archived_for',
      ],
      `${path}.kind`
    )
    exactKeys(item, ['kind'], kind === 'archived_for' ? ['seconds'] : [], path)
    if (kind === 'archived_for') integerValue(item.seconds, `${path}.seconds`, 0)
    return value
  }
  if (name === 'RedactedRemoteInput') {
    const item = record(value, path)
    exactKeys(item, ['provider', 'host', 'ownerPath', 'repository'], [], path)
    literal(item.provider, ['github', 'gitlab', 'other'], `${path}.provider`)
    for (const key of ['host', 'ownerPath', 'repository'] as const)
      stringValue(item[key], `${path}.${key}`, 1)
    return value
  }
  if (name === 'ProjectMutableFields') {
    const item = record(value, path)
    exactKeys(
      item,
      [],
      [
        'name',
        'groupIds',
        'preferredRuntimeNodeId',
        'defaultBaseRef',
        'bootstrapWorkflowId',
        'defaultHarnessId',
      ],
      path
    )
    if (item.name !== undefined) stringValue(item.name, `${path}.name`, 1, 128)
    if (item.groupIds !== undefined) validateType('string[]<=32', item.groupIds, `${path}.groupIds`)
    for (const key of [
      'preferredRuntimeNodeId',
      'defaultBaseRef',
      'bootstrapWorkflowId',
      'defaultHarnessId',
    ] as const)
      if (item[key] !== undefined) stringValue(item[key], `${path}.${key}`, 1)
    return value
  }
  if (name === 'GroupMutableFields') {
    const item = record(value, path)
    exactKeys(item, [], ['name', 'colorToken', 'sortKey'], path)
    if (item.name !== undefined) stringValue(item.name, `${path}.name`, 1, 128)
    if (item.colorToken !== undefined) stringValue(item.colorToken, `${path}.colorToken`, 1, 64)
    if (item.sortKey !== undefined) stringValue(item.sortKey, `${path}.sortKey`, 1, 64)
    return value
  }
  if (name === 'GitHubPullRequestMutableFields') {
    const item = record(value, path)
    exactKeys(item, [], ['title', 'body', 'draft', 'baseRef'], path)
    if (item.title !== undefined) stringValue(item.title, `${path}.title`, 0, 256)
    if (item.body !== undefined) stringValue(item.body, `${path}.body`, 0, 65_536)
    if (item.draft !== undefined && typeof item.draft !== 'boolean')
      fail(`${path}.draft`, 'expected boolean')
    if (item.baseRef !== undefined) stringValue(item.baseRef, `${path}.baseRef`, 1)
    return value
  }
  if (name === 'RootBookmark') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'id',
        'scope',
        'label',
        'kind',
        'canonicalRoot',
        'rootIdentity',
        'state',
        'generation',
        'version',
      ],
      [],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.label, `${path}.label`, 1, 128)
    literal(item.kind, ['directory', 'repository'], `${path}.kind`)
    const canonicalRoot = stringValue(item.canonicalRoot, `${path}.canonicalRoot`, 1, 4096)
    if (canonicalRoot.includes('\0')) fail(`${path}.canonicalRoot`, 'expected path without NUL')
    namedType('FileIdentity', item.rootIdentity, `${path}.rootIdentity`)
    literal(item.state, ['active', 'stale', 'revoked'], `${path}.state`)
    integerValue(item.generation, `${path}.generation`, 0)
    integerValue(item.version, `${path}.version`, 1)
    return value
  }
  if (name === 'CredentialRef') {
    const item = record(value, path)
    exactKeys(item, ['id', 'scope', 'label', 'host', 'kind', 'state', 'version'], [], path)
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.label, `${path}.label`, 1, 128)
    stringValue(item.host, `${path}.host`, 1, 253)
    literal(item.kind, ['git_https', 'github_token', 'ssh_key', 'other'], `${path}.kind`)
    literal(item.state, ['ready', 'expired', 'revoked', 'unknown'], `${path}.state`)
    integerValue(item.version, `${path}.version`, 1)
    return value
  }
  if (name === 'HarnessModel') {
    const item = record(value, path)
    exactKeys(item, ['id', 'displayName', 'capabilities'], [], path)
    stringValue(item.id, `${path}.id`, 1, 256)
    stringValue(item.displayName, `${path}.displayName`, 1, 256)
    validateType('string[]<=1000', item.capabilities, `${path}.capabilities`)
    for (const capability of item.capabilities as readonly unknown[])
      stringValue(capability, `${path}.capabilities[]`, 1, 128)
    return value
  }
  if (name === 'HarnessInstallation') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'id',
        'scope',
        'executableIdentity',
        'executableLabel',
        'protocol',
        'auth',
        'health',
        'capabilities',
        'models',
        'observedAt',
        'generation',
      ],
      ['version'],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.executableIdentity, `${path}.executableIdentity`, 1, 4096)
    stringValue(item.executableLabel, `${path}.executableLabel`, 1, 256)
    literal(item.protocol, ['native', 'acp', 'pty'], `${path}.protocol`)
    if (item.version !== undefined) stringValue(item.version, `${path}.version`, 1, 128)
    literal(item.auth, ['ready', 'required', 'expired', 'unknown'], `${path}.auth`)
    literal(item.health, ['healthy', 'degraded', 'unhealthy', 'unknown'], `${path}.health`)
    validateType('string[]<=64', item.capabilities, `${path}.capabilities`)
    for (const capability of item.capabilities as readonly unknown[])
      stringValue(capability, `${path}.capabilities[]`, 1, 128)
    validateType('HarnessModel[]<=1000', item.models, `${path}.models`)
    timestamp(item.observedAt, `${path}.observedAt`)
    integerValue(item.generation, `${path}.generation`, 0)
    return value
  }
  if (name === 'RuntimeConnectionInventoryEntry') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'id',
        'scope',
        'family',
        'displayName',
        'driverId',
        'driverVersion',
        'provenance',
        'executableIdentity',
        'executableLabel',
        'protocol',
        'acpAvailability',
        'auth',
        'health',
        'capabilities',
        'sessionOperations',
        'entitlementHints',
        'limitations',
        'eligibility',
        'transport',
        'models',
        'observedAt',
        'generation',
      ],
      ['acpVersion', 'version'],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.family, `${path}.family`, 1, 128)
    stringValue(item.displayName, `${path}.displayName`, 1, 128)
    stringValue(item.driverId, `${path}.driverId`, 1, 128)
    stringValue(item.driverVersion, `${path}.driverVersion`, 1, 64)
    literal(item.provenance, ['user_managed', 'managed'], `${path}.provenance`)
    stringValue(item.executableIdentity, `${path}.executableIdentity`, 1, 4096)
    stringValue(item.executableLabel, `${path}.executableLabel`, 1, 256)
    literal(item.protocol, ['native', 'acp', 'pty'], `${path}.protocol`)
    literal(
      item.acpAvailability,
      ['available', 'adapter_required', 'unavailable'],
      `${path}.acpAvailability`
    )
    if (item.acpVersion !== undefined) stringValue(item.acpVersion, `${path}.acpVersion`, 1, 128)
    if (item.version !== undefined) stringValue(item.version, `${path}.version`, 1, 128)
    literal(item.auth, ['ready', 'required', 'expired', 'unknown'], `${path}.auth`)
    literal(item.health, ['healthy', 'degraded', 'unhealthy', 'unknown'], `${path}.health`)
    validateType('string[]<=64', item.capabilities, `${path}.capabilities`)
    for (const capability of item.capabilities as readonly unknown[])
      stringValue(capability, `${path}.capabilities[]`, 1, 128)
    validateType('string[]<=32', item.sessionOperations, `${path}.sessionOperations`)
    for (const operation of item.sessionOperations as readonly unknown[])
      stringValue(operation, `${path}.sessionOperations[]`, 1, 128)
    validateType('string[]<=32', item.entitlementHints, `${path}.entitlementHints`)
    for (const hint of item.entitlementHints as readonly unknown[])
      stringValue(hint, `${path}.entitlementHints[]`, 1, 128)
    validateType('string[]<=32', item.limitations, `${path}.limitations`)
    for (const limitation of item.limitations as readonly unknown[])
      stringValue(limitation, `${path}.limitations[]`, 1, 256)
    const eligibility = record(item.eligibility, `${path}.eligibility`)
    exactKeys(eligibility, ['eligible', 'blockers'], [], `${path}.eligibility`)
    if (typeof eligibility.eligible !== 'boolean')
      fail(`${path}.eligibility.eligible`, 'expected boolean')
    if (!Array.isArray(eligibility.blockers)) fail(`${path}.eligibility.blockers`, 'expected array')
    if (eligibility.blockers.length > 32) fail(`${path}.eligibility.blockers`, 'array exceeds 32')
    eligibility.blockers.forEach((blocker, index) => {
      const blockerRecord = record(blocker, `${path}.eligibility.blockers[${index}]`)
      exactKeys(blockerRecord, ['code', 'message'], [], `${path}.eligibility.blockers[${index}]`)
      literal(blockerRecord.code, devErrorCodes, `${path}.eligibility.blockers[${index}].code`)
      stringValue(blockerRecord.message, `${path}.eligibility.blockers[${index}].message`, 1, 512)
    })
    literal(item.transport, ['direct_local', 'remote_gateway'], `${path}.transport`)
    validateType('HarnessModel[]<=1000', item.models, `${path}.models`)
    timestamp(item.observedAt, `${path}.observedAt`)
    integerValue(item.generation, `${path}.generation`, 0)
    return value
  }
  // #31/#32 harness substrate DTOs.
  if (name === 'AgentProfileRef') {
    const item = record(value, path)
    exactKeys(item, ['id', 'version', 'displayName', 'capabilityPolicyVersion'], [], path)
    stringValue(item.id, `${path}.id`, 1, 256)
    integerValue(item.version, `${path}.version`, 1)
    stringValue(item.displayName, `${path}.displayName`, 1, 256)
    integerValue(item.capabilityPolicyVersion, `${path}.capabilityPolicyVersion`, 1)
    return value
  }
  if (name === 'HarnessRun') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'id',
        'scope',
        'runtimeSessionId',
        'installationId',
        'agentProfile',
        'state',
        'generation',
        'version',
      ],
      ['modelId', 'startedAt', 'finishedAt', 'terminalId', 'terminalGeneration'],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.runtimeSessionId, `${path}.runtimeSessionId`, 1, 256)
    stringValue(item.installationId, `${path}.installationId`, 1, 256)
    namedType('AgentProfileRef', item.agentProfile, `${path}.agentProfile`)
    if (item.modelId !== undefined) stringValue(item.modelId, `${path}.modelId`, 1, 256)
    if (item.terminalId !== undefined) stringValue(item.terminalId, `${path}.terminalId`, 1, 256)
    if (item.terminalGeneration !== undefined)
      integerValue(item.terminalGeneration, `${path}.terminalGeneration`, 1)
    literal(
      item.state,
      [
        'resolving',
        'starting',
        'working',
        'awaiting_input',
        'awaiting_approval',
        'completed',
        'failed',
        'cancelled',
        'disconnected',
        'unknown',
      ],
      `${path}.state`
    )
    integerValue(item.generation, `${path}.generation`, 1)
    if (item.startedAt !== undefined) timestamp(item.startedAt, `${path}.startedAt`)
    if (item.finishedAt !== undefined) timestamp(item.finishedAt, `${path}.finishedAt`)
    integerValue(item.version, `${path}.version`, 1)
    return value
  }
  if (name === 'ManagedPiStatus') {
    const item = record(value, path)
    exactKeys(
      item,
      ['scope', 'driverId', 'driverVersion', 'pinnedVersion', 'state', 'observedAt', 'generation'],
      [
        'installationId',
        'resolvedVersion',
        'executableIdentity',
        'executableLabel',
        'lastErrorCode',
        'lastError',
      ],
      path
    )
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.driverId, `${path}.driverId`, 1, 128)
    stringValue(item.driverVersion, `${path}.driverVersion`, 1, 64)
    stringValue(item.pinnedVersion, `${path}.pinnedVersion`, 1, 128)
    literal(item.state, ['absent', 'resolving', 'installing', 'ready', 'failed'], `${path}.state`)
    if (item.installationId !== undefined)
      if (!uuidPattern.test(stringValue(item.installationId, `${path}.installationId`)))
        fail(`${path}.installationId`, 'expected lowercase UUID')
    if (item.resolvedVersion !== undefined)
      stringValue(item.resolvedVersion, `${path}.resolvedVersion`, 1, 128)
    if (item.executableIdentity !== undefined)
      stringValue(item.executableIdentity, `${path}.executableIdentity`, 1, 4096)
    if (item.executableLabel !== undefined)
      stringValue(item.executableLabel, `${path}.executableLabel`, 1, 256)
    if (item.lastErrorCode !== undefined)
      literal(item.lastErrorCode, devErrorCodes, `${path}.lastErrorCode`)
    if (item.lastError !== undefined) stringValue(item.lastError, `${path}.lastError`, 1, 512)
    timestamp(item.observedAt, `${path}.observedAt`)
    integerValue(item.generation, `${path}.generation`, 0)
    return value
  }
  if (name === 'AcpConnection') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'id',
        'scope',
        'runtimeSessionId',
        'harnessInstallationId',
        'driverId',
        'driverVersion',
        'negotiatedProtocolVersion',
        'requiredCapabilities',
        'negotiatedCapabilities',
        'missingRequiredCapabilities',
        'sessionOperations',
        'limitations',
        'history',
        'state',
        'observedAt',
        'generation',
      ],
      ['closeReason'],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.runtimeSessionId, `${path}.runtimeSessionId`, 1, 256)
    stringValue(item.harnessInstallationId, `${path}.harnessInstallationId`, 1, 256)
    stringValue(item.driverId, `${path}.driverId`, 1, 128)
    stringValue(item.driverVersion, `${path}.driverVersion`, 1, 64)
    stringValue(item.negotiatedProtocolVersion, `${path}.negotiatedProtocolVersion`, 1, 32)
    validateType('string[]<=32', item.requiredCapabilities, `${path}.requiredCapabilities`)
    validateType('string[]<=64', item.negotiatedCapabilities, `${path}.negotiatedCapabilities`)
    validateType(
      'string[]<=32',
      item.missingRequiredCapabilities,
      `${path}.missingRequiredCapabilities`
    )
    validateType('string[]<=32', item.sessionOperations, `${path}.sessionOperations`)
    validateType('string[]<=32', item.limitations, `${path}.limitations`)
    literal(item.history, ['available', 'unavailable'], `${path}.history`)
    literal(
      item.state,
      ['connecting', 'ready', 'disconnected', 'closed', 'failed'],
      `${path}.state`
    )
    if (item.closeReason !== undefined) stringValue(item.closeReason, `${path}.closeReason`, 1, 512)
    timestamp(item.observedAt, `${path}.observedAt`)
    integerValue(item.generation, `${path}.generation`, 0)
    return value
  }
  if (name === 'TerminalRecord') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'id',
        'scope',
        'runtimeSessionId',
        'worktreeId',
        'sidecarId',
        'processRecordId',
        'state',
        'health',
        'lastSeq',
        'generation',
      ],
      [],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    if (!uuidPattern.test(stringValue(item.runtimeSessionId, `${path}.runtimeSessionId`)))
      fail(`${path}.runtimeSessionId`, 'expected lowercase UUID')
    if (!uuidPattern.test(stringValue(item.worktreeId, `${path}.worktreeId`)))
      fail(`${path}.worktreeId`, 'expected lowercase UUID')
    stringValue(item.sidecarId, `${path}.sidecarId`, 1, 128)
    stringValue(item.processRecordId, `${path}.processRecordId`, 1, 128)
    literal(
      item.state,
      ['creating', 'running', 'detached', 'terminating', 'exited'],
      `${path}.state`
    )
    literal(item.health, ['healthy', 'degraded', 'replay_required', 'faulted'], `${path}.health`)
    uint64String(item.lastSeq, `${path}.lastSeq`)
    integerValue(item.generation, `${path}.generation`, 0)
    return value
  }
  if (name === 'TerminalCheckpoint') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'id',
        'terminalId',
        'generation',
        'throughSequence',
        'segmentSha256',
        'byteLength',
        'createdAt',
      ],
      [],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    if (!uuidPattern.test(stringValue(item.terminalId, `${path}.terminalId`)))
      fail(`${path}.terminalId`, 'expected lowercase UUID')
    integerValue(item.generation, `${path}.generation`, 0)
    uint64String(item.throughSequence, `${path}.throughSequence`)
    if (!sha256Pattern.test(stringValue(item.segmentSha256, `${path}.segmentSha256`)))
      fail(`${path}.segmentSha256`, 'expected sha256')
    uint64String(item.byteLength, `${path}.byteLength`)
    timestamp(item.createdAt, `${path}.createdAt`)
    return value
  }
  if (name === 'TerminalSearchMatch') {
    const item = record(value, path)
    exactKeys(item, ['terminalId', 'generation', 'sequence', 'byteOffset', 'preview'], [], path)
    if (!uuidPattern.test(stringValue(item.terminalId, `${path}.terminalId`)))
      fail(`${path}.terminalId`, 'expected lowercase UUID')
    integerValue(item.generation, `${path}.generation`, 0)
    uint64String(item.sequence, `${path}.sequence`)
    uint64String(item.byteOffset, `${path}.byteOffset`)
    stringValue(item.preview, `${path}.preview`, 0, 256)
    return value
  }
  if (name === 'ShellProfile') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'scope', 'label', 'argv', 'envAllowlistKeys', 'builtin', 'version'],
      [],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.label, `${path}.label`, 1, 128)
    validateType('string[]<=16', item.argv, `${path}.argv`)
    if ((item.argv as string[]).length === 0) fail(`${path}.argv`, 'argv must not be empty')
    validateType('string[]<=64', item.envAllowlistKeys, `${path}.envAllowlistKeys`)
    if (typeof item.builtin !== 'boolean') fail(`${path}.builtin`, 'expected boolean')
    integerValue(item.version, `${path}.version`, 1)
    return value
  }
  // #398 project registry DTOs. Shapes mirror the spec's project registry
  // model; the registry bodies and replies validate through here.
  if (name === 'Group') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'scope', 'name', 'projectIds', 'sortKey', 'version'],
      ['colorToken'],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.name, `${path}.name`, 1, 128)
    if (item.colorToken !== undefined) stringValue(item.colorToken, `${path}.colorToken`, 1, 64)
    validateType('string[]<=10000', item.projectIds, `${path}.projectIds`)
    stringValue(item.sortKey, `${path}.sortKey`, 1, 64)
    integerValue(item.version, `${path}.version`, 1)
    return value
  }
  if (name === 'GroupMutableFields') {
    const item = record(value, path)
    exactKeys(item, [], ['name', 'colorToken'], path)
    if (item.name !== undefined) stringValue(item.name, `${path}.name`, 1, 128)
    if (item.colorToken !== undefined) stringValue(item.colorToken, `${path}.colorToken`, 1, 64)
    return value
  }
  if (name === 'Project') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'scope', 'name', 'groupIds', 'repoIds', 'lifecycle', 'version'],
      [
        'repos',
        'preferredRuntimeNodeId',
        'defaultBaseRef',
        'bootstrapWorkflowId',
        'defaultHarnessId',
      ],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.name, `${path}.name`, 1, 128)
    validateType('string[]<=32', item.groupIds, `${path}.groupIds`)
    validateType('string[]<=128', item.repoIds, `${path}.repoIds`)
    if (item.repos !== undefined) {
      if (!Array.isArray(item.repos)) fail(`${path}.repos`, 'expected array')
      if ((item.repos as unknown[]).length > 128) fail(`${path}.repos`, 'array exceeds 128')
      ;(item.repos as unknown[]).forEach((entry, index) =>
        namedType('ProjectRepoBinding', entry, `${path}.repos[${index}]`)
      )
    }
    if (item.preferredRuntimeNodeId !== undefined)
      stringValue(item.preferredRuntimeNodeId, `${path}.preferredRuntimeNodeId`, 1, 256)
    if (item.defaultBaseRef !== undefined)
      stringValue(item.defaultBaseRef, `${path}.defaultBaseRef`, 1, 256)
    if (item.bootstrapWorkflowId !== undefined)
      stringValue(item.bootstrapWorkflowId, `${path}.bootstrapWorkflowId`, 1, 256)
    if (item.defaultHarnessId !== undefined)
      stringValue(item.defaultHarnessId, `${path}.defaultHarnessId`, 1, 256)
    literal(
      item.lifecycle,
      ['importing', 'cloning', 'scanning', 'ready', 'archived', 'failed'],
      `${path}.lifecycle`
    )
    integerValue(item.version, `${path}.version`, 1)
    return value
  }
  if (name === 'ProjectRepoBinding') {
    const item = record(value, path)
    exactKeys(item, ['repoId', 'rootBookmarkId', 'canonicalRoot'], [], path)
    if (!uuidPattern.test(stringValue(item.repoId, `${path}.repoId`)))
      fail(`${path}.repoId`, 'expected lowercase UUID')
    if (!uuidPattern.test(stringValue(item.rootBookmarkId, `${path}.rootBookmarkId`)))
      fail(`${path}.rootBookmarkId`, 'expected lowercase UUID')
    stringValue(item.canonicalRoot, `${path}.canonicalRoot`, 1, 4096)
    return value
  }
  // Repository registry DTOs (#398 follow-up). `host` is a proven remote
  // host (never empty when the remote is present); `ownerPath`/`displayUrl`
  // may legitimately be empty for pathless or unparseable remotes.
  if (name === 'RedactedRemote') {
    const item = record(value, path)
    exactKeys(item, ['provider', 'host', 'ownerPath', 'displayUrl'], [], path)
    literal(item.provider, ['github', 'gitlab', 'other'], `${path}.provider`)
    stringValue(item.host, `${path}.host`, 1, 253)
    stringValue(item.ownerPath, `${path}.ownerPath`, 0, 1024)
    stringValue(item.displayUrl, `${path}.displayUrl`, 0, 2048)
    return value
  }
  if (name === 'Repo') {
    const item = record(value, path)
    exactKeys(
      item,
      ['id', 'scope', 'kind', 'lifecycle', 'canonicalRoot', 'projectIds', 'version'],
      ['gitCommonDirIdentity', 'remote', 'defaultRef'],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    literal(item.kind, ['git', 'folder'], `${path}.kind`)
    literal(
      item.lifecycle,
      ['authorizing', 'ready', 'unavailable', 'stale', 'refreshing'],
      `${path}.lifecycle`
    )
    const canonicalRoot = stringValue(item.canonicalRoot, `${path}.canonicalRoot`, 1, 4096)
    if (canonicalRoot.includes('\0')) fail(`${path}.canonicalRoot`, 'expected path without NUL')
    if (item.gitCommonDirIdentity !== undefined)
      namedType('FileIdentity', item.gitCommonDirIdentity, `${path}.gitCommonDirIdentity`)
    if (item.remote !== undefined) namedType('RedactedRemote', item.remote, `${path}.remote`)
    if (item.defaultRef !== undefined) stringValue(item.defaultRef, `${path}.defaultRef`, 1, 256)
    validateType('string[]<=128', item.projectIds, `${path}.projectIds`)
    integerValue(item.version, `${path}.version`, 1)
    return value
  }
  if (name === 'RepoInspection') {
    const item = record(value, path)
    exactKeys(item, ['repo', 'rootIdentity', 'dirty', 'observedAt'], ['headRef', 'headSha'], path)
    namedType('Repo', item.repo, `${path}.repo`)
    namedType('FileIdentity', item.rootIdentity, `${path}.rootIdentity`)
    if (item.headRef !== undefined) stringValue(item.headRef, `${path}.headRef`, 1, 256)
    if (item.headSha !== undefined) {
      if (!gitShaPattern.test(stringValue(item.headSha, `${path}.headSha`)))
        fail(`${path}.headSha`, 'expected git sha')
    }
    if (typeof item.dirty !== 'boolean') fail(`${path}.dirty`, 'expected boolean')
    timestamp(item.observedAt, `${path}.observedAt`)
    return value
  }
  if (name === 'ProjectScanEntry') {
    const item = record(value, path)
    exactKeys(
      item,
      [
        'name',
        'relativeDir',
        'manifestPath',
        'packageManager',
        'languages',
        'suggestedScripts',
        'diagnostics',
      ],
      [],
      path
    )
    stringValue(item.name, `${path}.name`, 1, 256)
    stringValue(item.relativeDir, `${path}.relativeDir`, 0, 1024)
    stringValue(item.manifestPath, `${path}.manifestPath`, 1, 1024)
    literal(
      item.packageManager,
      ['npm', 'pnpm', 'yarn', 'bun', 'cargo', 'pip', 'poetry', 'uv', 'unknown'],
      `${path}.packageManager`
    )
    validateType('string[]<=32', item.languages, `${path}.languages`)
    validateType('string[]<=64', item.suggestedScripts, `${path}.suggestedScripts`)
    validateType('string[]<=32', item.diagnostics, `${path}.diagnostics`)
    return value
  }
  if (name === 'ProjectScanPage') {
    const item = record(value, path)
    exactKeys(
      item,
      ['rootBookmarkId', 'items', 'partial', 'diagnostics', 'observedAt'],
      ['nextCursor'],
      path
    )
    if (!uuidPattern.test(stringValue(item.rootBookmarkId, `${path}.rootBookmarkId`)))
      fail(`${path}.rootBookmarkId`, 'expected lowercase UUID')
    if (!Array.isArray(item.items)) fail(`${path}.items`, 'expected array')
    if ((item.items as unknown[]).length > 500) fail(`${path}.items`, 'page exceeds 500 items')
    ;(item.items as unknown[]).forEach((entry, index) =>
      namedType('ProjectScanEntry', entry, `${path}.items[${index}]`)
    )
    if (typeof item.partial !== 'boolean') fail(`${path}.partial`, 'expected boolean')
    validateType('string[]<=32', item.diagnostics, `${path}.diagnostics`)
    timestamp(item.observedAt, `${path}.observedAt`)
    if (item.nextCursor !== undefined) stringValue(item.nextCursor, `${path}.nextCursor`, 1, 512)
    return value
  }
  // #400 harness preference DTOs. A preference is a user-expressed overlay on
  // the root-default projection; the mutable-fields patch never carries
  // credential values because none exist in the model.
  if (name === 'HarnessPreference') {
    const item = record(value, path)
    exactKeys(
      item,
      ['scope', 'harnessInstallationId', 'enabled', 'sortKey', 'default', 'version'],
      ['projectId', 'agentProfileId', 'modelId'],
      path
    )
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.harnessInstallationId, `${path}.harnessInstallationId`, 1, 256)
    if (typeof item.enabled !== 'boolean') fail(`${path}.enabled`, 'expected boolean')
    stringValue(item.sortKey, `${path}.sortKey`, 1, 64)
    if (typeof item.default !== 'boolean') fail(`${path}.default`, 'expected boolean')
    if (item.projectId !== undefined) stringValue(item.projectId, `${path}.projectId`, 1, 256)
    if (item.agentProfileId !== undefined)
      stringValue(item.agentProfileId, `${path}.agentProfileId`, 1, 128)
    if (item.modelId !== undefined) stringValue(item.modelId, `${path}.modelId`, 1, 256)
    integerValue(item.version, `${path}.version`, 1)
    return value
  }
  if (name === 'HarnessPreferenceMutableFields') {
    const item = record(value, path)
    exactKeys(item, [], ['enabled', 'default', 'sortKey', 'agentProfileId', 'modelId'], path)
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean')
      fail(`${path}.enabled`, 'expected boolean')
    if (item.default !== undefined && typeof item.default !== 'boolean')
      fail(`${path}.default`, 'expected boolean')
    if (item.sortKey !== undefined) stringValue(item.sortKey, `${path}.sortKey`, 1, 64)
    if (item.agentProfileId !== undefined)
      stringValue(item.agentProfileId, `${path}.agentProfileId`, 1, 128)
    if (item.modelId !== undefined) stringValue(item.modelId, `${path}.modelId`, 1, 256)
    return value
  }
  fail(path, `unknown named type ${name}`)
}

function literal(value: unknown, allowed: readonly unknown[], path: string): unknown {
  if (!allowed.includes(value)) fail(path, `expected ${allowed.map(String).join('|')}`)
  return value
}

function validateObjectType(type: string, value: unknown, path: string) {
  const item = record(value, path)
  const fields = splitTopLevel(type.slice(1, -1), ';')
  const required: string[] = []
  const optional: string[] = []
  const definitions = fields.map((field) => {
    const [rawName, ...rawType] = splitTopLevel(field, ':')
    if (!rawName || rawType.length === 0) fail(path, `invalid contract field ${field}`)
    const isOptional = rawName.endsWith('?')
    const name = isOptional ? rawName.slice(0, -1) : rawName
    ;(isOptional ? optional : required).push(name)
    return { name, optional: isOptional, type: rawType.join(':').trim() }
  })
  exactKeys(item, required, optional, path)
  for (const definition of definitions) {
    if (definition.optional && item[definition.name] === undefined) continue
    validateType(definition.type, item[definition.name], `${path}.${definition.name}`)
  }
  return value
}

function validateType(type: string, value: unknown, path: string): unknown {
  const union = splitTopLevel(type, '|')
  if (union.length > 1) {
    for (const candidate of union) {
      try {
        return validateType(candidate, value, path)
      } catch {}
    }
    fail(path, `does not match ${type}`)
  }
  const trimmed = type.trim()
  const quoted = trimmed.match(/^'([^']*)'$/)
  if (quoted) return literal(value, [quoted[1]], path)
  if (trimmed === 'true') return literal(value, [true], path)
  if (trimmed.startsWith('{') && trimmed.endsWith('}'))
    return validateObjectType(trimmed, value, path)

  const array = trimmed.match(/^(.*)\[\](?:<=(\d+))?$/)
  if (array) {
    if (!Array.isArray(value)) fail(path, 'expected array')
    const max = array[2] === undefined ? Number.POSITIVE_INFINITY : Number(array[2])
    if (value.length > max) fail(path, `array exceeds ${max}`)
    value.forEach((entry, index) => validateType(array[1]!, entry, `${path}[${index}]`))
    return value
  }

  const constrained = trimmed.match(/^(string|integer|number)\(([-\d.]+)\.\.([-\d.]+)\)$/)
  if (constrained) {
    const min = Number(constrained[2])
    const max = Number(constrained[3])
    if (constrained[1] === 'string') return stringValue(value, path, min, max)
    if (constrained[1] === 'integer') return integerValue(value, path, min, max)
    return finiteNumber(value, path, min, max)
  }
  const stringMax = trimmed.match(/^string<=(\d+)$/)
  if (stringMax) return stringValue(value, path, 0, Number(stringMax[1]))
  const bytes = trimmed.match(/^Uint8Array<=(\d+)(MiB|KiB|B)$/)
  if (bytes) {
    if (!(value instanceof Uint8Array)) fail(path, 'expected Uint8Array')
    const multiplier = bytes[2] === 'MiB' ? 1024 * 1024 : bytes[2] === 'KiB' ? 1024 : 1
    if (value.byteLength > Number(bytes[1]) * multiplier) fail(path, 'byte array exceeds limit')
    return value
  }
  if (trimmed === 'string') return stringValue(value, path)
  if (trimmed === 'integer') return integerValue(value, path)
  if (trimmed === 'number') return finiteNumber(value, path)
  if (trimmed === 'boolean') {
    if (typeof value !== 'boolean') fail(path, 'expected boolean')
    return value
  }
  if (trimmed === 'timestamp') return timestamp(value, path)
  if (trimmed === 'sha256') {
    if (!sha256Pattern.test(stringValue(value, path))) fail(path, 'expected sha256')
    return value
  }
  if (trimmed === 'sha') {
    if (!gitShaPattern.test(stringValue(value, path))) fail(path, 'expected git sha')
    return value
  }
  if (trimmed === 'uint64-string') {
    if (!uint64Pattern.test(stringValue(value, path)))
      fail(path, 'expected canonical uint64 string')
    return value
  }
  if (trimmed === 'uint64') return integerValue(value, path, 0)
  return namedType(trimmed, value, path)
}

function decodeScope(value: unknown, path = 'scope'): Scope {
  const item = record(value, path)
  exactKeys(item, ['accountId', 'workspaceId', 'runtimeNodeId'], [], path)
  for (const key of ['accountId', 'workspaceId', 'runtimeNodeId'] as const)
    if (!uuidPattern.test(stringValue(item[key], `${path}.${key}`)))
      fail(`${path}.${key}`, 'expected lowercase UUID')
  return value as Scope
}

/** Strict decoder for the M10-minted authorized-root grant DTO. */
export function decodeRootBookmark(value: unknown): RootBookmark {
  namedType('RootBookmark', value, 'rootBookmark')
  return value as RootBookmark
}

/** Strict decoder for the vault-held credential reference DTO (never a secret). */
export function decodeCredentialRef(value: unknown): CredentialRef {
  namedType('CredentialRef', value, 'credentialRef')
  return value as CredentialRef
}

/** Strict decoder for the terminal lifecycle record. */
export function decodeTerminalRecord(value: unknown): TerminalRecord {
  namedType('TerminalRecord', value, 'terminalRecord')
  return value as TerminalRecord
}

/** Strict decoder for the durable terminal checkpoint record. */
export function decodeTerminalCheckpoint(value: unknown): TerminalCheckpoint {
  namedType('TerminalCheckpoint', value, 'terminalCheckpoint')
  return value as TerminalCheckpoint
}

/** Strict decoder for a bounded durable-history search match. */
export function decodeTerminalSearchMatch(value: unknown): TerminalSearchMatch {
  namedType('TerminalSearchMatch', value, 'terminalSearchMatch')
  return value as TerminalSearchMatch
}

/** Strict decoder for the host-admitted shell configuration DTO. */
export function decodeShellProfile(value: unknown): ShellProfile {
  namedType('ShellProfile', value, 'shellProfile')
  return value as ShellProfile
}

/** Strict decoder for the M10 discovery HarnessInstallation read model. */
export function decodeHarnessInstallation(value: unknown): HarnessInstallation {
  namedType('HarnessInstallation', value, 'harnessInstallation')
  return value as HarnessInstallation
}

/** Strict decoder for one RuntimeConnection inventory entry. */
export function decodeRuntimeConnectionInventoryEntry(
  value: unknown
): RuntimeConnectionInventoryEntry {
  namedType('RuntimeConnectionInventoryEntry', value, 'runtimeConnectionInventoryEntry')
  return value as RuntimeConnectionInventoryEntry
}

/** Strict decoder for the RuntimeConnection inventory snapshot read model. */
export function decodeRuntimeConnectionInventorySnapshot(
  value: unknown
): RuntimeConnectionInventorySnapshot {
  const item = record(value, 'runtimeConnectionInventorySnapshot')
  exactKeys(
    item,
    ['scope', 'items', 'freshness', 'observedAt'],
    [],
    'runtimeConnectionInventorySnapshot'
  )
  decodeScope(item.scope, 'runtimeConnectionInventorySnapshot.scope')
  if (!Array.isArray(item.items)) fail('runtimeConnectionInventorySnapshot.items', 'expected array')
  if (item.items.length > 500)
    fail('runtimeConnectionInventorySnapshot.items', 'page exceeds 500 items')
  item.items.forEach((entry, index) =>
    namedType(
      'RuntimeConnectionInventoryEntry',
      entry,
      `runtimeConnectionInventorySnapshot.items[${index}]`
    )
  )
  if (!Array.isArray(item.freshness))
    fail('runtimeConnectionInventorySnapshot.freshness', 'expected array')
  if (item.freshness.length !== item.items.length)
    fail('runtimeConnectionInventorySnapshot.freshness', 'expected one freshness per item')
  item.freshness.forEach((entry, index) =>
    literal(entry, ['fresh', 'stale'], `runtimeConnectionInventorySnapshot.freshness[${index}]`)
  )
  timestamp(item.observedAt, 'runtimeConnectionInventorySnapshot.observedAt')
  return value as RuntimeConnectionInventorySnapshot
}

/** Strict decoder for one HarnessRun record (#31/#32 substrate). */
export function decodeHarnessRun(value: unknown): HarnessRun {
  namedType('HarnessRun', value, 'harnessRun')
  return value as HarnessRun
}

/** Strict decoder for the managed-Pi installation status (#31). */
export function decodeManagedPiStatus(value: unknown): ManagedPiStatus {
  namedType('ManagedPiStatus', value, 'managedPiStatus')
  return value as ManagedPiStatus
}

/** Strict decoder for one ACP lane connection (#32). */
export function decodeAcpConnection(value: unknown): AcpConnection {
  namedType('AcpConnection', value, 'acpConnection')
  return value as AcpConnection
}

/** Strict decoder for the registry Group record (#398). */
export function decodeGroup(value: unknown): Group {
  namedType('Group', value, 'group')
  return value as Group
}

/** Strict decoder for the registry Project record (#398). */
export function decodeProject(value: unknown): Project {
  namedType('Project', value, 'project')
  return value as Project
}

/** Strict decoder for the redacted remote identity DTO (#398). */
export function decodeRedactedRemote(value: unknown): RedactedRemote {
  namedType('RedactedRemote', value, 'redactedRemote')
  return value as RedactedRemote
}

/** Strict decoder for the repository registry record (#398). */
export function decodeRepo(value: unknown): Repo {
  namedType('Repo', value, 'repo')
  return value as Repo
}

/** Strict decoder for the `dev.repo.inspect` reply (#398). */
export function decodeRepoInspection(value: unknown): RepoInspection {
  namedType('RepoInspection', value, 'repoInspection')
  return value as RepoInspection
}

/** Strict decoder for one scanner recommendation (#398). */
export function decodeProjectScanEntry(value: unknown): ProjectScanEntry {
  namedType('ProjectScanEntry', value, 'projectScanEntry')
  return value as ProjectScanEntry
}

/** Strict decoder for the `dev.project.scan` reply page (#398). */
export function decodeProjectScanPage(value: unknown): ProjectScanPage {
  namedType('ProjectScanPage', value, 'projectScanPage')
  return value as ProjectScanPage
}

function decodeDevRuntimePage(
  decodeItem: (value: unknown, path: string) => unknown,
  value: unknown,
  path = 'page'
): DevRuntimePage<unknown> {
  const item = record(value, path)
  exactKeys(item, ['items', 'observedAt'], ['nextCursor'], path)
  if (!Array.isArray(item.items)) fail(`${path}.items`, 'expected array')
  if (item.items.length > 500) fail(`${path}.items`, 'page exceeds 500 items')
  item.items.forEach((entry, index) => decodeItem(entry, `${path}.items[${index}]`))
  timestamp(item.observedAt, `${path}.observedAt`)
  if (item.nextCursor !== undefined) stringValue(item.nextCursor, `${path}.nextCursor`, 1, 512)
  return value as DevRuntimePage<unknown>
}

// Success reply decoders, installed by the slice that owns each operation's
// DTO. Every operation without an entry keeps failing closed in decodeDevReply.
const devReplyValueDecoders: Partial<Record<DevOperation, (value: unknown) => unknown>> = {
  // Project registry (#398): import/create mint Project records, scan returns
  // a bounded preview page, and the group lifecycle commands return Group.
  // update/archive reply with the re-read Project record (same decoder).
  'dev.project.import': (value) => decodeProject(value),
  'dev.project.create': (value) => decodeProject(value),
  'dev.project.update': (value) => decodeProject(value),
  'dev.project.archive': (value) => decodeProject(value),
  'dev.project.scan': (value) => decodeProjectScanPage(value),
  'dev.group.create': (value) => decodeGroup(value),
  'dev.group.update': (value) => decodeGroup(value),
  'dev.group.delete': (value) => decodeGroup(value),
  'dev.project.bookmarks': (value) => decodeDevRuntimePage(decodeRootBookmark, value),
  'dev.repo.credentialRefs': (value) => decodeDevRuntimePage(decodeCredentialRef, value),
  // Repository registry (#398 follow-up): adopt/authorize/refresh reply with
  // the re-read Repo record, inspect with fresh read-only facts, and list
  // with a bounded Repo page.
  'dev.repo.adopt': (value) => decodeRepo(value),
  'dev.repo.authorize': (value) => decodeRepo(value),
  'dev.repo.refresh': (value) => decodeRepo(value),
  'dev.repo.inspect': (value) => decodeRepoInspection(value),
  'dev.repo.list': (value) => decodeDevRuntimePage(decodeRepo, value),
  // Files/search slice (#399): strict DTO decoders installed by the
  // operation-owning provider slice before its handlers register.
  'dev.files.list': (value) =>
    decodeDevRuntimePage((item, path) => namedType('FileEntry', item, path), value, 'reply.value'),
  'dev.files.stat': (value) => namedType('FileEntry', value, 'reply.value'),
  'dev.files.read': (value) => namedType('FileReadResult', value, 'reply.value'),
  'dev.files.write': (value) => namedType('FileWriteResult', value, 'reply.value'),
  'dev.files.create': (value) => namedType('FileEntry', value, 'reply.value'),
  'dev.files.rename': (value) => namedType('FileEntry', value, 'reply.value'),
  'dev.files.delete': (value) => namedType('FileMutationResult', value, 'reply.value'),
  'dev.files.copy': (value) => namedType('FileEntry', value, 'reply.value'),
  'dev.files.search': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('SearchMatch', item, path),
      value,
      'reply.value'
    ),
  'dev.files.openExternal': (value) => namedType('ExternalOpenResult', value, 'reply.value'),
  'dev.files.readStream': (value) => decodeDevStreamGrant(value),
  'dev.files.writeStream': (value) => decodeDevStreamGrant(value),
  // Recursive/overwrite mutation pairs (#399): plans decode as MutationPlan,
  // commits reply with the produced entry or the enumerated tree summary.
  'dev.files.renameOverwritePlan': (value) => decodeMutationPlan(value),
  'dev.files.renameOverwriteCommit': (value) => namedType('FileEntry', value, 'reply.value'),
  'dev.files.deleteTreePlan': (value) => decodeMutationPlan(value),
  'dev.files.deleteTreeCommit': (value) =>
    namedType('FileTreeMutationResult', value, 'reply.value'),
  'dev.files.copyTreePlan': (value) => decodeMutationPlan(value),
  'dev.files.copyTreeCommit': (value) => namedType('FileTreeMutationResult', value, 'reply.value'),
  // Local git slice (#399).
  'dev.git.status': (value) => namedType('GitStatus', value, 'reply.value'),
  'dev.git.history': (value) =>
    decodeDevRuntimePage((item, path) => namedType('GitCommit', item, path), value, 'reply.value'),
  'dev.git.diff': (value) =>
    decodeDevRuntimePage((item, path) => namedType('DiffHunk', item, path), value, 'reply.value'),
  'dev.git.stage': (value) => namedType('GitStatus', value, 'reply.value'),
  'dev.git.unstage': (value) => namedType('GitStatus', value, 'reply.value'),
  'dev.git.discardPlan': (value) => decodeMutationPlan(value),
  'dev.git.discardCommit': (value) => namedType('GitStatus', value, 'reply.value'),
  'dev.git.commit': (value) => namedType('GitCommit', value, 'reply.value'),
  'dev.git.fetch': (value) => namedType('GitFetchResult', value, 'reply.value'),
  'dev.git.checkpoint': (value) => namedType('GitCheckpoint', value, 'reply.value'),
  'dev.git.restorePlan': (value) => decodeMutationPlan(value),
  'dev.git.restoreCommit': (value) => namedType('GitStatus', value, 'reply.value'),
  // GitHub remote slice (#423): host-neutral DTOs decoded strictly from the
  // `gh`/git transport; mutations reply with re-read server truth.
  'dev.github.account': (value) => namedType('GitHubAccount', value, 'reply.value'),
  'dev.github.checks': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('GitHubCheck', item, path),
      value,
      'reply.value'
    ),
  'dev.github.createPullRequest': (value) => namedType('GitHubPullRequest', value, 'reply.value'),
  'dev.github.issues': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('GitHubIssue', item, path),
      value,
      'reply.value'
    ),
  'dev.github.mergeCommit': (value) => namedType('GitHubPullRequest', value, 'reply.value'),
  'dev.github.mergePlan': (value) => decodeMutationPlan(value),
  'dev.github.milestones': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('GitHubMilestone', item, path),
      value,
      'reply.value'
    ),
  'dev.github.pullRequest': (value) => namedType('GitHubPullRequest', value, 'reply.value'),
  'dev.github.pullRequests': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('GitHubPullRequest', item, path),
      value,
      'reply.value'
    ),
  'dev.github.pushCommit': (value) => namedType('GitPushResult', value, 'reply.value'),
  'dev.github.pushPlan': (value) => decodeMutationPlan(value),
  'dev.github.repository': (value) => namedType('GitHubRepository', value, 'reply.value'),
  'dev.github.updateBranchCommit': (value) =>
    namedType('GitUpdateBranchResult', value, 'reply.value'),
  'dev.github.updateBranchPlan': (value) => decodeMutationPlan(value),
  'dev.github.updateCommit': (value) => namedType('GitHubPullRequest', value, 'reply.value'),
  'dev.github.updatePlan': (value) => decodeMutationPlan(value),
  // Terminal slice (#396): attach/input return single-use stream grants.
  'dev.terminal.attach': (value) => decodeDevStreamGrant(value),
  'dev.terminal.input': (value) => decodeDevStreamGrant(value),
  'dev.terminal.create': (value) => decodeTerminalRecord(value),
  'dev.terminal.detach': (value) => decodeTerminalRecord(value),
  'dev.terminal.resize': (value) => decodeTerminalRecord(value),
  'dev.terminal.signal': (value) => decodeTerminalRecord(value),
  'dev.terminal.terminate': (value) => decodeTerminalRecord(value),
  'dev.terminal.historyDelete': (value) => decodeTerminalRecord(value),
  'dev.terminal.list': (value) => decodeDevRuntimePage(decodeTerminalRecord, value),
  'dev.terminal.search': (value) => decodeDevRuntimePage(decodeTerminalSearchMatch, value),
  'dev.terminal.shellProfiles': (value) => decodeDevRuntimePage(decodeShellProfile, value),
  'dev.terminal.checkpoint': (value) => decodeTerminalCheckpoint(value),
  // #422 browser/device lanes. Page replies decode through the same strict
  // named-type validators the registry bodies use.
  'dev.browser.annotate': (value) => namedType('BrowserAnnotation', value, 'reply.value'),
  'dev.browser.attach': (value) => decodeDevStreamGrant(value),
  'dev.browser.cookieImportCommit': (value) =>
    namedType('CookieImportResult', value, 'reply.value'),
  'dev.browser.cookieImportPlan': (value) => decodeMutationPlan(value),
  'dev.browser.diagnostics': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('BrowserDiagnostic', item, path),
      value,
      'reply.value'
    ),
  'dev.browser.inspect': (value) => namedType('BrowserInspection', value, 'reply.value'),
  'dev.browser.input': (value) => decodeDevStreamGrant(value),
  'dev.browser.laneClose': (value) => namedType('BrowserLane', value, 'reply.value'),
  'dev.browser.laneCreate': (value) => namedType('BrowserLane', value, 'reply.value'),
  'dev.browser.lanes': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('BrowserLane', item, path),
      value,
      'reply.value'
    ),
  'dev.browser.navigate': (value) => namedType('BrowserNavigation', value, 'reply.value'),
  'dev.browser.profilePolicies': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('ProfilePolicy', item, path),
      value,
      'reply.value'
    ),
  'dev.browser.profileReset': (value) => namedType('BrowserLane', value, 'reply.value'),
  'dev.browser.release': (value) => namedType('BrowserLane', value, 'reply.value'),
  'dev.browser.screenshot': (value) => namedType('ScreenshotRef', value, 'reply.value'),
  'dev.browser.takeover': (value) => namedType('BrowserLane', value, 'reply.value'),
  'dev.browser.targets': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('BrowserTarget', item, path),
      value,
      'reply.value'
    ),
  'dev.browser.viewport': (value) => namedType('BrowserLane', value, 'reply.value'),
  // #472 computer-use lanes. Stream-grant replies decode like the
  // browser/device attach/input pairs; capability/consent replies use the
  // strict named-type validators above.
  'dev.computeruse.attach': (value) => decodeDevStreamGrant(value),
  'dev.computeruse.capabilities': (value) =>
    namedType('ComputerUseCapabilityReport', value, 'reply.value'),
  'dev.computeruse.consent': (value) => namedType('ComputerUseConsent', value, 'reply.value'),
  'dev.computeruse.input': (value) => decodeDevStreamGrant(value),
  'dev.computeruse.laneClose': (value) => namedType('ComputerUseLane', value, 'reply.value'),
  'dev.computeruse.laneCreate': (value) => namedType('ComputerUseLane', value, 'reply.value'),
  'dev.computeruse.lanes': (value) =>
    decodeDevRuntimePage((item, path) => namedType('ComputerUseLane', item, path), value),
  'dev.computeruse.release': (value) => namedType('ComputerUseLane', value, 'reply.value'),
  'dev.computeruse.takeover': (value) => namedType('ComputerUseLane', value, 'reply.value'),
  'dev.device.attach': (value) => decodeDevStreamGrant(value),
  'dev.device.input': (value) => decodeDevStreamGrant(value),
  'dev.device.list': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('DeviceInventoryItem', item, path),
      value,
      'reply.value'
    ),
  'dev.device.screenshot': (value) => namedType('ScreenshotRef', value, 'reply.value'),
  'dev.device.sessions': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('DeviceSession', item, path),
      value,
      'reply.value'
    ),
  'dev.device.start': (value) => namedType('DeviceSession', value, 'reply.value'),
  'dev.device.stop': (value) => namedType('DeviceSession', value, 'reply.value'),
  // The #422 Ports menu consumes this read-only projection; #424 owns the
  // provider and its resource side.
  'dev.resources.ports': (value) =>
    decodeDevRuntimePage((item, path) => namedType('PortRecord', item, path), value, 'reply.value'),
  // #424 runtime resources, usage, activity, and safe cleanup.
  'dev.resources.snapshot': (value) => namedType('ResourceSnapshot', value, 'reply.value'),
  'dev.resources.processes': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('ProcessRecord', item, path),
      value,
      'reply.value'
    ),
  'dev.resources.metrics': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('ResourceMetric', item, path),
      value,
      'reply.value'
    ),
  'dev.resources.retainedData': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('RetainedDataRecord', item, path),
      value,
      'reply.value'
    ),
  'dev.resources.usage': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('UsageRecord', item, path),
      value,
      'reply.value'
    ),
  'dev.resources.stopPlan': (value) => namedType('MutationPlan', value, 'reply.value'),
  'dev.resources.stopCommit': (value) => namedType('ProcessRecord', value, 'reply.value'),
  'dev.cleanupPolicy.list': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('CleanupPolicy', item, path),
      value,
      'reply.value'
    ),
  'dev.cleanupPolicy.createDraft': (value) => namedType('CleanupPolicy', value, 'reply.value'),
  'dev.cleanupPolicy.approve': (value) => namedType('CleanupPolicy', value, 'reply.value'),
  'dev.cleanupPolicy.disable': (value) => namedType('CleanupPolicy', value, 'reply.value'),
  'dev.cleanupPolicy.evaluate': (value) =>
    namedType('CleanupPolicyEvaluation', value, 'reply.value'),
  // #31/#32 harness substrate: managed-Pi status/install, ACP lane
  // connections, run status/history, and the session-mapped launch/resume/
  // cancel replies whose DTO lands with the owning provider slice.
  'dev.harness.acpClose': (value) => decodeAcpConnection(value),
  'dev.harness.acpConnect': (value) => decodeAcpConnection(value),
  'dev.harness.acpConnections': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('AcpConnection', item, path),
      value,
      'reply.value'
    ),
  'dev.harness.managedPiInstall': (value) => decodeManagedPiStatus(value),
  'dev.harness.managedPiStatus': (value) => decodeManagedPiStatus(value),
  'dev.harness.runs': (value) =>
    decodeDevRuntimePage((item, path) => namedType('HarnessRun', item, path), value, 'reply.value'),
  'dev.session.cancelHarness': (value) => decodeHarnessRun(value),
  'dev.session.launchHarness': (value) => decodeHarnessRun(value),
  'dev.session.resumeHarness': (value) => decodeHarnessRun(value),
  // #400 harness launch orchestration: preferences read/update/reset, the
  // observed run-status transition, the default-harness launch, and the
  // runtime-events-v1 stream grant.
  'dev.harness.preferences': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('HarnessPreference', item, path),
      value,
      'reply.value'
    ),
  'dev.harness.preferenceUpdate': (value) => namedType('HarnessPreference', value, 'reply.value'),
  'dev.harness.preferenceReset': (value) =>
    decodeDevRuntimePage(
      (item, path) => namedType('HarnessPreference', item, path),
      value,
      'reply.value'
    ),
  'dev.harness.runStatus': (value) => decodeHarnessRun(value),
  'dev.session.launchDefault': (value) => decodeHarnessRun(value),
  'dev.session.events': (value) => decodeDevStreamGrant(value),
}

function decodeError(value: unknown, path = 'error'): DevError {
  const item = record(value, path)
  exactKeys(
    item,
    ['code', 'retryable', 'message'],
    ['remediation', 'currentVersion', 'observedAt'],
    path
  )
  literal(item.code, devErrorCodes, `${path}.code`)
  if (typeof item.retryable !== 'boolean') fail(`${path}.retryable`, 'expected boolean')
  stringValue(item.message, `${path}.message`, 1, 4096)
  if (item.currentVersion !== undefined)
    integerValue(item.currentVersion, `${path}.currentVersion`, 0)
  if (item.observedAt !== undefined) timestamp(item.observedAt, `${path}.observedAt`)
  if (item.remediation !== undefined) {
    const remediation = record(item.remediation, `${path}.remediation`)
    exactKeys(remediation, ['action'], ['parameters'], `${path}.remediation`)
    stringValue(remediation.action, `${path}.remediation.action`, 1, 128)
    if (remediation.parameters !== undefined) {
      const parameters = record(remediation.parameters, `${path}.remediation.parameters`)
      for (const [key, entry] of Object.entries(parameters)) {
        stringValue(key, `${path}.remediation.parameters key`, 1, 128)
        stringValue(entry, `${path}.remediation.parameters.${key}`, 0, 4096)
      }
    }
  }
  return value as DevError
}

function validateEventPayload(value: unknown, path: string, depth = 0): void {
  if (depth > 32) fail(path, 'maximum nesting depth exceeded')
  if (typeof value === 'string') {
    stringValue(value, path, 0, 65_536)
    return
  }
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    finiteNumber(value, path)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateEventPayload(entry, `${path}[${index}]`, depth + 1))
    return
  }
  const item = record(value, path)
  for (const [key, entry] of Object.entries(item)) {
    stringValue(key, `${path} key`, 1, 256)
    validateEventPayload(entry, `${path}.${key}`, depth + 1)
  }
}

export type RuntimeEventProvenance = Readonly<{
  /** Source derived from the authenticated transport/adapter, never event JSON. */
  source: RuntimeEvent['source']
}>

export function decodeRuntimeEvent(
  value: unknown,
  provenance: RuntimeEventProvenance
): RuntimeEvent {
  const item = record(value, 'event')
  exactKeys(
    item,
    [
      'schemaVersion',
      'eventId',
      'runtimeSessionId',
      'generation',
      'seq',
      'occurredAt',
      'receivedAt',
      'source',
      'sourceEventId',
      'confidence',
      'classification',
      'kind',
      'payload',
    ],
    ['harnessRunId'],
    'event'
  )
  if (item.schemaVersion !== 1) fail('event.schemaVersion', 'expected 1')
  for (const key of ['eventId', 'runtimeSessionId', 'sourceEventId'] as const)
    stringValue(item[key], `event.${key}`, 1, 256)
  if (item.harnessRunId !== undefined) stringValue(item.harnessRunId, 'event.harnessRunId', 1, 256)
  integerValue(item.generation, 'event.generation', 0)
  if (!uint64Pattern.test(stringValue(item.seq, 'event.seq')))
    fail('event.seq', 'expected uint64 string')
  timestamp(item.occurredAt, 'event.occurredAt')
  timestamp(item.receivedAt, 'event.receivedAt')
  literal(
    item.source,
    ['native', 'acp', 'authenticated_hook', 'terminal_fallback', 'host'],
    'event.source'
  )
  if (item.source !== provenance.source)
    fail('event.source', 'does not match authenticated transport provenance')
  literal(
    item.confidence,
    ['authoritative', 'bounded_projection', 'untrusted_hint'],
    'event.confidence'
  )
  literal(item.classification, dataClassifications, 'event.classification')
  literal(item.kind, runtimeEventKinds, 'event.kind')
  if (item.source === 'terminal_fallback') {
    if (item.confidence === 'authoritative')
      fail('event.confidence', 'terminal fallback cannot be authoritative')
    const fallbackKinds: readonly RuntimeEventKind[] = [
      'turn.assistant_delta',
      'turn.assistant_message',
      'terminal.command_started',
      'terminal.command_finished',
      'terminal.cwd_changed',
      'terminal.transcript_reference',
    ]
    if (!fallbackKinds.includes(item.kind as RuntimeEventKind))
      fail('event.kind', 'terminal fallback cannot synthesize this event kind')
  }
  validateEventPayload(item.payload, 'event.payload')
  if (new TextEncoder().encode(JSON.stringify(item.payload)).byteLength > 256 * 1024)
    fail('event.payload', 'maximum encoded size exceeded')
  return value as RuntimeEvent
}

function isPairedCommitOperation(operation: DevOperation): boolean {
  if (!operation.endsWith('Commit')) return false
  return `${operation.slice(0, -'Commit'.length)}Plan` in devOperationDefinitions
}

function decodeRequestBody(
  operation: DevOperation,
  value: unknown
): Readonly<Record<string, unknown>> {
  assertNoAuthorityFields(value)
  return validateType(devOperationDefinitions[operation].body, value, 'body') as Readonly<
    Record<string, unknown>
  >
}

export function decodeDevCommand(value: unknown): DevCommand {
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    fail('command', 'expected JSON-encodable control payload')
  }
  if (new TextEncoder().encode(encoded).byteLength > 256 * 1024)
    fail('command', 'control payload exceeds 256 KiB')
  const item = record(value, 'command')
  exactKeys(
    item,
    [
      'schemaVersion',
      'operation',
      'requestId',
      'nonce',
      'issuedAt',
      'expiresAt',
      'scope',
      'capabilities',
      'body',
    ],
    ['idempotencyKey', 'resource'],
    'command'
  )
  if (item.schemaVersion !== 1) fail('command.schemaVersion', 'expected 1')
  const operation = item.operation
  if (typeof operation !== 'string' || !(operation in devOperationDefinitions))
    fail('command.operation', 'unknown operation')
  const typedOperation = operation as DevOperation
  if (!uuidPattern.test(stringValue(item.requestId, 'command.requestId')))
    fail('command.requestId', 'expected lowercase UUID')
  const nonce = stringValue(item.nonce, 'command.nonce', 22, 256)
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) fail('command.nonce', 'expected unpadded base64url')
  timestamp(item.issuedAt, 'command.issuedAt')
  timestamp(item.expiresAt, 'command.expiresAt')
  decodeScope(item.scope)
  if (item.idempotencyKey !== undefined) {
    const key = stringValue(item.idempotencyKey, 'command.idempotencyKey', 1, 128)
    if (!/^[\x20-\x7e]+$/.test(key)) fail('command.idempotencyKey', 'expected printable ASCII')
  }
  if (!Array.isArray(item.capabilities)) fail('command.capabilities', 'expected array')
  const expected = devOperationDefinitions[typedOperation].capabilities
  if (
    item.capabilities.length !== expected.length ||
    item.capabilities.some((capability, index) => capability !== expected[index])
  ) {
    fail('command.capabilities', 'must exactly equal sorted registry capabilities')
  }
  const body = decodeRequestBody(typedOperation, item.body)
  const resourceDefinition = devOperationDefinitions[typedOperation].resource
  if (resourceDefinition === null) {
    if (item.resource !== undefined) fail('command.resource', 'must be absent')
  } else {
    const resource = record(item.resource, 'command.resource')
    exactKeys(resource, ['kind', 'id', 'generation'], [], 'command.resource')
    if (resource.kind !== resourceDefinition.kind)
      fail('command.resource.kind', `expected ${resourceDefinition.kind}`)
    const resourceId = stringValue(resource.id, 'command.resource.id', 1)
    const targetId = body[resourceDefinition.idField]
    if (typeof targetId === 'string') {
      if (resourceId !== targetId)
        fail('command.resource.id', 'resource id does not match body target')
    } else if (!isPairedCommitOperation(typedOperation)) {
      fail('command.resource.id', 'body target is missing')
    }
    integerValue(resource.generation, 'command.resource.generation', 0)
    if (body.expectedGeneration !== undefined && resource.generation !== body.expectedGeneration)
      fail('command.resource.generation', 'resource generation does not match body')
  }
  return value as DevCommand
}

export function decodeDevReply(value: unknown): DevReply {
  const item = record(value, 'reply')
  if (item.schemaVersion !== 1) fail('reply.schemaVersion', 'expected 1')
  const operation = item.operation
  if (typeof operation !== 'string' || !(operation in devOperationDefinitions))
    fail('reply.operation', 'unknown operation')
  if (!uuidPattern.test(stringValue(item.requestId, 'reply.requestId')))
    fail('reply.requestId', 'expected lowercase UUID')
  if (item.ok === true) {
    exactKeys(
      item,
      ['schemaVersion', 'operation', 'requestId', 'ok', 'value', 'observedAt'],
      [],
      'reply'
    )
    timestamp(item.observedAt, 'reply.observedAt')
    const decodeValue = devReplyValueDecoders[item.operation as DevOperation]
    if (!decodeValue)
      fail(
        'reply.value',
        'success DTO decoder is unavailable until the operation-owning provider slice installs it'
      )
    decodeValue(item.value)
  } else if (item.ok === false) {
    exactKeys(item, ['schemaVersion', 'operation', 'requestId', 'ok', 'error'], [], 'reply')
    decodeError(item.error)
  } else fail('reply.ok', 'expected boolean')
  return value as DevReply
}

export const devOperationDecoders = Object.freeze(
  Object.fromEntries(
    devOperations.map((operation) => [
      operation,
      Object.freeze({
        request: (value: unknown) => decodeRequestBody(operation, value),
        reply: (value: unknown) => {
          const reply = decodeDevReply(value)
          if (reply.operation !== operation) fail('reply.operation', `expected ${operation}`)
          return reply
        },
      }),
    ])
  )
) as Readonly<
  Record<
    DevOperation,
    Readonly<{
      request(value: unknown): Readonly<Record<string, unknown>>
      reply(value: unknown): DevReply
    }>
  >
>

// ─── Authenticated command channel (M10 #33) ────────────────────────────────
//
// Every privileged command travels over a versioned authenticated channel
// (`dev.runtime.handshake.v1` → `dev.runtime.execute.v1` / `.events.v1` /
// `.stream.attach.v1`). The host rejects a bare `DevCommand`; the frame below
// is the wire contract that carries it. Proof inputs are built here so the
// client adapter and the host MAC byte-identical messages, and control frames
// on the bulk stream use canonical CBOR (RFC 8949 deterministic encoding).

export type DevChannelHandshakeRequest = Readonly<{
  schemaVersion: 1
  method: 'dev.runtime.handshake.v1'
  requestId: string
  /** One-time launch capability delivered only to the trusted window. */
  bootstrap: string
  supportedProtocolVersions: readonly string[]
  nonce: string
  issuedAt: string
  expiresAt: string
}>

export type DevChannelHandshakeReply = Readonly<
  | {
      schemaVersion: 1
      method: 'dev.runtime.handshake.v1'
      requestId: string
      ok: true
      channelId: string
      clientCredentialId: string
      /** Returned exactly once over the loopback; never persisted or logged. */
      clientSecret: string
      channelGeneration: number
      protocolVersion: string
      serverExpiresAt: string
      observedAt: string
    }
  | {
      schemaVersion: 1
      method: 'dev.runtime.handshake.v1'
      requestId: string
      ok: false
      error: DevError
    }
>

export type AuthorizedDevFrame<K extends DevOperation = DevOperation> = Readonly<{
  channelId: string
  clientCredentialId: string
  command: DevCommand<K>
  proof: string
}>

export type DevStreamGrant = Readonly<{
  schemaVersion: 1
  grantId: string
  protocol: DevStreamProtocol
  channelId: string
  scope: Scope
  resource: Readonly<{ kind: string; id: string; generation: number }>
  direction: 'read' | 'write'
  fromSequence: string
  expiresAt: string
  maxFrameBytes: number
}>

export type DevStreamAttach = Readonly<{
  schemaVersion: 1
  grantId: string
  requestId: string
  nonce: string
  fromSequence: string
  proof: string
}>

export type DeviceGesture =
  | Readonly<{ kind: 'tap'; x: number; y: number }>
  | Readonly<{
      kind: 'swipe'
      fromX: number
      fromY: number
      toX: number
      toY: number
      durationMs: number
    }>
  | Readonly<{ kind: 'key'; code: string; action: 'down' | 'up' }>
  | Readonly<{ kind: 'text'; text: string }>

export type DevStreamFrame =
  | Readonly<{
      type: 'opened'
      protocol: DevStreamProtocol
      generation: number
      nextSequence: string
    }>
  | Readonly<{ type: 'data'; sequence: string; bytes: Uint8Array }>
  | Readonly<{
      type: 'video'
      sequence: string
      timestampMs: number
      keyframe: boolean
      bytes: Uint8Array
    }>
  | Readonly<{ type: 'input'; sequence: string; generation: number; bytes: Uint8Array }>
  | Readonly<{ type: 'gesture'; sequence: string; generation: number; gesture: DeviceGesture }>
  | Readonly<{ type: 'resize'; sequence: string; generation: number; cols: number; rows: number }>
  | Readonly<{ type: 'ack'; throughSequence: string; availableCreditBytes: number }>
  | Readonly<{ type: 'heartbeat'; observedAt: string; throughSequence: string }>
  | Readonly<{
      type: 'resync'
      reason: 'sequence_gap' | 'checkpoint_required'
      checkpointSequence: string
    }>
  | Readonly<{ type: 'error'; error: DevError }>
  | Readonly<{
      type: 'close'
      code: 'normal' | 'expired' | 'revoked' | 'stale_generation' | 'backpressure' | 'incompatible'
      reason?: string
    }>

function base64url(value: unknown, path: string, min: number, max: number): string {
  const text = stringValue(value, path, min, max)
  if (!/^[A-Za-z0-9_-]+$/.test(text)) fail(path, 'expected unpadded base64url')
  return text
}

function uint64String(value: unknown, path: string): string {
  const text = stringValue(value, path, 1, 64)
  if (!uint64Pattern.test(text)) fail(path, 'expected canonical uint64 string')
  return text
}

function resourceBinding(value: unknown, path: string): DevStreamGrant['resource'] {
  const item = record(value, path)
  exactKeys(item, ['kind', 'id', 'generation'], [], path)
  stringValue(item.kind, `${path}.kind`, 1, 64)
  stringValue(item.id, `${path}.id`, 1, 256)
  integerValue(item.generation, `${path}.generation`, 0)
  return value as DevStreamGrant['resource']
}

export function decodeDevChannelHandshakeRequest(value: unknown): DevChannelHandshakeRequest {
  const item = record(value, 'handshake request')
  exactKeys(
    item,
    [
      'schemaVersion',
      'method',
      'requestId',
      'bootstrap',
      'supportedProtocolVersions',
      'nonce',
      'issuedAt',
      'expiresAt',
    ],
    [],
    'handshake request'
  )
  if (item.schemaVersion !== 1) fail('handshake request.schemaVersion', 'expected 1')
  if (item.method !== devRuntimeTransportMethods.handshake)
    fail('handshake request.method', `expected ${devRuntimeTransportMethods.handshake}`)
  if (!uuidPattern.test(stringValue(item.requestId, 'handshake request.requestId')))
    fail('handshake request.requestId', 'expected lowercase UUID')
  base64url(item.bootstrap, 'handshake request.bootstrap', 22, 512)
  if (
    !Array.isArray(item.supportedProtocolVersions) ||
    item.supportedProtocolVersions.length === 0 ||
    item.supportedProtocolVersions.length > 8
  )
    fail('handshake request.supportedProtocolVersions', 'expected 1..8 versions')
  item.supportedProtocolVersions.forEach((version, index) =>
    stringValue(version, `handshake request.supportedProtocolVersions[${index}]`, 1, 32)
  )
  base64url(item.nonce, 'handshake request.nonce', 22, 256)
  timestamp(item.issuedAt, 'handshake request.issuedAt')
  timestamp(item.expiresAt, 'handshake request.expiresAt')
  return value as DevChannelHandshakeRequest
}

export function decodeDevChannelHandshakeReply(value: unknown): DevChannelHandshakeReply {
  const item = record(value, 'handshake reply')
  if (item.schemaVersion !== 1) fail('handshake reply.schemaVersion', 'expected 1')
  if (item.method !== devRuntimeTransportMethods.handshake)
    fail('handshake reply.method', `expected ${devRuntimeTransportMethods.handshake}`)
  if (!uuidPattern.test(stringValue(item.requestId, 'handshake reply.requestId')))
    fail('handshake reply.requestId', 'expected lowercase UUID')
  if (item.ok === true) {
    exactKeys(
      item,
      [
        'schemaVersion',
        'method',
        'requestId',
        'ok',
        'channelId',
        'clientCredentialId',
        'clientSecret',
        'channelGeneration',
        'protocolVersion',
        'serverExpiresAt',
        'observedAt',
      ],
      [],
      'handshake reply'
    )
    for (const key of ['channelId', 'clientCredentialId'] as const)
      if (!uuidPattern.test(stringValue(item[key], `handshake reply.${key}`)))
        fail(`handshake reply.${key}`, 'expected lowercase UUID')
    base64url(item.clientSecret, 'handshake reply.clientSecret', 43, 512)
    integerValue(item.channelGeneration, 'handshake reply.channelGeneration', 0)
    stringValue(item.protocolVersion, 'handshake reply.protocolVersion', 1, 32)
    timestamp(item.serverExpiresAt, 'handshake reply.serverExpiresAt')
    timestamp(item.observedAt, 'handshake reply.observedAt')
    return value as DevChannelHandshakeReply
  }
  if (item.ok === false) {
    exactKeys(item, ['schemaVersion', 'method', 'requestId', 'ok', 'error'], [], 'handshake reply')
    decodeError(item.error)
    return value as DevChannelHandshakeReply
  }
  fail('handshake reply.ok', 'expected boolean')
}

export function decodeAuthorizedDevFrame<K extends DevOperation = DevOperation>(
  value: unknown
): AuthorizedDevFrame<K> {
  const item = record(value, 'authorized frame')
  exactKeys(item, ['channelId', 'clientCredentialId', 'command', 'proof'], [], 'authorized frame')
  for (const key of ['channelId', 'clientCredentialId'] as const)
    if (!uuidPattern.test(stringValue(item[key], `authorized frame.${key}`)))
      fail(`authorized frame.${key}`, 'expected lowercase UUID')
  base64url(item.proof, 'authorized frame.proof', 43, 512)
  decodeDevCommand(item.command)
  return value as AuthorizedDevFrame<K>
}

export function decodeDevStreamGrant(value: unknown): DevStreamGrant {
  const item = record(value, 'stream grant')
  exactKeys(
    item,
    [
      'schemaVersion',
      'grantId',
      'protocol',
      'channelId',
      'scope',
      'resource',
      'direction',
      'fromSequence',
      'expiresAt',
      'maxFrameBytes',
    ],
    [],
    'stream grant'
  )
  if (item.schemaVersion !== 1) fail('stream grant.schemaVersion', 'expected 1')
  if (!uuidPattern.test(stringValue(item.grantId, 'stream grant.grantId')))
    fail('stream grant.grantId', 'expected lowercase UUID')
  if (typeof item.protocol !== 'string' || !(item.protocol in devStreamProtocolDefinitions))
    fail('stream grant.protocol', 'unknown protocol')
  if (!uuidPattern.test(stringValue(item.channelId, 'stream grant.channelId')))
    fail('stream grant.channelId', 'expected lowercase UUID')
  decodeScope(item.scope, 'stream grant.scope')
  resourceBinding(item.resource, 'stream grant.resource')
  literal(item.direction, ['read', 'write'], 'stream grant.direction')
  uint64String(item.fromSequence, 'stream grant.fromSequence')
  timestamp(item.expiresAt, 'stream grant.expiresAt')
  integerValue(item.maxFrameBytes, 'stream grant.maxFrameBytes', 1, 67_108_864)
  return value as DevStreamGrant
}

export function decodeDevStreamAttach(value: unknown): DevStreamAttach {
  const item = record(value, 'stream attach')
  exactKeys(
    item,
    ['schemaVersion', 'grantId', 'requestId', 'nonce', 'fromSequence', 'proof'],
    [],
    'stream attach'
  )
  if (item.schemaVersion !== 1) fail('stream attach.schemaVersion', 'expected 1')
  for (const key of ['grantId', 'requestId'] as const)
    if (!uuidPattern.test(stringValue(item[key], `stream attach.${key}`)))
      fail(`stream attach.${key}`, 'expected lowercase UUID')
  base64url(item.nonce, 'stream attach.nonce', 22, 256)
  uint64String(item.fromSequence, 'stream attach.fromSequence')
  base64url(item.proof, 'stream attach.proof', 43, 512)
  return value as DevStreamAttach
}

export function decodeDevStreamFrame(value: unknown): DevStreamFrame {
  const item = record(value, 'stream frame')
  const type = item.type
  if (typeof type !== 'string') fail('stream frame.type', 'expected string')
  if (type === 'opened') {
    exactKeys(item, ['type', 'protocol', 'generation', 'nextSequence'], [], 'stream frame')
    if (typeof item.protocol !== 'string' || !(item.protocol in devStreamProtocolDefinitions))
      fail('stream frame.protocol', 'unknown protocol')
    integerValue(item.generation, 'stream frame.generation', 0)
    uint64String(item.nextSequence, 'stream frame.nextSequence')
    return value as DevStreamFrame
  }
  if (type === 'data') {
    exactKeys(item, ['type', 'sequence', 'bytes'], [], 'stream frame')
    uint64String(item.sequence, 'stream frame.sequence')
    if (!(item.bytes instanceof Uint8Array)) fail('stream frame.bytes', 'expected Uint8Array')
    return value as DevStreamFrame
  }
  if (type === 'video') {
    exactKeys(item, ['type', 'sequence', 'timestampMs', 'keyframe', 'bytes'], [], 'stream frame')
    uint64String(item.sequence, 'stream frame.sequence')
    integerValue(item.timestampMs, 'stream frame.timestampMs', 0)
    if (typeof item.keyframe !== 'boolean') fail('stream frame.keyframe', 'expected boolean')
    if (!(item.bytes instanceof Uint8Array)) fail('stream frame.bytes', 'expected Uint8Array')
    return value as DevStreamFrame
  }
  if (type === 'input') {
    exactKeys(item, ['type', 'sequence', 'generation', 'bytes'], [], 'stream frame')
    uint64String(item.sequence, 'stream frame.sequence')
    integerValue(item.generation, 'stream frame.generation', 0)
    if (!(item.bytes instanceof Uint8Array)) fail('stream frame.bytes', 'expected Uint8Array')
    return value as DevStreamFrame
  }
  if (type === 'gesture') {
    exactKeys(item, ['type', 'sequence', 'generation', 'gesture'], [], 'stream frame')
    uint64String(item.sequence, 'stream frame.sequence')
    integerValue(item.generation, 'stream frame.generation', 0)
    namedType('DeviceGesture', item.gesture, 'stream frame.gesture')
    return value as DevStreamFrame
  }
  if (type === 'resize') {
    exactKeys(item, ['type', 'sequence', 'generation', 'cols', 'rows'], [], 'stream frame')
    uint64String(item.sequence, 'stream frame.sequence')
    integerValue(item.generation, 'stream frame.generation', 0)
    integerValue(item.cols, 'stream frame.cols', 1, 1000)
    integerValue(item.rows, 'stream frame.rows', 1, 1000)
    return value as DevStreamFrame
  }
  if (type === 'ack') {
    exactKeys(item, ['type', 'throughSequence', 'availableCreditBytes'], [], 'stream frame')
    uint64String(item.throughSequence, 'stream frame.throughSequence')
    integerValue(item.availableCreditBytes, 'stream frame.availableCreditBytes', 0)
    return value as DevStreamFrame
  }
  if (type === 'heartbeat') {
    exactKeys(item, ['type', 'observedAt', 'throughSequence'], [], 'stream frame')
    timestamp(item.observedAt, 'stream frame.observedAt')
    uint64String(item.throughSequence, 'stream frame.throughSequence')
    return value as DevStreamFrame
  }
  if (type === 'resync') {
    exactKeys(item, ['type', 'reason', 'checkpointSequence'], [], 'stream frame')
    literal(item.reason, ['sequence_gap', 'checkpoint_required'], 'stream frame.reason')
    uint64String(item.checkpointSequence, 'stream frame.checkpointSequence')
    return value as DevStreamFrame
  }
  if (type === 'error') {
    exactKeys(item, ['type', 'error'], [], 'stream frame')
    decodeError(item.error)
    return value as DevStreamFrame
  }
  if (type === 'close') {
    exactKeys(item, ['type', 'code'], ['reason'], 'stream frame')
    literal(
      item.code,
      ['normal', 'expired', 'revoked', 'stale_generation', 'backpressure', 'incompatible'],
      'stream frame.close'
    )
    if (item.reason !== undefined) stringValue(item.reason, 'stream frame.reason', 0, 256)
    return value as DevStreamFrame
  }
  fail('stream frame.type', 'unknown frame type')
}

export function decodeCapabilitySnapshot(value: unknown): CapabilitySnapshot {
  const snapshot = record(value, 'capability snapshot')
  exactKeys(
    snapshot,
    ['scope', 'granted', 'unavailable', 'channelGeneration', 'observedAt'],
    [],
    'capability snapshot'
  )
  decodeScope(snapshot.scope, 'capability snapshot.scope')
  if (!Array.isArray(snapshot.granted)) fail('capability snapshot.granted', 'expected array')
  snapshot.granted.forEach((capability, index) =>
    literal(capability, devCapabilityUniverse, `capability snapshot.granted[${index}]`)
  )
  if (!Array.isArray(snapshot.unavailable))
    fail('capability snapshot.unavailable', 'expected array')
  snapshot.unavailable.forEach((entry, index) => {
    const unavailable = record(entry, `capability snapshot.unavailable[${index}]`)
    exactKeys(
      unavailable,
      ['capability', 'reason'],
      [],
      `capability snapshot.unavailable[${index}]`
    )
    literal(
      unavailable.capability,
      devCapabilityUniverse,
      `capability snapshot.unavailable[${index}].capability`
    )
    literal(unavailable.reason, devErrorCodes, `capability snapshot.unavailable[${index}].reason`)
  })
  integerValue(snapshot.channelGeneration, 'capability snapshot.channelGeneration', 0)
  timestamp(snapshot.observedAt, 'capability snapshot.observedAt')
  return value as CapabilitySnapshot
}

// The full capability universe: every registry capability plus the two
// client-preference capabilities that dev.capability.snapshot reports.
const devCapabilityUniverse = Object.freeze([
  ...new Set([
    ...Object.values(devOperationDefinitions).flatMap((definition) => definition.capabilities),
    'dev.appearance.read',
    'dev.appLibrary.manage',
  ]),
])

/** Deterministic JSON with recursively sorted object keys (UTF-8). Byte
 *  body fields (`Uint8Array<=N` in the registry DSL) encode as the tagged
 *  lowercase-hex form `u8:<hex>` so a command that carries bytes proofs
 *  byte-identically on both sides of the channel. */
export function canonicalDevCommandJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (value instanceof Uint8Array) {
    let hex = ''
    for (const byte of value) hex += byte.toString(16).padStart(2, '0')
    return JSON.stringify(`u8:${hex}`)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalDevCommandJson).join(',')}]`
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (Object.getPrototypeOf(object) !== objectPrototype && Object.getPrototypeOf(object) !== null)
      fail('canonical json', 'expected a plain object')
    const keys = Object.keys(object).toSorted()
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalDevCommandJson(object[key])}`)
      .join(',')}}`
  }
  fail('canonical json', `cannot canonicalize ${typeof value}`)
}

function bindProofFields(parts: readonly string[]): string {
  // ASCII unit-separator framing: no bound field can contain a raw 0x1f
  // (JSON escapes control characters, and the rest are restricted alphabets).
  return parts.join('\u001f')
}

/**
 * The exact MAC input for an `AuthorizedDevFrame.proof`: binds channel,
 * client credential, operation, request id, nonce, the sorted capability set,
 * scope, resource/generation when present, issue/expiry times, idempotency
 * key, and the canonical command body.
 */
export function devCommandProofMessage(input: {
  channelId: string
  clientCredentialId: string
  command: DevCommand
}): string {
  const command = input.command
  return bindProofFields([
    'adea-dev-command-proof:v1',
    input.channelId,
    input.clientCredentialId,
    command.operation,
    command.requestId,
    command.nonce,
    canonicalDevCommandJson(command.capabilities.toSorted()),
    canonicalDevCommandJson(command.scope),
    command.resource ? canonicalDevCommandJson(command.resource) : '',
    command.issuedAt,
    command.expiresAt,
    command.idempotencyKey ?? '',
    canonicalDevCommandJson(command.body),
  ])
}

/** The exact MAC input minting/consuming a `DevStreamGrant`. */
export function devStreamGrantProofMessage(input: {
  clientCredentialId: string
  grant: DevStreamGrant
}): string {
  const grant = input.grant
  return bindProofFields([
    'adea-dev-stream-grant-proof:v1',
    input.clientCredentialId,
    grant.grantId,
    grant.channelId,
    grant.protocol,
    canonicalDevCommandJson(grant.scope),
    canonicalDevCommandJson(grant.resource),
    grant.direction,
    grant.fromSequence,
    grant.expiresAt,
    String(grant.maxFrameBytes),
  ])
}

/** The exact MAC input consuming a `DevStreamAttach`. */
export function devStreamAttachProofMessage(input: {
  channelId: string
  attach: DevStreamAttach
}): string {
  return bindProofFields([
    'adea-dev-stream-attach-proof:v1',
    input.channelId,
    input.attach.grantId,
    input.attach.requestId,
    input.attach.nonce,
    input.attach.fromSequence,
  ])
}

// ─── Canonical CBOR (RFC 8949 deterministic encoding subset) ────────────────
//
// Bulk-stream control frames are canonical CBOR with a 64 KiB maximum. This
// subset covers the frame vocabulary — unsigned/negative integers, floats,
// booleans, null, byte and text strings, arrays, and text-keyed maps — and
// refuses anything else (tags, indefinite lengths, non-shortest heads,
// duplicate or unsorted map keys) instead of guessing.

const cborEncoder = new TextEncoder()
const cborDecoder = new TextDecoder('utf-8', { fatal: true })

function cborHead(major: number, length: number | bigint): Uint8Array {
  const value = BigInt(length)
  const head: number[] = []
  let info: number
  let bytes: number[] = []
  if (value < 24n) info = Number(value)
  else if (value <= 0xffn) {
    info = 24
    bytes = [Number(value)]
  } else if (value <= 0xffffn) {
    info = 25
    for (let shift = 8; shift >= 0; shift -= 8) bytes.push(Number((value >> BigInt(shift)) & 0xffn))
  } else if (value <= 0xffff_ffffn) {
    info = 26
    for (let shift = 24; shift >= 0; shift -= 8)
      bytes.push(Number((value >> BigInt(shift)) & 0xffn))
  } else {
    info = 27
    for (let shift = 56; shift >= 0; shift -= 8)
      bytes.push(Number((value >> BigInt(shift)) & 0xffn))
  }
  head.push((major << 5) | info, ...bytes)
  return Uint8Array.from(head)
}

function shortestFloat(value: number): Uint8Array {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  for (const [head, write, read] of [
    [0xf9, 'setFloat16', 'getFloat16'],
    [0xfa, 'setFloat32', 'getFloat32'],
  ] as const) {
    view[write](0, value, false)
    if (view[read](0, false) === value) {
      const size = head === 0xf9 ? 2 : 4
      const out = new Uint8Array(1 + size)
      out[0] = head
      out.set(new Uint8Array(buffer, 0, size), 1)
      return out
    }
  }
  view.setFloat64(0, value, false)
  const out = new Uint8Array(9)
  out[0] = 0xfb
  out.set(new Uint8Array(buffer, 0, 8), 1)
  return out
}

export function encodeCbor(value: unknown): Uint8Array {
  const chunks: Uint8Array[] = []
  const encode = (input: unknown): void => {
    if (input === null) {
      chunks.push(Uint8Array.from([0xf6]))
      return
    }
    if (typeof input === 'boolean') {
      chunks.push(Uint8Array.from([input ? 0xf5 : 0xf4]))
      return
    }
    if (typeof input === 'bigint') {
      if (input >= 0n) chunks.push(cborHead(0, input))
      else chunks.push(cborHead(1, -1n - input))
      return
    }
    if (typeof input === 'number') {
      if (Number.isSafeInteger(input)) {
        if (input >= 0) chunks.push(cborHead(0, input))
        else chunks.push(cborHead(1, -1 - input))
        return
      }
      if (Number.isFinite(input)) {
        chunks.push(shortestFloat(input))
        return
      }
      fail('cbor', 'numbers must be finite')
    }
    if (typeof input === 'string') {
      const bytes = cborEncoder.encode(input)
      chunks.push(cborHead(3, bytes.byteLength), bytes)
      return
    }
    if (input instanceof Uint8Array) {
      chunks.push(cborHead(2, input.byteLength), input)
      return
    }
    if (Array.isArray(input)) {
      chunks.push(cborHead(4, input.length))
      for (const entry of input) encode(entry)
      return
    }
    if (typeof input === 'object') {
      if (Object.getPrototypeOf(input) !== objectPrototype && Object.getPrototypeOf(input) !== null)
        fail('cbor', 'expected a plain object')
      const entries = Object.entries(input as Record<string, unknown>)
      const encoded = entries
        .map(([key, entry]) => ({ key: encodeCbor(key), value: encodeCbor(entry) }))
        .toSorted((left, right) => {
          const shorter = Math.min(left.key.byteLength, right.key.byteLength)
          for (let index = 0; index < shorter; index += 1) {
            const delta = left.key[index]! - right.key[index]!
            if (delta !== 0) return delta
          }
          return left.key.byteLength - right.key.byteLength
        })
      chunks.push(cborHead(5, encoded.length))
      for (const entry of encoded) {
        chunks.push(entry.key, entry.value)
      }
      return
    }
    fail('cbor', `cannot encode ${typeof input}`)
  }
  encode(value)
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export function decodeCbor(bytes: Uint8Array): { value: unknown; byteLength: number } {
  let offset = 0
  const read = (count: number): bigint => {
    if (offset + count > bytes.byteLength) fail('cbor', 'truncated input')
    let value = 0n
    for (let index = 0; index < count; index += 1) value = (value << 8n) | BigInt(bytes[offset++]!)
    return value
  }
  const head = (): { major: number; value: bigint } => {
    if (offset >= bytes.byteLength) fail('cbor', 'truncated input')
    const first = bytes[offset++]!
    const major = first >> 5
    const info = first & 0x1f
    if (info < 24) return { major, value: BigInt(info) }
    if (info === 24) {
      const value = read(1)
      if (value < 24n) fail('cbor', 'non-shortest integer head')
      return { major, value }
    }
    if (info === 25) {
      const value = read(2)
      if (value < 256n) fail('cbor', 'non-shortest integer head')
      return { major, value }
    }
    if (info === 26) {
      const value = read(4)
      if (value < 65_536n) fail('cbor', 'non-shortest integer head')
      return { major, value }
    }
    if (info === 27) {
      const value = read(8)
      if (value < 4_294_967_296n) fail('cbor', 'non-shortest integer head')
      return { major, value }
    }
    fail('cbor', `unsupported additional information ${info}`)
  }
  const decode = (): unknown => {
    if (offset >= bytes.byteLength) fail('cbor', 'truncated input')
    const first = bytes[offset]!
    // Major 7's "value" is a simple value or raw float bits, not a
    // length, so the integer shortest-form rules do not apply to it.
    if (first >> 5 === 7) {
      offset += 1
      const info = first & 0x1f
      if (info === 20) return false
      if (info === 21) return true
      if (info === 22) return null
      if (info === 25 || info === 26 || info === 27) {
        const width = info === 25 ? 2 : info === 26 ? 4 : 8
        const bits = read(width)
        const scratch = new ArrayBuffer(8)
        const view = new DataView(scratch)
        for (let index = 0; index < width; index += 1)
          view.setUint8(index, Number((bits >> BigInt(8 * (width - 1 - index))) & 0xffn))
        const parsed =
          info === 25
            ? view.getFloat16(0, false)
            : info === 26
              ? view.getFloat32(0, false)
              : view.getFloat64(0, false)
        if (!Number.isFinite(parsed)) fail('cbor', 'floats must be finite')
        return parsed
      }
      fail('cbor', `unsupported simple value ${info}`)
    }
    const { major, value } = head()
    if (major === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) return value
      return Number(value)
    }
    if (major === 1) {
      const result = -1n - value
      return result >= BigInt(Number.MIN_SAFE_INTEGER) && result <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(result)
        : result
    }
    if (major === 2) {
      const length = Number(value)
      if (offset + length > bytes.byteLength) fail('cbor', 'truncated byte string')
      const out = bytes.slice(offset, offset + length)
      offset += length
      return out
    }
    if (major === 3) {
      const length = Number(value)
      if (offset + length > bytes.byteLength) fail('cbor', 'truncated text string')
      const slice = bytes.subarray(offset, offset + length)
      offset += length
      try {
        return cborDecoder.decode(slice)
      } catch {
        return fail('cbor', 'invalid UTF-8 text string')
      }
    }
    if (major === 4) {
      const length = Number(value)
      const out: unknown[] = []
      for (let index = 0; index < length; index += 1) out.push(decode())
      return out
    }
    if (major === 5) {
      const length = Number(value)
      const out: Record<string, unknown> = {}
      let previousKey: Uint8Array | undefined
      for (let index = 0; index < length; index += 1) {
        const keyStart = offset
        const key = decode()
        const keyBytes = bytes.slice(keyStart, offset)
        if (typeof key !== 'string') fail('cbor', 'map keys must be text strings')
        if (previousKey && compareBytes(previousKey, keyBytes) >= 0)
          fail('cbor', 'map keys are not canonically ordered')
        previousKey = keyBytes
        if (key in out) fail('cbor', 'duplicate map key')
        out[key] = decode()
      }
      return out
    }
    if (major === 6) fail('cbor', 'tags are not part of the frame vocabulary')
    return fail('cbor', `unsupported major type ${major}`)
  }
  const value = decode()
  return { value, byteLength: offset }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shorter = Math.min(left.byteLength, right.byteLength)
  for (let index = 0; index < shorter; index += 1) {
    const delta = left[index]! - right[index]!
    if (delta !== 0) return delta
  }
  return left.byteLength - right.byteLength
}
