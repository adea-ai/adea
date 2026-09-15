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
export type DevCapability = (typeof devOperationDefinitions)[DevOperation]['capabilities'][number]
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

export type DevLayoutPreferencesV1 = Readonly<{
  schemaVersion: 1
  scope: Scope
  projectId: string
  runtimeSessionId: string
  center: PaneNode
  utility: readonly Readonly<{
    pane: 'files' | 'source_control' | 'browser' | 'devices' | 'agents' | 'history'
    side: 'left' | 'right'
    visible: boolean
    size: number
    lastNonzeroSize: number
  }>[]
  focusMode: boolean
  focusTargetId?: string
}>

export type RuntimeSession = Readonly<{
  id: string
  scope: Scope
  projectId: string
  repoId: string
  worktreeId: string
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
  projectIds: readonly string[]
  sortKey: string
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
  if (name === "DeviceSession['kind']")
    return literal(value, ['responsive', 'ios_simulator', 'android_emulator', 'physical'], path)
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

export function decodeRuntimeEvent(value: unknown): RuntimeEvent {
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
  literal(
    item.confidence,
    ['authoritative', 'bounded_projection', 'untrusted_hint'],
    'event.confidence'
  )
  literal(item.classification, dataClassifications, 'event.classification')
  literal(item.kind, runtimeEventKinds, 'event.kind')
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
    fail(
      'reply.value',
      'success DTO decoder is unavailable until the operation-owning provider slice installs it'
    )
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
