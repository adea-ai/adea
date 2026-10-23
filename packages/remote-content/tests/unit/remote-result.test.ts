import { describe, expect, test } from 'bun:test'
import {
  MAX_REMOTE_CONTENT_PLAINTEXT_BYTES,
  RemoteContentEnvelopeError,
  closeRemoteResultReceiver,
  createRemoteContentReplayGuard,
  createRemoteResultReceiver,
  deriveRemoteResultReceiver,
  generateRemoteCommandKeyPair,
  openRemoteContent,
  openRemoteResult,
  parseRemoteResultRecipient,
  sealRemoteContent,
  sealRemoteResult,
  type RemoteContentReplayClaim,
  type RemoteResultReceiver,
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

/** The receiver's public key as the host imports it for a host-side seal. */
const importRecipientKey = async (receiver: RemoteResultReceiver) => {
  const raw = Uint8Array.from(
    atob(receiver.recipient.publicKey.replaceAll('-', '+').replaceAll('_', '/') + '='),
    (character) => character.charCodeAt(0)
  )
  return crypto.subtle.importKey('raw', raw, { name: 'X25519' }, true, [])
}

/** Flip a middle base64url group so the encoding stays canonical. */
const tamperMiddle = (value: string) => {
  const index = Math.floor(value.length / 2)
  return `${value.slice(0, index)}${value[index] === 'A' ? 'B' : 'A'}${value.slice(index + 1)}`
}

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

  test('keeps the return key class separate from signing, runtime-command and content-sync keys', async () => {
    const receiver = await createReceiver()
    // The return key id names its own class. A runtime command key, a signing
    // key and a content-synchronization key are not return keys, so no
    // descriptor may claim one of their identities.
    for (const keyId of [
      'node-key-v1',
      'signing-key-v1',
      'content-sync-key-v1',
      'return_not-a-uuid',
      'return_00000000-0000-4000-8000-00000000000a-extra',
    ]) {
      expect(() => parseRemoteResultRecipient({ ...receiver.recipient, keyId })).toThrow()
      await expect(
        sealRemoteResult({
          recipient: { ...receiver.recipient, keyId },
          expectedScope: scope,
          plaintext: bytes('key purpose canary'),
          now,
        })
      ).rejects.toMatchObject({ code: 'invalid_envelope' })
    }
    // A runtime command envelope never enters the result path, whatever its
    // key id says.
    const nodeKeys = await generateRemoteCommandKeyPair()
    const command = await sealRemoteContent({
      keyId: 'node-key-v1',
      recipientPublicKey: nodeKeys.publicKey,
      plaintext: bytes('command direction canary'),
      aad: { ...scope, payloadType: 'command.input', schemaVersion: 1, issuedAt, expiresAt },
      now,
    })
    await expect(
      openRemoteResult({ receiver, envelope: command, replayGuard: guard(), now })
    ).rejects.toMatchObject({ code: 'invalid_envelope' })
    // A command-direction envelope that carries the receiver's own return key
    // id is refused on direction alone.
    for (const payloadType of ['command.input', 'execution.command', 'content.sync']) {
      const addressed = await sealRemoteContent({
        keyId: receiver.recipient.keyId,
        recipientPublicKey: await importRecipientKey(receiver),
        plaintext: bytes('direction canary'),
        aad: { ...scope, payloadType, schemaVersion: 1, issuedAt, expiresAt },
        now,
      })
      await expect(
        openRemoteResult({ receiver, envelope: addressed, replayGuard: guard(), now })
      ).rejects.toMatchObject({ code: 'invalid_envelope' })
    }
    closeRemoteResultReceiver(receiver)
  })

  test('refuses a superseded key epoch and keeps the current epoch releasable', async () => {
    const current = await createReceiver()
    const superseded = await createReceiver()
    expect(current.recipient.keyId).not.toBe(superseded.recipient.keyId)
    const sealedForCurrent = await sealRemoteResult({
      recipient: current.recipient,
      expectedScope: scope,
      plaintext: bytes('current epoch result'),
      now,
    })
    const sealedForSuperseded = await sealRemoteResult({
      recipient: superseded.recipient,
      expectedScope: scope,
      plaintext: bytes('superseded epoch result'),
      now,
    })
    // Neither epoch opens the other's envelope: the key epoch is bound to the
    // key id, not only to the shared request scope.
    await expect(
      openRemoteResult({
        receiver: superseded,
        envelope: sealedForCurrent,
        replayGuard: guard(),
        now,
      })
    ).rejects.toMatchObject({ code: 'invalid_envelope' })
    await expect(
      openRemoteResult({
        receiver: current,
        envelope: sealedForSuperseded,
        replayGuard: guard(),
        now,
      })
    ).rejects.toMatchObject({ code: 'invalid_envelope' })
    closeRemoteResultReceiver(superseded)
    await expect(
      openRemoteResult({
        receiver: superseded,
        envelope: sealedForSuperseded,
        replayGuard: guard(),
        now,
      })
    ).rejects.toMatchObject({ code: 'return_key_unavailable' })
    await expect(
      openRemoteResult({ receiver: current, envelope: sealedForCurrent, replayGuard: guard(), now })
    ).resolves.toEqual(bytes('current epoch result'))
  })

  test('a revoked epoch releases no plaintext and stays revoked for later deliveries', async () => {
    const receiver = await createReceiver()
    const envelope = await sealRemoteResult({
      recipient: receiver.recipient,
      expectedScope: scope,
      plaintext: bytes('revoked epoch secret'),
      now,
    })
    closeRemoteResultReceiver(receiver)
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await openRemoteResult({
        receiver,
        envelope,
        replayGuard: guard(),
        now,
      }).catch((cause: unknown) => cause)
      expect(error).toMatchObject({ code: 'return_key_unavailable' })
      expect(String(error)).not.toContain('revoked epoch secret')
    }
    // A replacement epoch for the same request inherits nothing from the
    // revoked one.
    const replacement = await createReceiver()
    await expect(
      openRemoteResult({ receiver: replacement, envelope, replayGuard: guard(), now })
    ).rejects.toMatchObject({ code: 'invalid_envelope' })
    closeRemoteResultReceiver(replacement)
  })

  test('refuses malformed associated data before it can reach the return key', async () => {
    const receiver = await createReceiver()
    const envelope = await sealRemoteResult({
      recipient: receiver.recipient,
      expectedScope: scope,
      plaintext: bytes('malformed aad result'),
      now,
    })
    const withoutPayloadType = { ...envelope.aad } as Record<string, unknown>
    delete withoutPayloadType.payloadType
    const malformed = [
      { ...envelope, aad: withoutPayloadType },
      { ...envelope, aad: { ...envelope.aad, unexpected: 'field' } },
      { ...envelope, aad: { ...envelope.aad, issuedAt: '2026-10-07T12:00:00Z' } },
      { ...envelope, aad: { ...envelope.aad, requestId: 'not-a-uuid' } },
      { ...envelope, aad: { ...envelope.aad, schemaVersion: 2 } },
      { ...envelope, aad: { ...envelope.aad, payloadType: 'Execution.Result' } },
      { ...envelope, aad: { ...envelope.aad, contentDigest: 'z'.repeat(64) } },
      {
        ...envelope,
        aad: { ...envelope.aad, keyId: 'return_00000000-0000-4000-8000-00000000000a' },
      },
      { ...envelope, aad: { ...envelope.aad, expiresAt: '2026-10-07T12:11:00.000Z' } },
    ]
    for (const candidate of malformed)
      await expect(
        openRemoteResult({ receiver, envelope: candidate, replayGuard: guard(), now })
      ).rejects.toBeInstanceOf(RemoteContentEnvelopeError)
    // Every refusal happened before the return key was used, so the untouched
    // envelope still releases exactly once.
    await expect(
      openRemoteResult({ receiver, envelope, replayGuard: guard(), now })
    ).resolves.toEqual(bytes('malformed aad result'))
  })

  test('fails closed on envelope, suite and schema downgrade', async () => {
    const receiver = await createReceiver()
    const envelope = await sealRemoteResult({
      recipient: receiver.recipient,
      expectedScope: scope,
      plaintext: bytes('downgrade guarded result'),
      now,
    })
    await expect(
      openRemoteResult({
        receiver,
        envelope: { ...envelope, version: 0 as const },
        replayGuard: guard(),
        now,
      })
    ).rejects.toMatchObject({ code: 'unsupported_version' })
    await expect(
      openRemoteResult({
        receiver,
        envelope: { ...envelope, suite: 'DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/ChaCha20-Poly1305' },
        replayGuard: guard(),
        now,
      })
    ).rejects.toMatchObject({ code: 'unsupported_suite' })
    await expect(
      openRemoteResult({
        receiver,
        envelope: { ...envelope, aad: { ...envelope.aad, version: 0 as const } },
        replayGuard: guard(),
        now,
      })
    ).rejects.toMatchObject({ code: 'unsupported_version' })
    await expect(
      openRemoteResult({
        receiver,
        envelope: { ...envelope, aad: { ...envelope.aad, schemaVersion: 2 } },
        replayGuard: guard(),
        now,
      })
    ).rejects.toMatchObject({ code: 'invalid_envelope' })
    await expect(
      openRemoteResult({ receiver, envelope, replayGuard: guard(), now })
    ).resolves.toEqual(bytes('downgrade guarded result'))
  })

  test('never echoes plaintext, key material or library detail in a failure', async () => {
    const receiver = await createReceiver()
    const secret = 'never echo this return plaintext'
    const envelope = await sealRemoteResult({
      recipient: receiver.recipient,
      expectedScope: scope,
      plaintext: bytes(secret),
      now,
    })
    const failures = [
      { ...envelope, ciphertext: tamperMiddle(envelope.ciphertext) },
      { ...envelope, aad: { ...envelope.aad, payloadType: 'command.input' } },
      { ...envelope, version: 0 as const },
      { ...envelope, suite: 'DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/ChaCha20-Poly1305' },
      { ...envelope, aad: { ...envelope.aad, requestId: '00000000-0000-4000-8000-000000000099' } },
    ]
    for (const candidate of failures) {
      const error = await openRemoteResult({
        receiver,
        envelope: candidate,
        replayGuard: guard(),
        now,
      }).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(RemoteContentEnvelopeError)
      const text = String(error)
      expect(text).not.toContain(secret)
      expect(text).not.toContain(receiver.recipient.publicKey)
      expect(text).not.toContain(receiver.recipient.keyId)
      expect(text).not.toContain('X25519')
      expect(text).not.toContain('hpke')
      expect((error as RemoteContentEnvelopeError).cause).toBeUndefined()
    }
  })

  test('persists ciphertext and bounded metadata only', async () => {
    const receiver = await createReceiver()
    const secret = 'relay persists ciphertext only'
    const envelope = await sealRemoteResult({
      recipient: receiver.recipient,
      expectedScope: scope,
      plaintext: bytes(secret),
      now,
    })
    expect(Object.keys(envelope).toSorted()).toEqual([
      'aad',
      'ciphertext',
      'enc',
      'keyId',
      'suite',
      'version',
    ])
    expect(Object.keys(envelope.aad).toSorted()).toEqual([
      'expiresAt',
      'issuedAt',
      'keyId',
      'payloadType',
      'requestId',
      'runtimeNodeId',
      'schemaVersion',
      'version',
      'workspaceId',
    ])
    const persisted = JSON.stringify(envelope)
    expect(persisted).not.toContain(secret)
    // The receiver is a capability, not a record: only the public descriptor
    // survives serialization, so nothing persisted can carry the return key.
    const serializedReceiver = JSON.parse(JSON.stringify(receiver))
    expect(Object.keys(serializedReceiver)).toEqual(['recipient'])
    expect(Object.keys(serializedReceiver.recipient).toSorted()).toEqual([
      'expiresAt',
      'issuedAt',
      'keyId',
      'publicKey',
      'requestId',
      'runtimeNodeId',
      'version',
      'workspaceId',
    ])
    expect(JSON.stringify(serializedReceiver)).not.toContain('privateKey')
    closeRemoteResultReceiver(receiver)
  })

  test('derives a deterministic fixture receiver with the same single-release boundary', async () => {
    const ikm = bytes('synthetic return key material for the derived receiver')
    const keyId = 'return_00000000-0000-4000-8000-00000000000a'
    const first = await deriveRemoteResultReceiver({
      ...scope,
      keyId,
      ikm,
      issuedAt,
      expiresAt,
      now,
    })
    const second = await deriveRemoteResultReceiver({
      ...scope,
      keyId,
      ikm,
      issuedAt,
      expiresAt,
      now,
    })
    expect(first.recipient).toEqual(second.recipient)
    expect(JSON.parse(JSON.stringify(first))).toEqual({ recipient: first.recipient })
    const envelope = await sealRemoteResult({
      recipient: first.recipient,
      expectedScope: scope,
      plaintext: bytes('derived receiver result'),
      now,
    })
    await expect(
      openRemoteResult({ receiver: second, envelope, replayGuard: guard(), now })
    ).resolves.toEqual(bytes('derived receiver result'))
    await expect(
      openRemoteResult({ receiver: first, envelope, replayGuard: guard(), now })
    ).resolves.toEqual(bytes('derived receiver result'))
    await expect(
      openRemoteResult({ receiver: first, envelope, replayGuard: guard(), now })
    ).rejects.toMatchObject({ code: 'return_key_unavailable' })
    // A derived receiver never widens the key class it may carry.
    await expect(
      deriveRemoteResultReceiver({ ...scope, keyId: 'node-key-v1', ikm, issuedAt, expiresAt, now })
    ).rejects.toMatchObject({ code: 'invalid_envelope' })
    await expect(
      deriveRemoteResultReceiver({
        ...scope,
        keyId,
        ikm,
        issuedAt,
        expiresAt,
        now: Date.parse(expiresAt),
      })
    ).rejects.toMatchObject({ code: 'expired' })
  })
})
