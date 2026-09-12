import { describe, expect, test } from 'bun:test'

import {
  parseRuntimeNodePublicKey,
  parseRuntimeNodeSignature,
  proofRefusalMessage,
  RUNTIME_NODE_PROOF_VERSION,
  runtimeNodeProofMessage,
  verifyRuntimeNodeProof,
} from '../src/server/runtime-node-proof'

const workspaceId = 'aaaaaaaa-1111-4111-8111-111111111111'
const runtimeNodeId = 'cccccccc-3333-4333-8333-333333333333'
const challengeId = 'dddddddd-4444-4444-8444-444444444444'
const nonce = 'f'.repeat(32)

/**
 * Real Ed25519 keys: the point of these tests is that the server verifies what
 * an independent signer produced, so a stubbed verifier would prove nothing.
 */
async function keypair() {
  const pair = (await crypto.subtle.generateKey('Ed25519' as never, true, [
    'sign',
    'verify',
  ] as never)) as unknown as CryptoKeyPair
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  return {
    publicKey: Buffer.from(raw).toString('base64url'),
    sign: async (message: string) =>
      Buffer.from(
        (await crypto.subtle.sign(
          'Ed25519' as never,
          pair.privateKey,
          new TextEncoder().encode(message)
        )) as ArrayBuffer
      ).toString('base64url'),
  }
}

async function signedProof(overrides: Record<string, unknown> = {}) {
  const signer = await keypair()
  const input = {
    challengeId,
    nonce,
    publicKey: signer.publicKey,
    purpose: 'pair' as const,
    kind: 'local_device' as const,
    workspaceId,
    ...overrides,
  } as Parameters<typeof runtimeNodeProofMessage>[0] & { kind?: 'local_device' }
  return { input, signature: await signer.sign(runtimeNodeProofMessage(input)), signer }
}

describe('runtime node proof messages', () => {
  test('bind purpose, workspace, challenge, and nonce, and carry the version', () => {
    const pairing = runtimeNodeProofMessage({
      challengeId,
      kind: 'remote_host',
      nonce,
      publicKey: 'ignored',
      purpose: 'pair',
      signature: 'ignored',
      workspaceId,
    })
    expect(pairing).toBe(
      `adea-runtime-node-pairing:${RUNTIME_NODE_PROOF_VERSION}:remote_host:${workspaceId}:${challengeId}:${nonce}`
    )

    const proof = runtimeNodeProofMessage({
      challengeId,
      nonce,
      publicKey: 'ignored',
      purpose: 'proof',
      runtimeNodeId,
      signature: 'ignored',
      workspaceId,
    })
    expect(proof).toBe(
      `adea-runtime-node-proof:${RUNTIME_NODE_PROOF_VERSION}:${runtimeNodeId}:${challengeId}:${nonce}`
    )
    expect(proof).not.toBe(pairing)
  })

  test('refuse to build a message that is missing its binding', () => {
    expect(() =>
      runtimeNodeProofMessage({
        challengeId,
        nonce,
        publicKey: 'ignored',
        purpose: 'pair',
        signature: 'ignored',
        workspaceId,
      })
    ).toThrow(/name the node kind/)
    expect(() =>
      runtimeNodeProofMessage({
        challengeId,
        nonce,
        publicKey: 'ignored',
        purpose: 'rotate',
        signature: 'ignored',
        workspaceId,
      })
    ).toThrow(/name the runtime node/)
  })
})

describe('runtime node proof verification', () => {
  test('accepts a signature over the exact message', async () => {
    const { input, signature } = await signedProof()
    expect(await verifyRuntimeNodeProof({ ...input, signature })).toBe(true)
  })

  test('rejects a tampered signature and a signature over a different challenge', async () => {
    const { input, signature, signer } = await signedProof()
    const flipped = `${signature.slice(0, 10)}${signature[10] === 'A' ? 'B' : 'A'}${signature.slice(11)}`
    expect(await verifyRuntimeNodeProof({ ...input, signature: flipped })).toBe(false)

    // A captured signature stays valid only for the challenge it was made for.
    const captured = await signer.sign(
      runtimeNodeProofMessage({ ...input, challengeId: 'eeeeeeee-5555-4555-8555-555555555555' })
    )
    expect(await verifyRuntimeNodeProof({ ...input, signature: captured })).toBe(false)
  })

  test('rejects a proof replayed against another workspace, node, or purpose', async () => {
    const { input, signature } = await signedProof()

    // The signature is genuine in every case below: what changes is the binding
    // the caller declares, which is exactly what the message is meant to fix.
    expect(
      await verifyRuntimeNodeProof({
        ...input,
        signature,
        workspaceId: 'bbbbbbbb-2222-4222-8222-222222222222',
      })
    ).toBe(false)
    expect(
      await verifyRuntimeNodeProof({
        ...input,
        signature,
        runtimeNodeId: 'ffffffff-6666-4666-8666-666666666666',
        purpose: 'proof',
      })
    ).toBe(false)
    expect(
      await verifyRuntimeNodeProof({ ...input, signature, purpose: 'rotate', runtimeNodeId })
    ).toBe(false)
    // A different remote host cannot claim the same pairing proof.
    expect(await verifyRuntimeNodeProof({ ...input, signature, kind: 'remote_host' })).toBe(false)
  })

  test('rejects a signature made by a different key', async () => {
    const { input } = await signedProof()
    const impostor = await keypair()
    const forged = await impostor.sign(runtimeNodeProofMessage({ ...input, kind: 'local_device' }))
    expect(await verifyRuntimeNodeProof({ ...input, signature: forged })).toBe(false)
  })

  test('treats malformed keys and signatures as failed proofs, never as exceptions', async () => {
    const { input, signature } = await signedProof()

    for (const publicKey of ['', 'not-base64url!', 'AAAA', 'A'.repeat(600)]) {
      expect(await verifyRuntimeNodeProof({ ...input, publicKey, signature })).toBe(false)
    }
    for (const bad of ['', 'AAAA', 'not-base64url!', `${signature}${signature}`]) {
      expect(await verifyRuntimeNodeProof({ ...input, signature: bad })).toBe(false)
    }
    expect(parseRuntimeNodePublicKey(input.publicKey)).toBe(input.publicKey)
    expect(parseRuntimeNodeSignature(signature)).toBe(signature)
    expect(parseRuntimeNodePublicKey('AAAA')).toBeNull()
    expect(parseRuntimeNodeSignature(`${signature}${signature}`)).toBeNull()
    expect(parseRuntimeNodeSignature(undefined)).toBeNull()
  })
})

describe('runtime node proof refusals', () => {
  test('every refusal reason reads as an instruction for the client', () => {
    const reasons = [
      'challenge_expired',
      'challenge_used',
      'invalid',
      'key_mismatch',
      'not_found',
      'revoked',
      'unauthorized',
    ] as const
    const messages = reasons.map(proofRefusalMessage)
    expect(new Set(messages).size).toBe(reasons.length)
    for (const message of messages) expect(message.length).toBeGreaterThan(10)
    // A revoked node is told it is revoked; an unknown node is not confirmed to exist.
    expect(proofRefusalMessage('revoked')).toMatch(/revoked/)
    expect(proofRefusalMessage('not_found')).toMatch(/unavailable/)
  })
})
