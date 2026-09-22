import type { ApiContentReplicaUpsertInput } from '@adea-ai/api-client'

import { isContentRefUuid } from './content-ref-input'

const DIGEST = /^[0-9a-f]{64}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const NONCE = /^[A-Za-z0-9_-]{16}$/
const KEYS = new Set([
  'availability',
  'ciphertext',
  'digestSha256',
  'keyEpochId',
  'nonce',
  'replicaKind',
  'revision',
  'schemaVersion',
])

const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0

export function parseContentReplicaUpsertInput(
  value: unknown
): ApiContentReplicaUpsertInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some((key) => !KEYS.has(key)) ||
    !['available', 'offline', 'missing', 'deleted'].includes(String(input.availability)) ||
    !DIGEST.test(String(input.digestSha256)) ||
    !BASE64URL.test(String(input.ciphertext)) ||
    !NONCE.test(String(input.nonce)) ||
    !['local_authority', 'self_hosted_authority', 'agent_hq_e2ee_sync'].includes(
      String(input.replicaKind)
    ) ||
    !positiveInteger(input.revision) ||
    !positiveInteger(input.schemaVersion) ||
    (input.keyEpochId !== undefined && !isContentRefUuid(input.keyEpochId)) ||
    (input.replicaKind === 'agent_hq_e2ee_sync' && input.keyEpochId === undefined) ||
    (input.replicaKind !== 'agent_hq_e2ee_sync' && input.keyEpochId !== undefined)
  )
    return null
  return input as ApiContentReplicaUpsertInput
}
