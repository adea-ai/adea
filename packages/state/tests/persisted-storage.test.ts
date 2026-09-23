// The browser-persistence boundary (#302 audit): one discipline for six storage
// keys. A parse failure is corruption (quarantined, never deleted), a validation
// failure is stale (dropped silently), and unavailable storage is best-effort.
import { expect, test } from 'bun:test'

import { browserStorage, readPersisted, writePersisted, type PersistedStorage } from '../src'

/** The key corrupt text is preserved under (the boundary's own convention). */
const quarantineKeyFor = (key: string) => `${key}:quarantine:v1`

function memoryStorage(initial: Record<string, string> = {}): PersistedStorage & {
  entries: () => Record<string, string>
} {
  const entries: Record<string, string> = { ...initial }
  return {
    getItem: (key) => entries[key] ?? null,
    setItem: (key, value) => {
      entries[key] = value
    },
    removeItem: (key) => {
      delete entries[key]
    },
    entries: () => ({ ...entries }),
  }
}

const KEY = 'adea:test:v1'
const always = (parsed: unknown) => parsed as { value: number }

test('without a DOM the guarded accessor yields no storage at all', () => {
  // bun test runs without `window`; reading `window.localStorage` directly
  // would throw, which is why callers use this accessor.
  expect(browserStorage()).toBeUndefined()
})

test('a missing key and an absent storage both read as nothing persisted', () => {
  expect(readPersisted(memoryStorage(), KEY, always)).toEqual({ quarantined: false })
  expect(readPersisted(undefined, KEY, always)).toEqual({ quarantined: false })
})

test('a valid value is parsed and validated', () => {
  const storage = memoryStorage({ [KEY]: JSON.stringify({ value: 7 }) })
  expect(readPersisted(storage, KEY, always)).toEqual({ value: { value: 7 }, quarantined: false })
})

test('malformed text is quarantined byte-for-byte, never deleted', () => {
  const corrupt = '{"value": 7'
  const storage = memoryStorage({ [KEY]: corrupt })
  const result = readPersisted(storage, KEY, always)
  expect(result.quarantined).toBe(true)
  expect(result.value).toBeUndefined()
  // The original bytes survive under the quarantine key AND the original key is
  // left alone: recovery is manual, not destructive.
  expect(storage.entries()[quarantineKeyFor(KEY)]).toBe(corrupt)
  expect(storage.entries()[KEY]).toBe(corrupt)
})

test('a rejected shape is stale, not corrupt: dropped without quarantining', () => {
  const storage = memoryStorage({ [KEY]: JSON.stringify({ value: 'not-a-number' }) })
  const result = readPersisted(storage, KEY, (_parsed) => undefined)
  expect(result).toEqual({ quarantined: false })
  expect(storage.entries()[quarantineKeyFor(KEY)]).toBeUndefined()
})

test('a validator that throws fails closed instead of breaking the surface', () => {
  const storage = memoryStorage({ [KEY]: JSON.stringify({ value: 1 }) })
  const result = readPersisted(storage, KEY, () => {
    throw new Error('validator bug')
  })
  expect(result).toEqual({ quarantined: false })
})

test('storage that throws on read or write degrades to nothing persisted', () => {
  const hostile: PersistedStorage = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
    removeItem: () => undefined,
  }
  expect(readPersisted(hostile, KEY, always)).toEqual({ quarantined: false })
  expect(writePersisted(hostile, KEY, { value: 1 })).toBe(false)

  const readOnly = memoryStorage()
  expect(writePersisted(readOnly, KEY, { value: 1 })).toBe(true)
  expect(readOnly.entries()[KEY]).toBe('{"value":1}')
})
