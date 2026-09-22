import { describe, expect, test } from 'bun:test'

import { parseContentReplicaUpsertInput } from '../src/server/content-replica-input'

const base = {
  availability: 'available',
  ciphertext: 'ZW5jcnlwdGVkLWJvZHk',
  digestSha256: 'a'.repeat(64),
  nonce: 'A'.repeat(16),
  replicaKind: 'local_authority',
  revision: 1,
  schemaVersion: 1,
}

describe('ContentReplica request boundary', () => {
  test('accepts opaque authority ciphertext and rejects plaintext-shaped fields', () => {
    expect(parseContentReplicaUpsertInput(base)).toEqual(base)
    for (const forbidden of ['content', 'databasePath', 'masterKey', 'plaintext'])
      expect(parseContentReplicaUpsertInput({ ...base, [forbidden]: 'canary' })).toBeNull()
  })

  test('requires an epoch for E2E replicas and forbids it for authority replicas', () => {
    const keyEpochId = '10000000-0000-4000-8000-000000000001'
    expect(
      parseContentReplicaUpsertInput({ ...base, keyEpochId, replicaKind: 'agent_hq_e2ee_sync' })
    ).toMatchObject({ keyEpochId, replicaKind: 'agent_hq_e2ee_sync' })
    expect(
      parseContentReplicaUpsertInput({ ...base, keyEpochId, replicaKind: 'local_authority' })
    ).toBeNull()
    expect(
      parseContentReplicaUpsertInput({ ...base, replicaKind: 'agent_hq_e2ee_sync' })
    ).toBeNull()
  })

  test('rejects malformed nonce, digest, and unbounded ciphertext', () => {
    expect(parseContentReplicaUpsertInput({ ...base, nonce: 'short' })).toBeNull()
    expect(parseContentReplicaUpsertInput({ ...base, digestSha256: 'not-a-digest' })).toBeNull()
    expect(parseContentReplicaUpsertInput({ ...base, ciphertext: 'contains plaintext' })).toBeNull()
  })
})
