import type { DevLayoutPreferencesV2, Scope } from '@adea-ai/types/dev-runtime'

import {
  decodeLayoutDocument,
  layoutStorageKey,
  layoutStorageKeyV2,
  serializeLayoutPreferencesV2,
} from './persistence'

export type LayoutStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

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
}) {
  const key = layoutStorageKeyV2(options.scope, options.projectId, options.runtimeSessionId)
  const legacyKey = layoutStorageKey(options.scope, options.projectId, options.runtimeSessionId)
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const debounceMs = options.debounceMs ?? 250
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: DevLayoutPreferencesV2 | undefined
  let unread: string | undefined

  const matchesControllerScope = (value: DevLayoutPreferencesV2) =>
    value.scope.accountId === options.scope.accountId &&
    value.scope.workspaceId === options.scope.workspaceId &&
    value.scope.runtimeNodeId === options.scope.runtimeNodeId &&
    value.projectId === options.projectId &&
    value.runtimeSessionId === options.runtimeSessionId

  const retainUnread = (raw: string) => {
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

  const load = (): LayoutLoadResult => {
    const raw = readStorage(key)
    if (raw === null) {
      const legacy = readStorage(legacyKey)
      if (legacy === null) return { state: 'empty' }
      const result = decodeLayoutDocument(legacy)
      if (result.state !== 'ready') {
        retainUnread(legacy)
        return { state: result.state, raw: legacy }
      }
      if (!matchesControllerScope(result.value)) {
        retainUnread(legacy)
        return { state: 'corrupt', raw: legacy }
      }
      commitMigration(result.value)
      return result
    }
    const result = decodeLayoutDocument(raw)
    if (result.state === 'ready' && !matchesControllerScope(result.value)) {
      retainUnread(raw)
      return { state: 'corrupt', raw }
    }
    if (result.state !== 'ready') retainUnread(raw)
    return result
  }

  const flush = () => {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    if (!pending) return
    try {
      if (unread !== undefined) {
        options.storage.setItem(`${key}:unread`, unread)
        unread = undefined
      }
      options.storage.setItem(key, serializeLayoutPreferencesV2(pending))
      options.storage.removeItem(legacyKey)
      pending = undefined
    } catch {
      // Quota exceeded or storage unavailable: keep the pending document so a
      // later visibility change or write retries instead of losing state.
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
