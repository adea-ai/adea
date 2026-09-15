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
  debounceMs?: number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}) {
  const key = layoutStorageKey(options.scope, options.projectId)
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const debounceMs = options.debounceMs ?? 250
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: DevLayoutPreferencesV1 | undefined
  let unread: string | undefined

  const load = (): LayoutDecodeResult | undefined => {
    const raw = options.storage.getItem(key)
    if (raw === null) return undefined
    const result = decodeLayoutPreferences(raw)
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
