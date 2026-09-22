import { describe, expect, test } from 'bun:test'

import {
  CONTENT_REPLICA_MAX_REQUEST_BYTES,
  readContentReplicaRequest,
} from '../src/server/content-replica-body'
import { parseContentReplicaUpsertInput } from '../src/server/content-replica-input'
import { classifyContentReplicaError } from '../src/server/content-replica-error-classification'

const base = {
  availability: 'available',
  ciphertext: 'ZW5jcnlwdGVkLWJvZHktd2l0aC10YWc',
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

  test('rejects malformed nonce, digest, canonical encoding, and unbounded ciphertext', () => {
    expect(parseContentReplicaUpsertInput({ ...base, nonce: 'short' })).toBeNull()
    expect(parseContentReplicaUpsertInput({ ...base, digestSha256: 'not-a-digest' })).toBeNull()
    expect(parseContentReplicaUpsertInput({ ...base, ciphertext: 'contains plaintext' })).toBeNull()
    expect(parseContentReplicaUpsertInput({ ...base, ciphertext: 'A' })).toBeNull()
    expect(parseContentReplicaUpsertInput({ ...base, ciphertext: `${'A'.repeat(21)}B` })).toBeNull()
    expect(
      parseContentReplicaUpsertInput({ ...base, ciphertext: 'A'.repeat(10 * 1024 * 1024) })
    ).toBeNull()
    expect(
      parseContentReplicaUpsertInput({
        ...base,
        ciphertext: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64url'),
      })
    ).toBeNull()
  })

  test('bounds the complete request before JSON parsing', async () => {
    const oversized = new Request('https://example.test', {
      body: JSON.stringify({ ...base, ciphertext: 'A'.repeat(CONTENT_REPLICA_MAX_REQUEST_BYTES) }),
      method: 'POST',
    })
    await expect(readContentReplicaRequest(oversized)).resolves.toBeNull()
    const declaredOversized = new Request('https://example.test', {
      body: JSON.stringify(base),
      headers: { 'content-length': String(CONTENT_REPLICA_MAX_REQUEST_BYTES + 1) },
      method: 'POST',
    })
    await expect(readContentReplicaRequest(declaredOversized)).resolves.toBeNull()
  })

  test('classifies infrastructure errors as retryable instead of invalid requests', () => {
    expect(classifyContentReplicaError(new Error('database unavailable'))).toBe('retryable')
    expect(classifyContentReplicaError(new Error('serialization conflict'))).toBe('retryable')
    expect(classifyContentReplicaError(new Error('Content replica digest conflict'))).toBe(
      'conflict'
    )
    expect(classifyContentReplicaError(new Error('Content replica unavailable'))).toBe(
      'unavailable'
    )
    expect(classifyContentReplicaError(new Error('Content replica metadata invalid'))).toBe(
      'invalid'
    )
  })
})
