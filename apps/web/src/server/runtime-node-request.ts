/**
 * Input parsing for the RuntimeNode API. Every field is bounded and every
 * enum is exact, so a malformed registration is refused before it reaches the
 * database or a key is ever considered.
 */

import { parseRuntimeNodePublicKey, parseRuntimeNodeSignature } from './runtime-node-proof'

export type RuntimeNodeKindValue = 'local_device' | 'remote_host'
export type RuntimeNodeKeyRoleValue = 'signing' | 'command_encryption'
export type RuntimeNodeKeyAlgorithmValue = 'ed25519' | 'x25519'

const MAX_DISPLAY_NAME = 120
const MAX_PLATFORM = 64
const MAX_SOFTWARE_VERSION = 64
const MAX_TRUST_METADATA_BYTES = 2 * 1024
const MAX_DISPLAY_NAME_CHARS = 120

function boundedText(value: unknown, maximum: number, minimum = 1): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length < minimum || trimmed.length > maximum) return null
  // Control characters would corrupt logs and audit records. A code-point scan
  // keeps this deliberate check out of the "regex with control characters" class.
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return null
  }
  return trimmed
}

export function parseRuntimeNodeKind(value: unknown): RuntimeNodeKindValue | null {
  return value === 'local_device' || value === 'remote_host' ? value : null
}

export function parseRuntimeNodeKeyRole(value: unknown): RuntimeNodeKeyRoleValue | null {
  return value === 'signing' || value === 'command_encryption' ? value : null
}

export function parseRuntimeNodeKeyAlgorithm(value: unknown): RuntimeNodeKeyAlgorithmValue | null {
  return value === 'ed25519' || value === 'x25519' ? value : null
}

export type RuntimeNodeKeyInputValue = Readonly<{
  algorithm: RuntimeNodeKeyAlgorithmValue
  publicKey: string
  role: RuntimeNodeKeyRoleValue
}>

/**
 * One key as a node presents it. An unknown role or algorithm is refused, and
 * the role/algorithm pair must match: a signing key is Ed25519, a
 * command-encryption key is X25519.
 */
export function parseRuntimeNodeKey(value: unknown): RuntimeNodeKeyInputValue | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const role = parseRuntimeNodeKeyRole(candidate.role)
  const algorithm = parseRuntimeNodeKeyAlgorithm(candidate.algorithm)
  const publicKey = parseRuntimeNodePublicKey(candidate.publicKey)
  if (!role || !algorithm || !publicKey) return null
  if (role === 'signing' && algorithm !== 'ed25519') return null
  if (role === 'command_encryption' && algorithm !== 'x25519') return null
  return { algorithm, publicKey, role }
}

export function parseRuntimeNodeKeys(value: unknown): RuntimeNodeKeyInputValue[] | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const keys = value.map(parseRuntimeNodeKey)
  if (keys.some((key) => key === null)) return null
  const parsed = keys as RuntimeNodeKeyInputValue[]
  if (new Set(parsed.map((key) => key.role)).size !== 2) return null
  return parsed
}

export function parseTrustMetadata(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TRUST_METADATA_BYTES) return null
  // Product-visible host metadata only: no nested secrets or paths.
  if (/password|secret|token|private|credential|key|\\|\/|:\/\//iu.test(serialized)) return null
  return value as Record<string, unknown>
}

export type RuntimeNodeRegistrationInput = Readonly<{
  challengeId: string
  displayName: string
  encryptionSignature: string | null
  exchangeCredential: string | null
  keys: RuntimeNodeKeyInputValue[]
  kind: RuntimeNodeKindValue
  platform: string
  signature: string
  softwareVersion: string
  trustMetadata: Record<string, unknown>
}>

/** The registration body a node (or a host, with an exchange credential) sends. */
export function parseRuntimeNodeRegistration(
  body: unknown,
  options: Readonly<{ requireExchangeCredential: boolean }>
): RuntimeNodeRegistrationInput | null {
  if (!body || typeof body !== 'object') return null
  const candidate = body as Record<string, unknown>
  const kind = parseRuntimeNodeKind(candidate.kind)
  const challengeId = boundedText(candidate.challengeId, 64)
  const displayName = boundedText(candidate.displayName, MAX_DISPLAY_NAME)
  const platform = boundedText(candidate.platform, MAX_PLATFORM)
  const softwareVersion = boundedText(candidate.softwareVersion, MAX_SOFTWARE_VERSION)
  const keys = parseRuntimeNodeKeys(candidate.keys)
  const signature = parseRuntimeNodeSignature(candidate.signature)
  const trustMetadata = parseTrustMetadata(candidate.trustMetadata)
  if (
    !kind ||
    !challengeId ||
    !displayName ||
    displayName.length > MAX_DISPLAY_NAME_CHARS ||
    !platform ||
    !softwareVersion ||
    !keys ||
    !signature ||
    trustMetadata === null
  ) {
    return null
  }
  const exchangeCredential =
    candidate.exchangeCredential === undefined
      ? null
      : boundedText(candidate.exchangeCredential, 128)
  if (options.requireExchangeCredential && !exchangeCredential) return null
  if (!options.requireExchangeCredential && exchangeCredential) return null

  return {
    challengeId,
    displayName,
    encryptionSignature:
      candidate.encryptionSignature === undefined
        ? null
        : parseRuntimeNodeSignature(candidate.encryptionSignature),
    exchangeCredential,
    keys,
    kind,
    platform,
    signature,
    softwareVersion,
    trustMetadata,
  }
}

/** A rotation body: the replacement keys plus a proof made with the new key. */
export function parseRuntimeNodeRotation(body: unknown) {
  if (!body || typeof body !== 'object') return null
  const candidate = body as Record<string, unknown>
  const challengeId = boundedText(candidate.challengeId, 64)
  const keys = parseRuntimeNodeKeys(candidate.keys)
  const signature = parseRuntimeNodeSignature(candidate.signature)
  if (!challengeId || !keys || !signature) return null
  return { challengeId, keys, signature }
}

/** A liveness proof body. */
export function parseRuntimeNodeProofBody(body: unknown) {
  if (!body || typeof body !== 'object') return null
  const candidate = body as Record<string, unknown>
  const challengeId = boundedText(candidate.challengeId, 64)
  const signature = parseRuntimeNodeSignature(candidate.signature)
  if (!challengeId || !signature) return null
  return { challengeId, signature }
}

/** A revocation body. */
export function parseRuntimeNodeRevocation(body: unknown) {
  if (!body || typeof body !== 'object') return null
  const reason = boundedText((body as Record<string, unknown>).reason, 200)
  return reason ? { reason } : null
}

/** A challenge request: pairing for a kind, or rotate/proof for a node. */
export function parseRuntimeNodeChallengeRequest(body: unknown) {
  if (!body || typeof body !== 'object') return null
  const candidate = body as Record<string, unknown>
  const kind = parseRuntimeNodeKind(candidate.kind)
  if (!kind) return null
  return { kind }
}
