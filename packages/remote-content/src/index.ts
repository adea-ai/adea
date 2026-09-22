import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core'

export const REMOTE_CONTENT_VERSION = 1 as const
export const REMOTE_CONTENT_SUITE = 'DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM' as const
export const REMOTE_CONTENT_SCHEMA_VERSION = 1 as const
export const MAX_REMOTE_CONTENT_PLAINTEXT_BYTES = 1024 * 1024
export const MAX_REMOTE_CONTENT_CIPHERTEXT_BYTES = MAX_REMOTE_CONTENT_PLAINTEXT_BYTES + 16
export const MAX_REMOTE_CONTENT_ENC_CHARS = 43
export const MAX_REMOTE_CONTENT_CIPHERTEXT_CHARS = Math.ceil(
  (MAX_REMOTE_CONTENT_CIPHERTEXT_BYTES * 4) / 3
)
export const MAX_REMOTE_CONTENT_TTL_MS = 24 * 60 * 60 * 1000

const REMOTE_CONTENT_INFO_PREFIX = 'adea-remote-content-envelope:v1\u0000'
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
  | 'replayed'
  | 'replay_unavailable'
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
  keyId: string
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
  aad: Omit<RemoteContentAad, 'version' | 'keyId'>
  plaintext: ArrayBufferLike | ArrayBufferView
  now?: Date | string | number
}>

export type RemoteContentReplayClaim = Readonly<{
  workspaceId: string
  runtimeNodeId: string
  requestId: string
  keyId: string
  enc: string
  expiresAt: string
}>

/** The host must atomically claim a command/result identity in its durable inbox. */
export type RemoteContentReplayLedger = Readonly<{
  claim(input: RemoteContentReplayClaim): Promise<boolean>
}>

export type RemoteContentReplayGuard = RemoteContentReplayLedger

export type RemoteContentReplayGuardOptions = Readonly<{
  workspaceId: string
  runtimeNodeId: string
  ledger: RemoteContentReplayLedger
  now?: Date | string | number
}>

/**
 * Bind a host's atomic replay ledger to one authenticated workspace/node scope.
 *
 * The ledger remains responsible for durable atomicity. This adapter prevents a
 * caller from accidentally reusing a ledger across scopes and refuses claims
 * that expire while a decrypt/dispatch handoff is in flight.
 */
export function createRemoteContentReplayGuard(
  input: RemoteContentReplayGuardOptions
): RemoteContentReplayGuard {
  const workspaceId = validateReplayScopeId(input.workspaceId)
  const runtimeNodeId = validateReplayScopeId(input.runtimeNodeId)
  return {
    claim: async (claim) => {
      if (claim.workspaceId !== workspaceId || claim.runtimeNodeId !== runtimeNodeId) return false
      const now = timestampToMs(input.now ?? Date.now())
      if (now >= timestampToMs(claim.expiresAt)) return false
      return input.ledger.claim(claim)
    },
  }
}

export type OpenRemoteContentInput = Readonly<{
  envelope: unknown
  recipientPrivateKey: CryptoKey
  keyId: string
  replayGuard: RemoteContentReplayGuard | undefined
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

export function createRemoteContentAad(
  input: Omit<RemoteContentAad, 'version' | 'keyId'>,
  keyId: string
): RemoteContentAad {
  const candidate = { version: REMOTE_CONTENT_VERSION, keyId, ...input }
  validateAad(candidate)
  return {
    version: REMOTE_CONTENT_VERSION,
    keyId: candidate.keyId,
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
  const aad = createRemoteContentAad(input.aad, keyId)
  const now = timestampToMs(input.now ?? Date.now())
  assertWindow(aad, now)

  const plaintext = toBytes(input.plaintext)
  if (plaintext.byteLength > MAX_REMOTE_CONTENT_PLAINTEXT_BYTES) {
    throw new RemoteContentEnvelopeError('payload_too_large')
  }

  try {
    const sender = await suite.createSenderContext({
      recipientPublicKey: input.recipientPublicKey,
      info: hpkeInfo(keyId),
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
  const keyId = validateKeyId(input.keyId)
  if (keyId !== envelope.keyId) {
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
      info: hpkeInfo(keyId),
    })
    const plaintext = new Uint8Array(await recipient.open(ciphertext, aadBytes(envelope.aad)))
    if (plaintext.byteLength > MAX_REMOTE_CONTENT_PLAINTEXT_BYTES) {
      throw new RemoteContentEnvelopeError('payload_too_large')
    }
    if (input.replayGuard === undefined) {
      throw new RemoteContentEnvelopeError('replay_unavailable')
    }
    let claimed: boolean
    try {
      claimed = await input.replayGuard.claim({
        workspaceId: envelope.aad.workspaceId,
        runtimeNodeId: envelope.aad.runtimeNodeId,
        requestId: envelope.aad.requestId,
        keyId: envelope.keyId,
        enc: envelope.enc,
        expiresAt: envelope.aad.expiresAt,
      })
    } catch {
      throw new RemoteContentEnvelopeError('replay_unavailable')
    }
    if (claimed !== true) throw new RemoteContentEnvelopeError('replayed')
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
    enc = validateEncodedBytes(value.enc, 32, MAX_REMOTE_CONTENT_ENC_CHARS, 'invalid_envelope')
    ciphertext = validateEncodedBytes(
      value.ciphertext,
      undefined,
      MAX_REMOTE_CONTENT_CIPHERTEXT_CHARS,
      'payload_too_large'
    )
  } catch (error) {
    if (error instanceof RemoteContentEnvelopeError) throw error
    throw new RemoteContentEnvelopeError('invalid_envelope')
  }
  const aad = parseAad(value.aad)
  if (aad.keyId !== keyId) throw new RemoteContentEnvelopeError('key_mismatch')
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
    'keyId',
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
    typeof value.keyId !== 'string' ||
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
    keyId: value.keyId,
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
    'keyId',
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
    !KEY_ID_PATTERN.test(value.keyId) ||
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

function validateReplayScopeId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new RemoteContentEnvelopeError('invalid_envelope')
  }
  return value
}

function validateEncodedBytes(
  value: unknown,
  expectedLength?: number,
  maxEncodedLength?: number,
  tooLargeCode: RemoteContentErrorCode = 'invalid_envelope'
): string {
  if (typeof value !== 'string') throw new RemoteContentEnvelopeError('invalid_envelope')
  if (maxEncodedLength !== undefined && value.length > maxEncodedLength) {
    throw new RemoteContentEnvelopeError(tooLargeCode)
  }
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

function hpkeInfo(keyId: string): Uint8Array {
  return textEncoder.encode(`${REMOTE_CONTENT_INFO_PREFIX}${keyId}`)
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
