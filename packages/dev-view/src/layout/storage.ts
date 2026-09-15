import type { DevLayoutPreferencesV1, Scope } from '@adea-ai/types/dev-runtime'

import {
  decodeLayoutPreferences,
  layoutStorageKey,
  serializeLayoutPreferences,
  type LayoutDecodeResult,
} from './persistence'

export type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>

export function createLayoutStorageController(options: {
  storage: LayoutStorage
  scope: Scope
  projectId: string
  runtimeSessionId: string
  debounceMs?: number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}) {
  const key = layoutStorageKey(options.scope, options.projectId, options.runtimeSessionId)
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const debounceMs = options.debounceMs ?? 250
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: DevLayoutPreferencesV1 | undefined
  let unread: string | undefined

  const matchesControllerScope = (value: DevLayoutPreferencesV1) =>
    value.scope.accountId === options.scope.accountId &&
    value.scope.workspaceId === options.scope.workspaceId &&
    value.scope.runtimeNodeId === options.scope.runtimeNodeId &&
    value.projectId === options.projectId &&
    value.runtimeSessionId === options.runtimeSessionId

  const load = (): LayoutDecodeResult | undefined => {
    const raw = options.storage.getItem(key)
    if (raw === null) return undefined
    const result = decodeLayoutPreferences(raw)
    if (result.state === 'ready' && !matchesControllerScope(result.value)) {
      unread = raw
      return { state: 'corrupt', raw }
    }
    if (result.state !== 'ready') unread = result.raw
    return result
  }

  const flush = () => {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    if (!pending) return
    if (unread !== undefined) {
      options.storage.setItem(`${key}:unread`, unread)
      unread = undefined
    }
    options.storage.setItem(key, serializeLayoutPreferences(pending))
    pending = undefined
  }

  const schedule = (value: DevLayoutPreferencesV1) => {
    if (!matchesControllerScope(value))
      throw new TypeError('scope_mismatch: layout preferences belong to another scope')
    pending = value
    if (timer !== undefined) clearTimer(timer)
    timer = setTimer(flush, debounceMs)
  }

  return {
    key,
    load,
    schedule,
    flush,
    visibilityChanged: (hidden: boolean) => {
      if (hidden) flush()
    },
    dispose: flush,
  }
}
