import type { ApiContentReplicaUpsertInput } from '@adea-ai/api-client'

import { isContentRefUuid } from './content-ref-input'

const DIGEST = /^[0-9a-f]{64}$/
const MAX_CIPHERTEXT_BYTES = 2 * 1024 * 1024
const MIN_CIPHERTEXT_BYTES = 16
const MAX_CIPHERTEXT_BASE64URL_CHARS = 2_796_203
const MIN_CIPHERTEXT_BASE64URL_CHARS = 22
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
    !decodeCiphertext(input.ciphertext) ||
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

function decodeCiphertext(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length < MIN_CIPHERTEXT_BASE64URL_CHARS ||
    value.length > MAX_CIPHERTEXT_BASE64URL_CHARS ||
    !BASE64URL.test(value) ||
    value.length % 4 === 1
  )
    return null
  const padded = `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`
  let decoded: Uint8Array
  try {
    const binary = atob(padded)
    decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    let binaryBytes = ''
    for (let offset = 0; offset < decoded.length; offset += 0x8000)
      binaryBytes += String.fromCharCode(...decoded.subarray(offset, offset + 0x8000))
    const canonical = btoa(binaryBytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    if (canonical !== value) return null
  } catch {
    return null
  }
  return decoded.byteLength >= MIN_CIPHERTEXT_BYTES && decoded.byteLength <= MAX_CIPHERTEXT_BYTES
}
