/**
 * RuntimeNode proof messages and signature verification.
 *
 * Every state change a node performs is proven by signing a message that names
 * the purpose, the workspace, the challenge, and the nonce. Binding all four is
 * what stops a captured signature from being replayed against a different node,
 * workspace, or purpose, and the nonce comes from a single-use challenge the
 * server issued.
 *
 * Verification uses WebCrypto Ed25519: no asymmetric dependency is added to the
 * server, and the node's raw 32-byte public key verifies directly.
 */

export const RUNTIME_NODE_PROOF_VERSION = 'v1'
const MAX_PUBLIC_KEY_BYTES = 32
const MAX_SIGNATURE_BYTES = 64

export type RuntimeNodeProofInput = Readonly<{
  challengeId: string
  kind?: 'local_device' | 'remote_host'
  nonce: string
  publicKey: string
  purpose: 'pair' | 'proof' | 'rotate'
  runtimeNodeId?: string
  signature: string
  workspaceId: string
}>

/** The exact bytes a node signs. Kept as data so both sides share one source. */
export function runtimeNodeProofMessage(input: RuntimeNodeProofInput): string {
  switch (input.purpose) {
    case 'pair':
      if (!input.kind) throw new Error('Pairing proofs name the node kind')
      return [
        'adea-runtime-node-pairing',
        RUNTIME_NODE_PROOF_VERSION,
        input.kind,
        input.workspaceId,
        input.challengeId,
        input.nonce,
      ].join(':')
    case 'rotate':
      if (!input.runtimeNodeId) throw new Error('Rotation proofs name the runtime node')
      return [
        'adea-runtime-node-rotation',
        RUNTIME_NODE_PROOF_VERSION,
        input.runtimeNodeId,
        input.challengeId,
        input.nonce,
      ].join(':')
    case 'proof':
      if (!input.runtimeNodeId) throw new Error('Liveness proofs name the runtime node')
      return [
        'adea-runtime-node-proof',
        RUNTIME_NODE_PROOF_VERSION,
        input.runtimeNodeId,
        input.challengeId,
        input.nonce,
      ].join(':')
  }
}

function decodeBounded(value: string, maxBytes: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null
  try {
    const bytes = Buffer.from(value, 'base64url')
    return bytes.byteLength === maxBytes ? new Uint8Array(bytes) : null
  } catch {
    return null
  }
}

/** A raw Ed25519 public key: exactly 32 base64url bytes. */
export function parseRuntimeNodePublicKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return decodeBounded(value, MAX_PUBLIC_KEY_BYTES) ? value : null
}

/** A raw Ed25519 signature: exactly 64 base64url bytes. */
export function parseRuntimeNodeSignature(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return decodeBounded(value, MAX_SIGNATURE_BYTES) ? value : null
}

/**
 * Verify a node's proof. A malformed key or signature is a failed proof, not an
 * exception: callers treat every failure the same way.
 */
export async function verifyRuntimeNodeProof(input: RuntimeNodeProofInput): Promise<boolean> {
  const publicKey = parseRuntimeNodePublicKey(input.publicKey)
  const signature = parseRuntimeNodeSignature(input.signature)
  if (!publicKey || !signature) return false

  const keyBytes = decodeBounded(publicKey, MAX_PUBLIC_KEY_BYTES)!
  const signatureBytes = decodeBounded(signature, MAX_SIGNATURE_BYTES)!
  const message = new TextEncoder().encode(runtimeNodeProofMessage(input))

  try {
    return await verifyEd25519(keyBytes, signatureBytes, message)
  } catch {
    return false
  }
}

/**
 * Raw Ed25519 verification. The TypeScript DOM lib's algorithm union does not
 * list Ed25519 yet even though every runtime this code targets supports it, so
 * the two casts live here, next to the explanation, rather than at the call
 * sites.
 */
async function verifyEd25519(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    publicKey as unknown as BufferSource,
    'Ed25519' as unknown as AlgorithmIdentifier,
    false,
    ['verify']
  )
  return crypto.subtle.verify(
    'Ed25519' as unknown as AlgorithmIdentifier,
    key,
    signature as unknown as BufferSource,
    message as unknown as BufferSource
  )
}

/** Why a proof was refused, in terms a client can act on. */
export function proofRefusalMessage(reason: RuntimeNodeProofRefusal): string {
  switch (reason) {
    case 'challenge_expired':
      return 'Runtime node challenge expired; request a new one'
    case 'challenge_used':
      return 'Runtime node challenge was already used'
    case 'invalid':
      return 'Runtime node proof did not verify'
    case 'key_mismatch':
      return 'Runtime node key class does not match its role'
    case 'not_found':
      return 'Runtime node unavailable'
    case 'revoked':
      return 'Runtime node is revoked'
    case 'unauthorized':
      return 'Runtime node is not eligible for commands'
  }
}

export type RuntimeNodeProofRefusal =
  | 'challenge_expired'
  | 'challenge_used'
  | 'invalid'
  | 'key_mismatch'
  | 'not_found'
  | 'revoked'
  | 'unauthorized'
