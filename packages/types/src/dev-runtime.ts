import {
  devOperationDefinitions,
  devOperations,
  devRuntimeTransportMethods,
  devStreamProtocolDefinitions,
} from './dev-runtime-registry'

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
  preferredRuntimeNodeId?: string
  defaultBaseRef?: string
  bootstrapWorkflowId?: string
  defaultHarnessId?: string
  lifecycle: 'importing' | 'cloning' | 'scanning' | 'ready' | 'archived' | 'failed'
  version: number
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
    else if (character === '<') angles += 1
    else if (character === '>') angles -= 1
    else if (
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

function namedType(name: string, value: unknown, path: string): unknown {
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
        'contentType',
        'byteLength',
        'width',
        'height',
        'sha256',
        'expiresAt',
      ],
      [],
      path
    )
    if (!uuidPattern.test(stringValue(item.id, `${path}.id`)))
      fail(`${path}.id`, 'expected lowercase UUID')
    decodeScope(item.scope, `${path}.scope`)
    stringValue(item.ownerId, `${path}.ownerId`, 1, 256)
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
  if (name === 'MutationPlan') return decodeMutationPlan(value)
  if (name === 'CleanupBlocker') return decodeCleanupBlocker(value, path)
  if (name === "DeviceSession['kind']")
    return literal(value, ['responsive', 'ios_simulator', 'android_emulator', 'physical'], path)
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
    if (
      relative.includes('\0') ||
      relative.includes('\\') ||
      relative.startsWith('/') ||
      /^[A-Za-z]:/.test(relative) ||
      relative.split('/').some((part) => !part || part === '.' || part === '..')
    )
      fail(`${path}.relativePath`, 'expected normalized relative path')
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
    literal(item.state, ['creating', 'running', 'detached', 'terminating', 'exited'], `${path}.state`)
    literal(item.health, ['healthy', 'degraded', 'replay_required', 'faulted'], `${path}.health`)
    uint64String(item.lastSeq, `${path}.lastSeq`)
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
  'dev.project.bookmarks': (value) => decodeDevRuntimePage(decodeRootBookmark, value),
  'dev.repo.credentialRefs': (value) => decodeDevRuntimePage(decodeCredentialRef, value),
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

/** Deterministic JSON with recursively sorted object keys (UTF-8). */
export function canonicalDevCommandJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
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
