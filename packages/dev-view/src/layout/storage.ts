import type {
  DevLayoutPreferencesV2,
  DevUtilityPane,
  DevUtilityPreference,
  Scope,
} from '@adea-ai/types/dev-runtime'

import {
  decodeLayoutDocument,
  layoutStorageKey,
  layoutStorageKeyV2,
  serializeLayoutPreferencesV2,
} from './persistence'
import { pendingLayoutJournalPrefixV2 } from './storage-keys'

export type LayoutStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>

export type PendingLayoutPatch = Readonly<{
  utility?: Partial<
    Record<
      DevUtilityPane,
      Partial<
        Pick<
          DevUtilityPreference,
          'visible' | 'size' | 'lastNonzeroSize' | 'fullWidth' | 'order' | 'side'
        >
      >
    >
  >
  layout?: Pick<DevLayoutPreferencesV2, 'center' | 'focusMode' | 'focusTargetId'>
}>

export type PendingLayoutPatchJournal = Readonly<{
  key: string
  raw: string
  patch: PendingLayoutPatch
}>

const pendingJournalVersion = 1
const allowedUtilityFields = new Set([
  'visible',
  'size',
  'lastNonzeroSize',
  'fullWidth',
  'order',
  'side',
])
const allowedLayoutFields = new Set(['center', 'focusMode', 'focusTargetId'])
const utilityPanes = new Set<DevUtilityPane>([
  'files',
  'source_control',
  'browser',
  'devices',
  'agents',
  'history',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value)
}

function matchesIdentity(
  value: DevLayoutPreferencesV2,
  scope: Scope,
  projectId: string,
  runtimeSessionId: string
) {
  return (
    value.scope.accountId === scope.accountId &&
    value.scope.workspaceId === scope.workspaceId &&
    value.scope.runtimeNodeId === scope.runtimeNodeId &&
    value.projectId === projectId &&
    value.runtimeSessionId === runtimeSessionId
  )
}

function retainUnread(storage: LayoutStorage, key: string, raw: string) {
  try {
    const unreadKey = `${key}:unread`
    if (storage.getItem(unreadKey) === null) storage.setItem(unreadKey, raw)
  } catch {
    // Preserve the journal in place when recovery storage is unavailable.
  }
}

function decodePendingLayoutPatchJournal(
  raw: string,
  scope: Scope,
  projectId: string,
  runtimeSessionId: string
): PendingLayoutPatch | undefined {
  let envelope: unknown
  try {
    envelope = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (
    !isRecord(envelope) ||
    !hasExactKeys(envelope, [
      'version',
      'scope',
      'projectId',
      'runtimeSessionId',
      'utilityFields',
      'layoutFields',
      'document',
    ]) ||
    envelope.version !== pendingJournalVersion ||
    !isRecord(envelope.scope) ||
    !hasExactKeys(envelope.scope, ['accountId', 'workspaceId', 'runtimeNodeId']) ||
    envelope.scope.accountId !== scope.accountId ||
    envelope.scope.workspaceId !== scope.workspaceId ||
    envelope.scope.runtimeNodeId !== scope.runtimeNodeId ||
    envelope.projectId !== projectId ||
    envelope.runtimeSessionId !== runtimeSessionId ||
    !isRecord(envelope.document)
  )
    return undefined

  const decoded = decodeLayoutDocument(JSON.stringify(envelope.document))
  if (
    decoded.state !== 'ready' ||
    !matchesIdentity(decoded.value, scope, projectId, runtimeSessionId)
  )
    return undefined

  if (!isRecord(envelope.utilityFields) || !Array.isArray(envelope.layoutFields)) return undefined
  const utility: NonNullable<PendingLayoutPatch['utility']> = {}
  for (const [pane, fieldList] of Object.entries(envelope.utilityFields)) {
    if (!utilityPanes.has(pane as DevUtilityPane) || !Array.isArray(fieldList)) return undefined
    const item = decoded.value.utility.find((candidate) => candidate.pane === pane)
    if (!item) return undefined
    const fields: Record<string, unknown> = {}
    const seenFields = new Set<string>()
    for (const field of fieldList) {
      if (typeof field !== 'string' || !allowedUtilityFields.has(field) || seenFields.has(field))
        return undefined
      seenFields.add(field)
      fields[field] = item[field as keyof DevUtilityPreference]
    }
    if (seenFields.size === 0) return undefined
    utility[pane as DevUtilityPane] = fields as NonNullable<
      PendingLayoutPatch['utility']
    >[DevUtilityPane]
  }

  const layoutFields = envelope.layoutFields
  const seenLayoutFields = new Set<string>()
  if (
    layoutFields.some((field) => {
      if (
        typeof field !== 'string' ||
        !allowedLayoutFields.has(field) ||
        seenLayoutFields.has(field)
      )
        return true
      seenLayoutFields.add(field)
      return false
    })
  )
    return undefined
  const layout: Record<string, unknown> = {}
  for (const field of layoutFields as string[]) {
    if (field === 'center') layout.center = decoded.value.center
    if (field === 'focusMode') layout.focusMode = decoded.value.focusMode
    if (field === 'focusTargetId') layout.focusTargetId = decoded.value.focusTargetId
  }

  if (Object.keys(utility).length === 0 && Object.keys(layout).length === 0) return undefined
  return {
    ...(Object.keys(utility).length > 0 ? { utility } : {}),
    ...(Object.keys(layout).length > 0
      ? { layout: layout as NonNullable<PendingLayoutPatch['layout']> }
      : {}),
  }
}

export function readPendingLayoutPatchJournals(
  storage: LayoutStorage,
  scope: Scope,
  projectId: string,
  runtimeSessionId: string
): PendingLayoutPatchJournal[] {
  const prefix = pendingLayoutJournalPrefixV2(scope, projectId, runtimeSessionId)
  const entries: PendingLayoutPatchJournal[] = []
  let length = 0
  try {
    length = storage.length
  } catch {
    return entries
  }
  for (let index = 0; index < length; index += 1) {
    let key: string | null
    try {
      key = storage.key(index)
    } catch {
      continue
    }
    if (!key?.startsWith(prefix) || key.endsWith(':unread')) continue
    let raw: string | null
    try {
      raw = storage.getItem(key)
    } catch {
      continue
    }
    if (raw === null) continue
    const patch = decodePendingLayoutPatchJournal(raw, scope, projectId, runtimeSessionId)
    if (!patch) {
      retainUnread(storage, key, raw)
      continue
    }
    entries.push({ key, raw, patch })
  }
  return entries.toSorted((left, right) => left.key.localeCompare(right.key))
}

export type LayoutLoadResult =
  | Readonly<{ state: 'empty' }>
  | Readonly<{ state: 'ready'; value: DevLayoutPreferencesV2; migrated: boolean }>
  | Readonly<{ state: 'corrupt'; raw: string }>
  | Readonly<{ state: 'unsupported'; raw: string }>

/**
 * Owns the session-scoped V2 layout document. The #447 V1 value is readable
 * only for migration; corrupt and future values are retained under an unread
 * recovery key and never silently overwritten. Storage failures (quota,
 * unavailability) never crash the shell: the pending write is retried on the
 * next schedule/flush.
 */
export function createLayoutStorageController(options: {
  storage: LayoutStorage
  scope: Scope
  projectId: string
  runtimeSessionId: string
  debounceMs?: number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  onCommit?: (value: DevLayoutPreferencesV2) => boolean | void
  onWriteFailure?: () => void
}) {
  const key = layoutStorageKeyV2(options.scope, options.projectId, options.runtimeSessionId)
  const legacyKey = layoutStorageKey(options.scope, options.projectId, options.runtimeSessionId)
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const debounceMs = options.debounceMs ?? 250
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: DevLayoutPreferencesV2 | undefined
  let committedForCleanup: DevLayoutPreferencesV2 | undefined
  let unread: string | undefined

  const matchesControllerScope = (value: DevLayoutPreferencesV2) =>
    value.scope.accountId === options.scope.accountId &&
    value.scope.workspaceId === options.scope.workspaceId &&
    value.scope.runtimeNodeId === options.scope.runtimeNodeId &&
    value.projectId === options.projectId &&
    value.runtimeSessionId === options.runtimeSessionId

  const rememberUnread = (raw: string) => {
    unread = raw
  }

  /** Writes V2 first and removes the V1 original only after it commits. */
  const commitMigration = (value: DevLayoutPreferencesV2) => {
    try {
      options.storage.setItem(key, serializeLayoutPreferencesV2(value))
      options.storage.removeItem(legacyKey)
    } catch {
      // Quota or storage loss keeps the V1 original in place for a retry.
    }
  }

  /** Storage can be denied by privacy settings; an unreadable store is empty. */
  const readStorage = (storageKey: string): string | null => {
    try {
      return options.storage.getItem(storageKey)
    } catch {
      return null
    }
  }

  const reportWriteFailure = () => {
    try {
      options.onWriteFailure?.()
    } catch {
      // Status reporting cannot turn a storage failure into a shell crash.
    }
  }

  const load = (): LayoutLoadResult => {
    const raw = readStorage(key)
    if (raw === null) {
      const legacy = readStorage(legacyKey)
      if (legacy === null) return { state: 'empty' }
      const result = decodeLayoutDocument(legacy)
      if (result.state !== 'ready') {
        rememberUnread(legacy)
        return { state: result.state, raw: legacy }
      }
      if (!matchesControllerScope(result.value)) {
        rememberUnread(legacy)
        return { state: 'corrupt', raw: legacy }
      }
      commitMigration(result.value)
      return result
    }
    const result = decodeLayoutDocument(raw)
    if (result.state === 'ready' && !matchesControllerScope(result.value)) {
      rememberUnread(raw)
      return { state: 'corrupt', raw }
    }
    if (result.state !== 'ready') rememberUnread(raw)
    return result
  }

  const flush = () => {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    if (!pending) {
      if (!committedForCleanup) return false
      try {
        const complete = options.onCommit?.(committedForCleanup) !== false
        if (complete) {
          committedForCleanup = undefined
          return true
        }
        reportWriteFailure()
        return false
      } catch {
        reportWriteFailure()
        return false
      }
    }
    const committed = pending
    try {
      if (unread !== undefined) {
        options.storage.setItem(`${key}:unread`, unread)
        unread = undefined
      }
      options.storage.setItem(key, serializeLayoutPreferencesV2(pending))
      options.storage.removeItem(legacyKey)
      pending = undefined
      if (options.onCommit?.(committed) === false) {
        committedForCleanup = committed
        reportWriteFailure()
        return false
      }
      return true
    } catch {
      // Quota exceeded or storage unavailable: keep the pending document so a
      // later visibility change or write retries instead of losing state.
      reportWriteFailure()
      return false
    }
  }

  const schedule = (value: DevLayoutPreferencesV2) => {
    if (!matchesControllerScope(value))
      throw new TypeError('scope_mismatch: layout preferences belong to another scope')
    pending = value
    if (timer !== undefined) clearTimer(timer)
    timer = setTimer(flush, debounceMs)
  }

  return {
    key,
    legacyKey,
    load,
    schedule,
    flush,
    visibilityChanged: (hidden: boolean) => {
      if (hidden) flush()
    },
    dispose: flush,
  }
}
