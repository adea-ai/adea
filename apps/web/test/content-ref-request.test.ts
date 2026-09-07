import { describe, expect, test } from 'bun:test'

import {
  parseContentRefCreateInput,
  parseContentRefUpdateInput,
} from '../src/server/content-ref-input'

describe('ContentRef request boundary', () => {
  test('accepts bounded metadata and rejects plaintext or physical-store fields', () => {
    const metadata = {
      availability: 'missing',
      contentType: 'message_body',
      digestSha256: 'a'.repeat(64),
      id: '10000000-0000-4000-8000-000000000001',
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'restricted',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'local_only',
    }
    expect(parseContentRefCreateInput(metadata)).toEqual(metadata)
    for (const forbidden of ['ciphertext', 'databasePath', 'masterKey', 'nonce', 'plaintext'])
      expect(parseContentRefCreateInput({ ...metadata, [forbidden]: 'canary' })).toBeNull()
  })

  test('requires complete optimistic revision metadata', () => {
    const update = {
      availability: 'available',
      digestSha256: 'b'.repeat(64),
      expectedRevision: 1,
      keyVersion: 1,
      revision: 1,
    }
    expect(parseContentRefUpdateInput(update)).toEqual(update)
    expect(parseContentRefUpdateInput({ ...update, revision: 3 })).toBeNull()
    expect(parseContentRefUpdateInput({ ...update, plaintext: 'canary' })).toBeNull()
  })
})
