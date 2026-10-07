import { describe, expect, test } from 'bun:test'
import {
  MAX_REMOTE_CONTENT_PLAINTEXT_BYTES,
  closeRemoteResultReceiver,
  createRemoteContentReplayGuard,
  createRemoteResultReceiver,
  generateRemoteCommandKeyPair,
  openRemoteContent,
  openRemoteResult,
  parseRemoteResultRecipient,
  sealRemoteContent,
  sealRemoteResult,
  type RemoteContentReplayClaim,
} from '../../src/index'

const issuedAt = '2026-10-07T12:00:00.000Z'
const expiresAt = '2026-10-07T12:10:00.000Z'
const now = Date.parse('2026-10-07T12:05:00.000Z')
const scope = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  runtimeNodeId: '00000000-0000-4000-8000-000000000002',
  requestId: '00000000-0000-4000-8000-000000000003',
}
const bytes = (text: string) => new TextEncoder().encode(text)
const createReceiver = () => createRemoteResultReceiver({ ...scope, issuedAt, expiresAt, now })
const guard = (claim: (input: RemoteContentReplayClaim) => Promise<boolean> = async () => true) =>
  createRemoteContentReplayGuard({ ...scope, ledger: { claim }, now: () => now })

describe('request-bound encrypted execution results', () => {
  test('only the requesting client can open the result and its private key never serializes', async () => {
    const receiver = await createReceiver()
    const otherClient = await createReceiver()
    const nodeKeys = await generateRemoteCommandKeyPair()
    const secret = bytes('private result canary: repository and provider content')
    const envelope = await sealRemoteResult({
      recipient: receiver.recipient,
      expectedScope: scope,
      plaintext: secret,
      now,
    })
    expect(receiver.recipient.keyId).not.toBe(otherClient.recipient.keyId)
    expect(receiver.recipient.publicKey).not.toBe(otherClient.recipient.publicKey)
    expect(JSON.parse(JSON.stringify(receiver))).toEqual({ recipient: receiver.recipient })
    expect(JSON.stringify(envelope)).not.toContain('private result canary')
    await expect(
      openRemoteContent({
        envelope,
        keyId: envelope.keyId,
        recipientPrivateKey: nodeKeys.privateKey,
        replayGuard: guard(),
        now,
      })
    ).rejects.toMatchObject({ code: 'decryption_failed' })
    await expect(
      openRemoteResult({ receiver: otherClient, envelope, replayGuard: guard(), now })
    ).rejects.toMatchObject({ code: 'invalid_envelope' })
    closeRemoteResultReceiver(otherClient)
    await expect(
      openRemoteResult({
        receiver: JSON.parse(JSON.stringify(receiver)),
        envelope,
        replayGuard: guard(),
        now,
      })
    ).rejects.toMatchObject({ code: 'return_key_unavailable' })
    await expect(
      openRemoteResult({ receiver, envelope, replayGuard: guard(), now })
    ).resolves.toEqual(secret)
    await expect(
      openRemoteResult({ receiver, envelope, replayGuard: guard(), now })
    ).rejects.toMatchObject({ code: 'return_key_unavailable' })
  })

  test('binds the public return descriptor to the independently authorized command scope', async () => {
    const receiver = await createReceiver()
    for (const key of ['workspaceId', 'runtimeNodeId', 'requestId'] as const) {
      await expect(
        sealRemoteResult({
          recipient: receiver.recipient,
          expectedScope: { ...scope, [key]: '00000000-0000-4000-8000-000000000099' },
          plaintext: bytes('scope canary'),
          now,
        })
      ).rejects.toMatchObject({ code: 'invalid_envelope' })
    }
    for (const recipient of [
      { ...receiver.recipient, privateKey: 'must never be accepted' },
      { ...receiver.recipient, publicKey: 'A'.repeat(1024 * 1024) },
      { ...receiver.recipient, expiresAt: 'A'.repeat(1024 * 1024) },
      { ...receiver.recipient, publicKey: receiver.recipient.publicKey.slice(0, -1) + 'B' },
      { ...receiver.recipient, keyId: 'node-command-key' },
      { ...receiver.recipient, version: 0 },
      { ...receiver.recipient, expiresAt: issuedAt },
      { ...receiver.recipient, expiresAt: '2026-10-09T12:10:00.000Z' },
    ])
      expect(() => parseRemoteResultRecipient(recipient)).toThrow()
    expect(parseRemoteResultRecipient(JSON.parse(JSON.stringify(receiver.recipient)))).toEqual(
      receiver.recipient
    )
    closeRemoteResultReceiver(receiver)
  })

  test('the standards library refuses a low-order X25519 return recipient', async () => {
    const receiver = await createReceiver()
    await expect(
      sealRemoteResult({
        recipient: { ...receiver.recipient, publicKey: 'A'.repeat(43) },
        expectedScope: scope,
        plaintext: bytes('low-order canary'),
        now,
      })
    ).rejects.toMatchObject({ code: 'encryption_failed' })
    closeRemoteResultReceiver(receiver)
  })

  test('refuses tampered direction, scope, lifetime and ciphertext without consuming the receiver', async () => {
    const receiver = await createReceiver()
    const envelope = await sealRemoteResult({
      recipient: receiver.recipient,
      expectedScope: scope,
      plaintext: bytes('untampered result'),
      now,
    })
    const replacements = [
      { ...envelope, aad: { ...envelope.aad, payloadType: 'command.input' } },
      { ...envelope, aad: { ...envelope.aad, requestId: '00000000-0000-4000-8000-000000000099' } },
      { ...envelope, aad: { ...envelope.aad, expiresAt: '2026-10-07T12:11:00.000Z' } },
      { ...envelope, aad: { ...envelope.aad, issuedAt: '2026-10-07T12:01:00.000Z' } },
      {
        ...envelope,
        ciphertext: (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1),
      },
    ]
    for (const candidate of replacements)
      await expect(
        openRemoteResult({ receiver, envelope: candidate, replayGuard: guard(), now })
      ).rejects.toThrow()
    await expect(
      openRemoteResult({ receiver, envelope, replayGuard: guard(), now })
    ).resolves.toEqual(bytes('untampered result'))
  })

  test('requires an atomic replay ledger and allows only one concurrent plaintext release', async () => {
    const receiver = await createReceiver()
    const envelope = await sealRemoteResult({
      recipient: receiver.recipient,
      expectedScope: scope,
      plaintext: bytes('release once'),
      now,
    })
    await expect(
      openRemoteResult({ receiver, envelope, replayGuard: undefined, now })
    ).rejects.toMatchObject({ code: 'replay_unavailable' })
    await expect(
      openRemoteResult({ receiver, envelope, replayGuard: guard(async () => false), now })
    ).rejects.toMatchObject({ code: 'replayed' })
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const claims: RemoteContentReplayClaim[] = []
    const first = openRemoteResult({
      receiver,
      envelope,
      replayGuard: guard(async (claim) => {
        claims.push(claim)
        await blocked
        return true
      }),
      now,
    })
    await expect(
      openRemoteResult({ receiver, envelope, replayGuard: guard(), now })
    ).rejects.toMatchObject({ code: 'replayed' })
    release?.()
    await expect(first).resolves.toEqual(bytes('release once'))
    expect(claims).toHaveLength(1)
    expect(claims[0]?.requestId).toBe(scope.requestId)
    expect(claims[0]?.keyId).toBe(receiver.recipient.keyId)
  })

  test('cancellation or account/workspace disposal during a ledger await cannot release plaintext', async () => {
    const receiver = await createReceiver()
    const envelope = await sealRemoteResult({
      recipient: receiver.recipient,
      expectedScope: scope,
      plaintext: bytes('cancelled result'),
      now,
    })
    const replayGuard = guard(async () => {
      closeRemoteResultReceiver(receiver)
      return true
    })
    await expect(openRemoteResult({ receiver, envelope, replayGuard, now })).rejects.toMatchObject({
      code: 'return_key_unavailable',
    })
    await expect(
      openRemoteResult({ receiver, envelope, replayGuard: guard(), now })
    ).rejects.toMatchObject({ code: 'return_key_unavailable' })
  })

  test('rejects expired, future and oversized return content and does not echo it in errors', async () => {
    await expect(
      createRemoteResultReceiver({ ...scope, issuedAt, expiresAt, now: Date.parse(expiresAt) })
    ).rejects.toMatchObject({ code: 'expired' })
    await expect(
      createRemoteResultReceiver({ ...scope, issuedAt, expiresAt, now: Date.parse(issuedAt) - 1 })
    ).rejects.toMatchObject({ code: 'invalid_envelope' })
    const receiver = await createReceiver()
    await expect(
      sealRemoteResult({
        recipient: receiver.recipient,
        expectedScope: scope,
        plaintext: new Uint8Array(MAX_REMOTE_CONTENT_PLAINTEXT_BYTES + 1),
        now,
      })
    ).rejects.toMatchObject({ code: 'payload_too_large' })
    const envelope = await sealRemoteResult({
      recipient: receiver.recipient,
      expectedScope: scope,
      plaintext: bytes('never echo secret result'),
      now,
    })
    const error = await openRemoteResult({
      receiver,
      envelope,
      replayGuard: guard(),
      now: Date.parse(expiresAt),
    }).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'expired' })
    expect(String(error)).not.toContain('never echo secret result')
    closeRemoteResultReceiver(receiver)
  })

  test('a command addressed to the same raw public key still cannot enter the result receiver', async () => {
    const receiver = await createReceiver()
    const raw = Uint8Array.from(
      atob(receiver.recipient.publicKey.replaceAll('-', '+').replaceAll('_', '/') + '='),
      (c) => c.charCodeAt(0)
    )
    const publicKey = await crypto.subtle.importKey('raw', raw, { name: 'X25519' }, true, [])
    const command = await sealRemoteContent({
      keyId: receiver.recipient.keyId,
      recipientPublicKey: publicKey,
      plaintext: bytes('command is not a result'),
      aad: { ...scope, payloadType: 'command.input', schemaVersion: 1, issuedAt, expiresAt },
      now,
    })
    await expect(
      openRemoteResult({ receiver, envelope: command, replayGuard: guard(), now })
    ).rejects.toMatchObject({ code: 'invalid_envelope' })
    closeRemoteResultReceiver(receiver)
  })
})
