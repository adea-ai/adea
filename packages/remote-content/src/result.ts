import {
  RemoteContentEnvelopeError,
  createRemoteContentAad,
  MAX_REMOTE_CONTENT_TTL_MS,
  openRemoteContent,
  parseRemoteContentEnvelope,
  sealRemoteContent,
  type RemoteContentEnvelope,
  type RemoteContentReplayGuard,
} from './envelope.js'

const RESULT_PAYLOAD_TYPE = 'execution.result'
const RETURN_KEY_PATTERN =
  /^return_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/

export type RemoteResultScope = Readonly<{
  workspaceId: string
  runtimeNodeId: string
  requestId: string
}>

/** Send this public descriptor inside the authenticated, encrypted command. */
export type RemoteResultRecipient = RemoteResultScope &
  Readonly<{
    version: 1
    keyId: string
    publicKey: string
    issuedAt: string
    expiresAt: string
  }>

/** An in-memory receiver capability. Serializing it cannot export its private key. */
export type RemoteResultReceiver = Readonly<{ recipient: RemoteResultRecipient }>

type ReceiverState = {
  privateKey: CryptoKey
  status: 'open' | 'opening'
}
const receivers = new WeakMap<RemoteResultReceiver, ReceiverState>()

export async function createRemoteResultReceiver(
  input: RemoteResultScope & Readonly<{ issuedAt: string; expiresAt: string; now?: number }>
): Promise<RemoteResultReceiver> {
  const keyId = `return_${crypto.randomUUID()}`
  const aad = createRemoteContentAad(
    {
      ...scope(input),
      payloadType: RESULT_PAYLOAD_TYPE,
      schemaVersion: 1,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    },
    keyId
  )
  assertLive(aad.issuedAt, aad.expiresAt, input.now ?? Date.now())
  let pair: CryptoKeyPair
  let publicKey: string
  try {
    pair = (await crypto.subtle.generateKey({ name: 'X25519' }, false, [
      'deriveBits',
    ])) as CryptoKeyPair
    publicKey = encodePublicKey(await crypto.subtle.exportKey('raw', pair.publicKey))
  } catch {
    throw new RemoteContentEnvelopeError('encryption_failed')
  }
  assertLive(aad.issuedAt, aad.expiresAt, input.now ?? Date.now())
  const recipient: RemoteResultRecipient = Object.freeze({
    version: 1,
    keyId,
    publicKey,
    ...scope(aad),
    issuedAt: aad.issuedAt,
    expiresAt: aad.expiresAt,
  })
  const receiver = Object.freeze({ recipient })
  receivers.set(receiver, { privateKey: pair.privateKey, status: 'open' })
  return receiver
}

/** Drop the private key reference when the request is cancelled or its client scope changes. */
export function closeRemoteResultReceiver(receiver: RemoteResultReceiver): void {
  receivers.delete(receiver)
}

export function parseRemoteResultRecipient(value: unknown): RemoteResultRecipient {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid()
  const candidate = value as Record<string, unknown>
  const keys = [
    'version',
    'keyId',
    'publicKey',
    'workspaceId',
    'runtimeNodeId',
    'requestId',
    'issuedAt',
    'expiresAt',
  ]
  if (
    Object.keys(candidate).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(candidate, key))
  )
    invalid()
  if (
    candidate.version !== 1 ||
    typeof candidate.keyId !== 'string' ||
    !RETURN_KEY_PATTERN.test(candidate.keyId)
  )
    invalid()
  for (const key of [
    'publicKey',
    'workspaceId',
    'runtimeNodeId',
    'requestId',
    'issuedAt',
    'expiresAt',
  ]) {
    const valueAtKey = candidate[key]
    const expectedLength = key === 'publicKey' ? 43 : key.endsWith('At') ? 24 : 36
    if (typeof valueAtKey !== 'string' || valueAtKey.length !== expectedLength) invalid()
  }
  const recipient = candidate as unknown as RemoteResultRecipient
  decodePublicKey(recipient.publicKey)
  createRemoteContentAad(
    {
      ...scope(recipient),
      payloadType: RESULT_PAYLOAD_TYPE,
      schemaVersion: 1,
      issuedAt: recipient.issuedAt,
      expiresAt: recipient.expiresAt,
    },
    recipient.keyId
  )
  assertLifetime(recipient.issuedAt, recipient.expiresAt)
  return Object.freeze({
    version: 1,
    keyId: recipient.keyId,
    publicKey: recipient.publicKey,
    ...scope(recipient),
    issuedAt: recipient.issuedAt,
    expiresAt: recipient.expiresAt,
  })
}

/** The host supplies the authenticated command scope, never a scope inferred from this descriptor. */
export async function sealRemoteResult(
  input: Readonly<{
    recipient: unknown
    expectedScope: RemoteResultScope
    plaintext: ArrayBufferLike | ArrayBufferView
    now?: number
  }>
): Promise<RemoteContentEnvelope> {
  const recipient = parseRemoteResultRecipient(input.recipient)
  assertScope(recipient, input.expectedScope)
  assertLive(recipient.issuedAt, recipient.expiresAt, input.now ?? Date.now())
  let publicKey: CryptoKey
  try {
    publicKey = await crypto.subtle.importKey(
      'raw',
      decodePublicKey(recipient.publicKey),
      { name: 'X25519' },
      true,
      []
    )
  } catch {
    throw new RemoteContentEnvelopeError('encryption_failed')
  }
  return sealRemoteContent({
    keyId: recipient.keyId,
    recipientPublicKey: publicKey,
    aad: {
      ...scope(recipient),
      payloadType: RESULT_PAYLOAD_TYPE,
      schemaVersion: 1,
      issuedAt: recipient.issuedAt,
      expiresAt: recipient.expiresAt,
    },
    plaintext: input.plaintext,
    now: input.now,
  })
}

/** Call only after validating the host's authenticated transport/receipt. HPKE base mode does not authenticate a sender. */
export async function openRemoteResult(
  input: Readonly<{
    receiver: RemoteResultReceiver
    envelope: unknown
    replayGuard: RemoteContentReplayGuard | undefined
    now?: number
  }>
): Promise<Uint8Array> {
  const receiver = input.receiver
  const state = receivers.get(receiver)
  if (!state) throw new RemoteContentEnvelopeError('return_key_unavailable')
  if (state.status === 'opening') throw new RemoteContentEnvelopeError('replayed')
  const envelope = parseRemoteContentEnvelope(input.envelope)
  const recipient = receiver.recipient
  assertLive(recipient.issuedAt, recipient.expiresAt, input.now ?? Date.now())
  assertScope(envelope.aad, recipient)
  if (
    envelope.keyId !== recipient.keyId ||
    envelope.aad.payloadType !== RESULT_PAYLOAD_TYPE ||
    envelope.aad.issuedAt !== recipient.issuedAt ||
    envelope.aad.expiresAt !== recipient.expiresAt
  )
    invalid()
  state.status = 'opening'
  try {
    const plaintext = await openRemoteContent({
      envelope,
      keyId: recipient.keyId,
      recipientPrivateKey: state.privateKey,
      replayGuard: input.replayGuard,
      now: input.now,
    })
    if (!receivers.has(receiver)) {
      plaintext.fill(0)
      throw new RemoteContentEnvelopeError('return_key_unavailable')
    }
    receivers.delete(receiver)
    return plaintext
  } catch (error) {
    state.status = 'open'
    throw error
  }
}

function scope(value: RemoteResultScope): RemoteResultScope {
  return {
    workspaceId: value.workspaceId,
    runtimeNodeId: value.runtimeNodeId,
    requestId: value.requestId,
  }
}

function assertScope(value: RemoteResultScope, expected: RemoteResultScope): void {
  if (
    value.workspaceId !== expected.workspaceId ||
    value.runtimeNodeId !== expected.runtimeNodeId ||
    value.requestId !== expected.requestId
  )
    invalid()
}

function assertLifetime(issuedAt: string, expiresAt: string): void {
  const ttl = Date.parse(expiresAt) - Date.parse(issuedAt)
  if (!(ttl > 0 && ttl <= MAX_REMOTE_CONTENT_TTL_MS)) invalid()
}

function assertLive(issuedAt: string, expiresAt: string, now: number): void {
  assertLifetime(issuedAt, expiresAt)
  if (!Number.isFinite(now) || now < Date.parse(issuedAt)) invalid()
  if (now >= Date.parse(expiresAt)) throw new RemoteContentEnvelopeError('expired')
}

function encodePublicKey(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodePublicKey(value: string): Uint8Array<ArrayBuffer> {
  if (!PUBLIC_KEY_PATTERN.test(value)) invalid()
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='), (char) =>
      char.charCodeAt(0)
    )
  } catch {
    return invalid()
  }
  if (bytes.length !== 32 || encodePublicKey(bytes.buffer) !== value) invalid()
  return bytes
}

function invalid(): never {
  throw new RemoteContentEnvelopeError('invalid_envelope')
}
