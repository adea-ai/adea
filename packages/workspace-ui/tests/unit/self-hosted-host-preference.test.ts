import { describe, expect, test } from 'bun:test'

import {
  SELF_HOSTED_HOST_PREFERENCE_QUARANTINE_KEY,
  SELF_HOSTED_HOST_PREFERENCE_STORAGE_KEY,
  readSelfHostedHostPreference,
  selfHostedHostScopeKey,
  writeSelfHostedHostPreference,
} from '../../src/self-hosted-host-preference'

const ALICE = { accountId: 'account-alice', workspaceId: 'workspace-one' }
const BOB = { accountId: 'account-bob', workspaceId: 'workspace-one' }
const OTHER_WORKSPACE = { accountId: 'account-alice', workspaceId: 'workspace-two' }

function memoryStorage(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value)
    },
    removeItem: (key: string) => {
      items.delete(key)
    },
    items,
  }
}

describe('self-hosted host choice preference', () => {
  test('records and reads the chosen host for one scope', () => {
    const storage = memoryStorage()
    expect(readSelfHostedHostPreference(storage, ALICE)).toBeUndefined()
    writeSelfHostedHostPreference(storage, ALICE, 'host-1')
    expect(readSelfHostedHostPreference(storage, ALICE)).toBe('host-1')
  })

  test('one scope never sees another scope’s choice', () => {
    const storage = memoryStorage()
    writeSelfHostedHostPreference(storage, ALICE, 'host-1')
    expect(readSelfHostedHostPreference(storage, BOB)).toBeUndefined()
    expect(readSelfHostedHostPreference(storage, OTHER_WORKSPACE)).toBeUndefined()
    expect(selfHostedHostScopeKey(ALICE)).not.toBe(selfHostedHostScopeKey(BOB))
  })

  test('clearing a choice leaves the other scopes alone', () => {
    const storage = memoryStorage()
    writeSelfHostedHostPreference(storage, ALICE, 'host-1')
    writeSelfHostedHostPreference(storage, BOB, 'host-2')
    writeSelfHostedHostPreference(storage, ALICE, undefined)
    expect(readSelfHostedHostPreference(storage, ALICE)).toBeUndefined()
    expect(readSelfHostedHostPreference(storage, BOB)).toBe('host-2')
  })

  test('a malformed record is quarantined, not discarded, and reads as no choice', () => {
    const storage = memoryStorage({ [SELF_HOSTED_HOST_PREFERENCE_STORAGE_KEY]: '{not json' })
    expect(readSelfHostedHostPreference(storage, ALICE)).toBeUndefined()
    expect(storage.items.get(SELF_HOSTED_HOST_PREFERENCE_QUARANTINE_KEY)).toBe('{not json')
  })

  test('a record from an unknown version is ignored', () => {
    const storage = memoryStorage({
      [SELF_HOSTED_HOST_PREFERENCE_STORAGE_KEY]: JSON.stringify({ version: 2, chosen: {} }),
    })
    expect(readSelfHostedHostPreference(storage, ALICE)).toBeUndefined()
  })

  test('a record that is not an object is ignored', () => {
    const storage = memoryStorage({
      [SELF_HOSTED_HOST_PREFERENCE_STORAGE_KEY]: JSON.stringify(['host-1']),
    })
    expect(readSelfHostedHostPreference(storage, ALICE)).toBeUndefined()
  })

  test('a storage failure never throws and never reports a choice', () => {
    const broken = {
      getItem: () => {
        throw new Error('storage is unavailable')
      },
      setItem: () => {
        throw new Error('storage is unavailable')
      },
      removeItem: () => {
        throw new Error('storage is unavailable')
      },
    }
    expect(readSelfHostedHostPreference(broken, ALICE)).toBeUndefined()
    expect(() => writeSelfHostedHostPreference(broken, ALICE, 'host-1')).not.toThrow()
  })

  test('no storage at all is not a choice', () => {
    expect(readSelfHostedHostPreference(undefined, ALICE)).toBeUndefined()
    expect(() => writeSelfHostedHostPreference(undefined, ALICE, 'host-1')).not.toThrow()
  })
})
