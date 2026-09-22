import { describe, expect, test } from 'bun:test'

import {
  MAX_REMOTE_CONTENT_CIPHERTEXT_BYTES,
  MAX_REMOTE_CONTENT_PLAINTEXT_BYTES,
  REMOTE_CONTENT_SUITE,
  REMOTE_CONTENT_SCHEMA_VERSION,
  REMOTE_CONTENT_VERSION,
  RemoteContentEnvelopeError,
  createRemoteContentAad,
  deriveRemoteCommandKeyPair,
  openRemoteContent,
  sealRemoteContent,
} from '../../src/index'
import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core'

import vector from '../../fixtures/remote-content-envelope-v1.json'

const NOW = '2026-09-22T12:00:00.000Z'
const LATER = '2026-09-22T12:05:00.000Z'
const EXPIRES = '2026-09-22T12:10:00.000Z'
const METADATA = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  runtimeNodeId: '00000000-0000-4000-8000-000000000002',
  requestId: '00000000-0000-4000-8000-000000000003',
  payloadType: 'command.input',
  schemaVersion: 1,
  issuedAt: NOW,
  expiresAt: EXPIRES,
  contentDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const

const toBytes = (value: string) => new TextEncoder().encode(value)
const fromBytes = (value: Uint8Array) => new TextDecoder().decode(value)
const toBase64Url = (value: ArrayBufferLike | ArrayBufferView) => {
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

describe('RemoteContentEnvelope v1', () => {
  test('matches the checked-in standards-library cross-runtime vector', async () => {
    const hpke = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes128Gcm(),
    })
    const recipient = await hpke.kem.deriveKeyPair(toBytes(vector.recipientIkm))
    const sender = await hpke.createSenderContext({
      recipientPublicKey: recipient.publicKey,
      info: toBytes('adea-remote-content-envelope:v1'),
      ekm: toBytes(vector.ephemeralIkm),
    })
    const ciphertext = await sender.seal(
      toBytes(vector.plaintext),
      toBytes(JSON.stringify(vector.aad))
    )

    expect(toBase64Url(sender.enc)).toBe(vector.enc)
    expect(toBase64Url(ciphertext)).toBe(vector.ciphertext)

    const plaintext = await openRemoteContent({
      envelope: {
        version: 1,
        suite: REMOTE_CONTENT_SUITE,
        keyId: 'node-key-v1',
        enc: vector.enc,
        ciphertext: vector.ciphertext,
        aad: vector.aad,
      },
      keyId: 'node-key-v1',
      recipientPrivateKey: recipient.privateKey,
      now: LATER,
    })
    expect(fromBytes(plaintext)).toBe(vector.plaintext)
  })

  test('encrypts and decrypts with the fixed RFC 9180 suite', async () => {
    const recipient = await deriveRemoteCommandKeyPair(
      toBytes('recipient key material for vector 0001')
    )
    const envelope = await sealRemoteContent({
      keyId: 'node-key-v1',
      recipientPublicKey: recipient.publicKey,
      aad: METADATA,
      plaintext: toBytes('cross-runtime command fixture'),
      now: NOW,
    })

    expect(envelope.version).toBe(REMOTE_CONTENT_VERSION)
    expect(envelope.suite).toBe(REMOTE_CONTENT_SUITE)
    expect(envelope.aad).toEqual(createRemoteContentAad(METADATA))
    expect(envelope.enc).toHaveLength(43)
    expect(envelope.ciphertext).not.toContain('cross-runtime')

    const plaintext = await openRemoteContent({
      envelope,
      keyId: envelope.keyId,
      recipientPrivateKey: recipient.privateKey,
      now: LATER,
    })
    expect(fromBytes(plaintext)).toBe('cross-runtime command fixture')
  })

  test('rejects an envelope with a changed associated-data field', async () => {
    const recipient = await deriveRemoteCommandKeyPair(
      toBytes('recipient key material for vector 0002')
    )
    const envelope = await sealRemoteContent({
      keyId: 'node-key-v1',
      recipientPublicKey: recipient.publicKey,
      aad: METADATA,
      plaintext: toBytes('authenticated content'),
      now: NOW,
    })
    const tampered = structuredClone(envelope)
    tampered.aad.requestId = '00000000-0000-4000-8000-000000000004'

    await expect(
      openRemoteContent({
        envelope: tampered,
        keyId: envelope.keyId,
        recipientPrivateKey: recipient.privateKey,
        now: LATER,
      })
    ).rejects.toMatchObject({
      code: 'decryption_failed',
    })
  })

  test('rejects wrong recipients, ciphertext tampering, expiry, downgrade, and malformed envelopes', async () => {
    const recipient = await deriveRemoteCommandKeyPair(
      toBytes('recipient key material for vector 0003')
    )
    const wrongRecipient = await deriveRemoteCommandKeyPair(
      toBytes('wrong recipient key material 0003')
    )
    const envelope = await sealRemoteContent({
      keyId: 'node-key-v1',
      recipientPublicKey: recipient.publicKey,
      aad: METADATA,
      plaintext: toBytes('negative fixture'),
      now: NOW,
    })

    await expect(
      openRemoteContent({
        envelope,
        keyId: envelope.keyId,
        recipientPrivateKey: wrongRecipient.privateKey,
        now: LATER,
      })
    ).rejects.toMatchObject({
      code: 'decryption_failed',
    })

    const ciphertextTampered = structuredClone(envelope)
    ciphertextTampered.ciphertext = `${ciphertextTampered.ciphertext.slice(0, -1)}${ciphertextTampered.ciphertext.endsWith('A') ? 'B' : 'A'}`
    await expect(
      openRemoteContent({
        envelope: ciphertextTampered,
        keyId: envelope.keyId,
        recipientPrivateKey: recipient.privateKey,
        now: LATER,
      })
    ).rejects.toMatchObject({
      code: 'decryption_failed',
    })

    await expect(
      openRemoteContent({
        envelope,
        keyId: envelope.keyId,
        recipientPrivateKey: recipient.privateKey,
        now: '2026-09-22T12:11:00.000Z',
      })
    ).rejects.toMatchObject({
      code: 'expired',
    })

    const downgraded = { ...envelope, version: 0 as const }
    await expect(
      openRemoteContent({
        envelope: downgraded,
        keyId: envelope.keyId,
        recipientPrivateKey: recipient.privateKey,
        now: LATER,
      })
    ).rejects.toMatchObject({
      code: 'unsupported_version',
    })

    const malformed = { ...envelope, aad: { ...envelope.aad, unexpected: 'field' } }
    await expect(
      openRemoteContent({
        envelope: malformed,
        keyId: envelope.keyId,
        recipientPrivateKey: recipient.privateKey,
        now: LATER,
      })
    ).rejects.toMatchObject({
      code: 'invalid_envelope',
    })
  })

  test('rejects unsupported suites, schemas, wrong key ids, and oversized payloads before crypto', async () => {
    const recipient = await deriveRemoteCommandKeyPair(
      toBytes('recipient key material for vector 0004')
    )
    const envelope = await sealRemoteContent({
      keyId: 'node-key-v1',
      recipientPublicKey: recipient.publicKey,
      aad: METADATA,
      plaintext: toBytes('bounded payload'),
      now: NOW,
    })

    await expect(
      openRemoteContent({
        envelope: { ...envelope, suite: 'DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/ChaCha20-Poly1305' },
        keyId: envelope.keyId,
        recipientPrivateKey: recipient.privateKey,
        now: LATER,
      })
    ).rejects.toMatchObject({ code: 'unsupported_suite' })

    await expect(
      openRemoteContent({
        envelope: {
          ...envelope,
          aad: { ...envelope.aad, schemaVersion: REMOTE_CONTENT_SCHEMA_VERSION + 1 },
        },
        keyId: envelope.keyId,
        recipientPrivateKey: recipient.privateKey,
        now: LATER,
      })
    ).rejects.toMatchObject({ code: 'invalid_envelope' })

    await expect(
      openRemoteContent({
        envelope,
        keyId: 'node-key-v2',
        recipientPrivateKey: recipient.privateKey,
        now: LATER,
      })
    ).rejects.toMatchObject({ code: 'key_mismatch' })

    const oversized = {
      ...envelope,
      ciphertext: 'A'.repeat(MAX_REMOTE_CONTENT_CIPHERTEXT_BYTES * 2),
    }
    await expect(
      openRemoteContent({
        envelope: oversized,
        keyId: envelope.keyId,
        recipientPrivateKey: recipient.privateKey,
        now: LATER,
      })
    ).rejects.toMatchObject({
      code: 'payload_too_large',
    })

    await expect(
      sealRemoteContent({
        keyId: 'node-key-v1',
        recipientPublicKey: recipient.publicKey,
        aad: METADATA,
        plaintext: new Uint8Array(MAX_REMOTE_CONTENT_PLAINTEXT_BYTES + 1),
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'payload_too_large' })
  })

  test('keeps the error surface stable and free of plaintext', async () => {
    const recipient = await deriveRemoteCommandKeyPair(
      toBytes('recipient key material for vector 0005')
    )
    const secret = 'do not echo this fixture plaintext'
    const rejection = await openRemoteContent({
      envelope: { version: REMOTE_CONTENT_VERSION } as never,
      keyId: 'node-key-v1',
      recipientPrivateKey: recipient.privateKey,
      now: LATER,
    }).catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(RemoteContentEnvelopeError)
    expect(String(rejection)).not.toContain(secret)
    expect((rejection as RemoteContentEnvelopeError).code).toBe('invalid_envelope')
  })
})
