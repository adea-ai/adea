import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core'

export const REMOTE_CONTENT_VERSION = 1 as const
export const REMOTE_CONTENT_SUITE = 'DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM' as const
export const REMOTE_CONTENT_SCHEMA_VERSION = 1 as const
export const MAX_REMOTE_CONTENT_PLAINTEXT_BYTES = 1024 * 1024
export const MAX_REMOTE_CONTENT_CIPHERTEXT_BYTES = MAX_REMOTE_CONTENT_PLAINTEXT_BYTES + 16
export const MAX_REMOTE_CONTENT_TTL_MS = 24 * 60 * 60 * 1000

const REMOTE_CONTENT_INFO = new TextEncoder().encode('adea-remote-content-envelope:v1')
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const PAYLOAD_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const textEncoder = new TextEncoder()

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
})

export type RemoteContentErrorCode =
  | 'decryption_failed'
  | 'encryption_failed'
  | 'expired'
  | 'invalid_envelope'
  | 'key_mismatch'
  | 'payload_too_large'
  | 'unsupported_suite'
  | 'unsupported_version'

export class RemoteContentEnvelopeError extends Error {
  readonly code: RemoteContentErrorCode

  constructor(code: RemoteContentErrorCode) {
    super(`Remote content envelope rejected: ${code}`)
    this.name = 'RemoteContentEnvelopeError'
    this.code = code
  }
}

export type RemoteContentAad = Readonly<{
  version: typeof REMOTE_CONTENT_VERSION
  workspaceId: string
  runtimeNodeId: string
  requestId: string
  payloadType: string
  schemaVersion: number
  issuedAt: string
  expiresAt: string
  contentDigest?: string
}>

export type RemoteContentEnvelope = Readonly<{
  version: typeof REMOTE_CONTENT_VERSION
  suite: typeof REMOTE_CONTENT_SUITE
  keyId: string
  enc: string
  ciphertext: string
  aad: RemoteContentAad
}>

export type RemoteContentEnvelopeInput = Readonly<{
  keyId: string
  recipientPublicKey: CryptoKey
  aad: Omit<RemoteContentAad, 'version'>
  plaintext: ArrayBufferLike | ArrayBufferView
  now?: Date | string | number
}>

export type OpenRemoteContentInput = Readonly<{
  envelope: unknown
  recipientPrivateKey: CryptoKey
  keyId: string
  now?: Date | string | number
}>

/** Generate a node's X25519 key pair in the host/browser crypto boundary. */
export function generateRemoteCommandKeyPair(): Promise<CryptoKeyPair> {
  return suite.kem.generateKeyPair()
}

/** Derive deterministic key material for interoperability fixtures only. */
export function deriveRemoteCommandKeyPair(
  ikm: ArrayBufferLike | ArrayBufferView
): Promise<CryptoKeyPair> {
  return suite.kem.deriveKeyPair(ikm)
}

export function createRemoteContentAad(input: Omit<RemoteContentAad, 'version'>): RemoteContentAad {
  const candidate = { version: REMOTE_CONTENT_VERSION, ...input }
  validateAad(candidate)
  return {
    version: REMOTE_CONTENT_VERSION,
    workspaceId: candidate.workspaceId,
    runtimeNodeId: candidate.runtimeNodeId,
    requestId: candidate.requestId,
    payloadType: candidate.payloadType,
    schemaVersion: candidate.schemaVersion,
    issuedAt: candidate.issuedAt,
    expiresAt: candidate.expiresAt,
    ...(candidate.contentDigest === undefined ? {} : { contentDigest: candidate.contentDigest }),
  }
}

export async function sealRemoteContent(
  input: RemoteContentEnvelopeInput
): Promise<RemoteContentEnvelope> {
  const keyId = validateKeyId(input.keyId)
  const aad = createRemoteContentAad(input.aad)
  const now = timestampToMs(input.now ?? Date.now())
  assertWindow(aad, now)

  const plaintext = toBytes(input.plaintext)
  if (plaintext.byteLength > MAX_REMOTE_CONTENT_PLAINTEXT_BYTES) {
    throw new RemoteContentEnvelopeError('payload_too_large')
  }

  try {
    const sender = await suite.createSenderContext({
      recipientPublicKey: input.recipientPublicKey,
      info: REMOTE_CONTENT_INFO,
    })
    const ciphertext = await sender.seal(plaintext, aadBytes(aad))
    const ciphertextBytes = new Uint8Array(ciphertext)
    if (ciphertextBytes.byteLength > MAX_REMOTE_CONTENT_CIPHERTEXT_BYTES) {
      throw new RemoteContentEnvelopeError('payload_too_large')
    }
    return {
      version: REMOTE_CONTENT_VERSION,
      suite: REMOTE_CONTENT_SUITE,
      keyId,
      enc: bytesToBase64Url(new Uint8Array(sender.enc)),
      ciphertext: bytesToBase64Url(ciphertextBytes),
      aad,
    }
  } catch (error) {
    if (error instanceof RemoteContentEnvelopeError) throw error
    throw new RemoteContentEnvelopeError('encryption_failed')
  }
}

export async function openRemoteContent(input: OpenRemoteContentInput): Promise<Uint8Array> {
  const envelope = parseRemoteContentEnvelope(input.envelope)
  if (validateKeyId(input.keyId) !== envelope.keyId) {
    throw new RemoteContentEnvelopeError('key_mismatch')
  }
  const now = timestampToMs(input.now ?? Date.now())
  assertWindow(envelope.aad, now)
  if (now >= timestampToMs(envelope.aad.expiresAt)) {
    throw new RemoteContentEnvelopeError('expired')
  }

  const enc = decodeBase64Url(envelope.enc)
  const ciphertext = decodeBase64Url(envelope.ciphertext)
  if (ciphertext.byteLength > MAX_REMOTE_CONTENT_CIPHERTEXT_BYTES) {
    throw new RemoteContentEnvelopeError('payload_too_large')
  }

  try {
    const recipient = await suite.createRecipientContext({
      recipientKey: input.recipientPrivateKey,
      enc,
      info: REMOTE_CONTENT_INFO,
    })
    const plaintext = new Uint8Array(await recipient.open(ciphertext, aadBytes(envelope.aad)))
    if (plaintext.byteLength > MAX_REMOTE_CONTENT_PLAINTEXT_BYTES) {
      throw new RemoteContentEnvelopeError('payload_too_large')
    }
    return plaintext
  } catch (error) {
    if (error instanceof RemoteContentEnvelopeError) throw error
    throw new RemoteContentEnvelopeError('decryption_failed')
  }
}

export function parseRemoteContentEnvelope(value: unknown): RemoteContentEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'suite', 'keyId', 'enc', 'ciphertext', 'aad'])
  ) {
    throw new RemoteContentEnvelopeError('invalid_envelope')
  }
  if (value.version !== REMOTE_CONTENT_VERSION) {
    throw new RemoteContentEnvelopeError('unsupported_version')
  }
  if (value.suite !== REMOTE_CONTENT_SUITE) {
    throw new RemoteContentEnvelopeError('unsupported_suite')
  }

  let keyId: string
  let enc: string
  let ciphertext: string
  try {
    keyId = validateKeyId(value.keyId)
    enc = validateEncodedBytes(value.enc, 32)
    ciphertext = validateEncodedBytes(value.ciphertext)
  } catch (error) {
    if (error instanceof RemoteContentEnvelopeError) throw error
    throw new RemoteContentEnvelopeError('invalid_envelope')
  }
  const aad = parseAad(value.aad)
  const ciphertextBytes = decodeBase64Url(ciphertext)
  if (ciphertextBytes.byteLength < 16) throw new RemoteContentEnvelopeError('invalid_envelope')
  if (ciphertextBytes.byteLength > MAX_REMOTE_CONTENT_CIPHERTEXT_BYTES) {
    throw new RemoteContentEnvelopeError('payload_too_large')
  }
  return {
    version: REMOTE_CONTENT_VERSION,
    suite: REMOTE_CONTENT_SUITE,
    keyId,
    enc,
    ciphertext,
    aad,
  }
}

function parseAad(value: unknown): RemoteContentAad {
  if (!isRecord(value)) throw new RemoteContentEnvelopeError('invalid_envelope')
  const keys = [
    'version',
    'workspaceId',
    'runtimeNodeId',
    'requestId',
    'payloadType',
    'schemaVersion',
    'issuedAt',
    'expiresAt',
  ]
  const withDigest = hasExactKeys(value, [...keys, 'contentDigest'])
  if (!withDigest && !hasExactKeys(value, keys))
    throw new RemoteContentEnvelopeError('invalid_envelope')
  if (value.version !== REMOTE_CONTENT_VERSION)
    throw new RemoteContentEnvelopeError('unsupported_version')
  if (
    typeof value.workspaceId !== 'string' ||
    typeof value.runtimeNodeId !== 'string' ||
    typeof value.requestId !== 'string' ||
    typeof value.payloadType !== 'string' ||
    typeof value.schemaVersion !== 'number' ||
    typeof value.issuedAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    (value.contentDigest !== undefined && typeof value.contentDigest !== 'string')
  ) {
    throw new RemoteContentEnvelopeError('invalid_envelope')
  }
  const aad = {
    version: REMOTE_CONTENT_VERSION,
    workspaceId: value.workspaceId,
    runtimeNodeId: value.runtimeNodeId,
    requestId: value.requestId,
    payloadType: value.payloadType,
    schemaVersion: value.schemaVersion,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    ...(withDigest ? { contentDigest: value.contentDigest } : {}),
  }
  validateAad(aad)
  return aad
}

function validateAad(value: RemoteContentAad): void {
  const requiredKeys = [
    'version',
    'workspaceId',
    'runtimeNodeId',
    'requestId',
    'payloadType',
    'schemaVersion',
    'issuedAt',
    'expiresAt',
  ]
  const keys = value.contentDigest === undefined ? requiredKeys : [...requiredKeys, 'contentDigest']
  if (!hasExactKeys(value as unknown as Record<string, unknown>, keys)) {
    throw new RemoteContentEnvelopeError('invalid_envelope')
  }
  if (
    !UUID_PATTERN.test(value.workspaceId) ||
    !UUID_PATTERN.test(value.runtimeNodeId) ||
    !UUID_PATTERN.test(value.requestId)
  ) {
    throw new RemoteContentEnvelopeError('invalid_envelope')
  }
  if (!PAYLOAD_TYPE_PATTERN.test(value.payloadType))
    throw new RemoteContentEnvelopeError('invalid_envelope')
  if (value.schemaVersion !== REMOTE_CONTENT_SCHEMA_VERSION) {
    throw new RemoteContentEnvelopeError('invalid_envelope')
  }
  timestampToMs(value.issuedAt)
  timestampToMs(value.expiresAt)
  if (value.contentDigest !== undefined && !DIGEST_PATTERN.test(value.contentDigest)) {
    throw new RemoteContentEnvelopeError('invalid_envelope')
  }
}

function assertWindow(aad: RemoteContentAad, now: number): void {
  const issuedAt = timestampToMs(aad.issuedAt)
  const expiresAt = timestampToMs(aad.expiresAt)
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_REMOTE_CONTENT_TTL_MS) {
    throw new RemoteContentEnvelopeError('invalid_envelope')
  }
  if (now >= expiresAt) throw new RemoteContentEnvelopeError('expired')
}

function validateKeyId(value: unknown): string {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value)) {
    throw new RemoteContentEnvelopeError('invalid_envelope')
  }
  return value
}

function validateEncodedBytes(value: unknown, expectedLength?: number): string {
  if (typeof value !== 'string') throw new RemoteContentEnvelopeError('invalid_envelope')
  const bytes = decodeBase64Url(value)
  if (expectedLength !== undefined && bytes.byteLength !== expectedLength) {
    throw new RemoteContentEnvelopeError('invalid_envelope')
  }
  return value
}

function timestampToMs(value: Date | string | number): number {
  const timestamp =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new RemoteContentEnvelopeError('invalid_envelope')
  if (
    typeof value === 'string' &&
    (!TIMESTAMP_PATTERN.test(value) || new Date(timestamp).toISOString() !== value)
  ) {
    throw new RemoteContentEnvelopeError('invalid_envelope')
  }
  return timestamp
}

function aadBytes(aad: RemoteContentAad): Uint8Array {
  return textEncoder.encode(JSON.stringify(aad))
}

function toBytes(value: ArrayBufferLike | ArrayBufferView): Uint8Array {
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return new Uint8Array(value)
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < value.length; index += 0x8000) {
    binary += String.fromCharCode(...value.subarray(index, index + 0x8000))
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new RemoteContentEnvelopeError('invalid_envelope')
  }
  const padded =
    value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4)
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new RemoteContentEnvelopeError('invalid_envelope')
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (bytesToBase64Url(bytes) !== value) throw new RemoteContentEnvelopeError('invalid_envelope')
  return bytes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).toSorted()
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === [...keys].toSorted()[index])
  )
}
