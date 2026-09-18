import { describe, expect, test } from 'bun:test'

import {
  defaultRailPreferences,
  normalizeRailPreferences,
  railItemsForViews,
  readRailPreferences,
  reorderRailItems,
  resolveRailItems,
  setRailItemHidden,
  writeRailPreferences,
  type RailItem,
} from '../../src/rail-preferences'

const items: readonly RailItem[] = [
  ...railItemsForViews(['virtual', 'chat', 'dev']),
  { id: 'app:roadmap', label: 'Roadmap', kind: 'optional-app' },
]

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
  }
}

describe('rail preferences', () => {
  test('defaults keep the canonical core-view order and hide nothing', () => {
    expect(defaultRailPreferences).toEqual({
      version: 1,
      order: ['virtual', 'chat', 'dev'],
      hidden: [],
    })
    expect(resolveRailItems(defaultRailPreferences, items).map((item) => item.id)).toEqual([
      'virtual',
      'chat',
      'dev',
      'app:roadmap',
    ])
  })

  test('ordering follows the stored order with unrecorded items appended', () => {
    const resolved = resolveRailItems(
      { version: 1, order: ['dev', 'chat', 'virtual'], hidden: [] },
      items
    )
    expect(resolved.map((item) => item.id)).toEqual(['dev', 'chat', 'virtual', 'app:roadmap'])
  })

  test('unknown contributions preserved in the record keep their position', () => {
    const resolved = resolveRailItems(
      { version: 1, order: ['chat', 'app:future', 'dev'], hidden: [] },
      railItemsForViews(['virtual', 'chat', 'dev'])
    )
    expect(resolved.map((item) => item.id)).toEqual(['chat', 'dev', 'virtual'])
  })

  test('hidden items drop out, but the active view never disappears', () => {
    const hidden = setRailItemHidden(defaultRailPreferences, 'chat', true)
    expect(resolveRailItems(hidden, items, 'dev').map((item) => item.id)).toEqual([
      'virtual',
      'dev',
      'app:roadmap',
    ])
    // Chat is active: it stays visible despite being hidden.
    expect(resolveRailItems(hidden, items, 'chat').map((item) => item.id)).toContain('chat')
  })

  test('reorder swaps neighbors and preserves unknown trailing ids', () => {
    const preferences = {
      version: 1 as const,
      order: ['virtual', 'chat', 'dev', 'app:future'],
      hidden: [] as readonly string[],
    }
    expect(reorderRailItems(preferences, 'dev', 'up').order).toEqual([
      'virtual',
      'dev',
      'chat',
      'app:future',
    ])
    expect(reorderRailItems(preferences, 'virtual', 'up')).toBe(preferences)
    expect(reorderRailItems(preferences, 'missing', 'up')).toBe(preferences)
  })

  test('hide toggles are idempotent and reversible', () => {
    const hidden = setRailItemHidden(defaultRailPreferences, 'dev', true)
    expect(setRailItemHidden(hidden, 'dev', true).hidden).toEqual(['dev'])
    expect(setRailItemHidden(hidden, 'dev', false)).toEqual(defaultRailPreferences)
  })

  test('malformed records fall back to the defaults and retain the raw value', () => {
    for (const raw of [undefined, null, 'json', { version: 2 }, { version: 1, order: 'x' }]) {
      const normalized = normalizeRailPreferences(raw)
      expect(normalized.value).toEqual(defaultRailPreferences)
      if (raw !== undefined && raw !== null) expect(normalized.retainedRaw).toEqual(raw)
    }
  })

  test('a record missing a core id is completed, never truncated', () => {
    const normalized = normalizeRailPreferences({ version: 1, order: ['dev'], hidden: [] })
    expect(normalized.value.order).toEqual(['dev', 'virtual', 'chat'])
  })

  test('storage round-trips and a blocked or corrupt store degrades to defaults', () => {
    const storage = memoryStorage()
    writeRailPreferences(storage, setRailItemHidden(defaultRailPreferences, 'dev', true))
    expect(readRailPreferences(storage).hidden).toEqual(['dev'])
    expect(readRailPreferences(memoryStorage({ 'adea:rail-preferences:v1': '{oops' }))).toEqual(
      defaultRailPreferences
    )
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readRailPreferences(blocked)).toEqual(defaultRailPreferences)
    expect(() => writeRailPreferences(blocked, defaultRailPreferences)).not.toThrow()
  })
})
