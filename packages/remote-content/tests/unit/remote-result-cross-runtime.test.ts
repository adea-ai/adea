import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core'

import {
  REMOTE_CONTENT_SUITE,
  createRemoteContentReplayGuard,
  deriveRemoteCommandKeyPair,
  deriveRemoteResultReceiver,
  openRemoteContent,
  openRemoteResult,
  parseRemoteResultRecipient,
} from '../../src/index'

import commandVector from '../../fixtures/remote-content-envelope-v1.json'
import resultVector from '../../fixtures/remote-result-cross-runtime-v1.json'

/**
 * The checked-in result vector holds ciphertext only, so the plaintext it
 * protects lives here, in the test, and never in the fixture.
 */
const RESULT_PLAINTEXT = 'cross-runtime return result canary'
const REVOKED_PLAINTEXT = 'revoked epoch return result canary'
const VECTOR_NOW = Date.parse('2026-09-22T12:05:00.000Z')
const entry = new URL('../../dist/index.js', import.meta.url).href
const resultFixturePath = fileURLToPath(
  new URL('../../fixtures/remote-result-cross-runtime-v1.json', import.meta.url)
)
const commandFixturePath = fileURLToPath(
  new URL('../../fixtures/remote-content-envelope-v1.json', import.meta.url)
)

const toBytes = (value: string) => new TextEncoder().encode(value)
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

/** Run the compiled Node ESM entry in a second runtime and read its report. */
const runNode = (script: string) =>
  JSON.parse(
    execFileSync('node', ['--input-type=module', '--eval', script], { encoding: 'utf8' })
  ) as Record<string, unknown>

const resultScope = {
  workspaceId: resultVector.active.recipient.workspaceId,
  runtimeNodeId: resultVector.active.recipient.runtimeNodeId,
  requestId: resultVector.active.recipient.requestId,
}
const resultGuard = () =>
  createRemoteContentReplayGuard({
    ...resultScope,
    ledger: { claim: async () => true },
    now: () => VECTOR_NOW,
  })

const resultEnvelope = (epoch: typeof resultVector.active) => ({
  version: 1,
  suite: REMOTE_CONTENT_SUITE,
  keyId: epoch.recipient.keyId,
  enc: epoch.enc,
  ciphertext: epoch.ciphertext,
  aad: epoch.aad,
})

const nodeResultScript = `
    const library = await import(${JSON.stringify(entry)});
    const { readFileSync } = await import('node:fs');
    const vector = JSON.parse(readFileSync(${JSON.stringify(resultFixturePath)}, 'utf8'));
    const now = Date.parse(vector.active.recipient.issuedAt) + 300000;
    const scope = {
      workspaceId: vector.active.recipient.workspaceId,
      runtimeNodeId: vector.active.recipient.runtimeNodeId,
      requestId: vector.active.recipient.requestId,
    };
    const receiver = await library.deriveRemoteResultReceiver({
      ...scope,
      keyId: vector.active.recipient.keyId,
      ikm: new TextEncoder().encode(vector.active.recipientIkm),
      issuedAt: vector.active.recipient.issuedAt,
      expiresAt: vector.active.recipient.expiresAt,
      now,
    });
    const replayGuard = library.createRemoteContentReplayGuard({
      ...scope,
      ledger: { claim: async () => true },
      now: () => now,
    });
    const envelope = {
      version: 1,
      suite: library.REMOTE_CONTENT_SUITE,
      keyId: vector.active.recipient.keyId,
      enc: vector.active.enc,
      ciphertext: vector.active.ciphertext,
      aad: vector.active.aad,
    };
    const revokedEnvelope = {
      version: 1,
      suite: library.REMOTE_CONTENT_SUITE,
      keyId: vector.revoked.recipient.keyId,
      enc: vector.revoked.enc,
      ciphertext: vector.revoked.ciphertext,
      aad: vector.revoked.aad,
    };
    let revokedCode = '';
    let revokedMessage = '';
    try {
      await library.openRemoteResult({ receiver, envelope: revokedEnvelope, replayGuard, now });
    } catch (error) {
      revokedCode = error.code;
      revokedMessage = String(error);
    }
    const plaintext = await library.openRemoteResult({ receiver, envelope, replayGuard, now });
    let replayCode = '';
    try {
      await library.openRemoteResult({ receiver, envelope, replayGuard, now });
    } catch (error) {
      replayCode = error.code;
    }
    console.log(JSON.stringify({
      plaintext: new TextDecoder().decode(plaintext),
      revokedCode,
      revokedMessage,
      replayCode,
      publicKey: receiver.recipient.publicKey,
      privateKeySerialized: Object.hasOwn(JSON.parse(JSON.stringify(receiver)), 'privateKey'),
    }));
  `

const nodeCommandScript = `
    const library = await import(${JSON.stringify(entry)});
    const { readFileSync } = await import('node:fs');
    const vector = JSON.parse(readFileSync(${JSON.stringify(commandFixturePath)}, 'utf8'));
    const now = Date.parse(vector.aad.issuedAt) + 300000;
    const recipient = await library.deriveRemoteCommandKeyPair(
      new TextEncoder().encode(vector.recipientIkm)
    );
    const replayGuard = library.createRemoteContentReplayGuard({
      workspaceId: vector.aad.workspaceId,
      runtimeNodeId: vector.aad.runtimeNodeId,
      ledger: { claim: async () => true },
      now: () => now,
    });
    const plaintext = await library.openRemoteContent({
      envelope: {
        version: 1,
        suite: library.REMOTE_CONTENT_SUITE,
        keyId: vector.aad.keyId,
        enc: vector.enc,
        ciphertext: vector.ciphertext,
        aad: vector.aad,
      },
      keyId: vector.aad.keyId,
      recipientPrivateKey: recipient.privateKey,
      replayGuard,
      now,
    });
    console.log(JSON.stringify({ plaintext: new TextDecoder().decode(plaintext) }));
  `

describe('cross-runtime remote content vectors', () => {
  test('the standards library reproduces the checked-in return vector byte for byte', async () => {
    const hpke = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes128Gcm(),
    })
    const epochs = [
      { epoch: resultVector.active, plaintext: RESULT_PLAINTEXT },
      { epoch: resultVector.revoked, plaintext: REVOKED_PLAINTEXT },
    ]
    for (const { epoch, plaintext } of epochs) {
      const recipient = await hpke.kem.deriveKeyPair(toBytes(epoch.recipientIkm))
      const sender = await hpke.createSenderContext({
        recipientPublicKey: recipient.publicKey,
        info: toBytes(`adea-remote-content-envelope:v1\u0000${epoch.recipient.keyId}`),
        ekm: toBytes(epoch.ephemeralIkm),
      })
      const ciphertext = await sender.seal(toBytes(plaintext), toBytes(JSON.stringify(epoch.aad)))
      expect(toBase64Url(sender.enc)).toBe(epoch.enc)
      expect(toBase64Url(ciphertext)).toBe(epoch.ciphertext)
      expect(toBase64Url(await crypto.subtle.exportKey('raw', recipient.publicKey))).toBe(
        epoch.recipient.publicKey
      )
    }
  })

  test('the client-bound return vector decrypts to the same plaintext in Bun and in Node', async () => {
    const receiver = await deriveRemoteResultReceiver({
      ...resultScope,
      keyId: resultVector.active.recipient.keyId,
      ikm: toBytes(resultVector.active.recipientIkm),
      issuedAt: resultVector.active.recipient.issuedAt,
      expiresAt: resultVector.active.recipient.expiresAt,
      now: VECTOR_NOW,
    })
    expect(receiver.recipient.publicKey).toBe(resultVector.active.recipient.publicKey)
    expect(receiver.recipient.keyId).toBe(resultVector.active.recipient.keyId)

    // A revoked epoch of the same request never enters the current one, and
    // the refusal does not consume the epoch.
    const revoked = await openRemoteResult({
      receiver,
      envelope: resultEnvelope(resultVector.revoked),
      replayGuard: resultGuard(),
      now: VECTOR_NOW,
    }).catch((cause: unknown) => cause)
    expect(revoked).toMatchObject({ code: 'invalid_envelope' })
    expect(String(revoked)).not.toContain(REVOKED_PLAINTEXT)

    const plaintext = await openRemoteResult({
      receiver,
      envelope: resultEnvelope(resultVector.active),
      replayGuard: resultGuard(),
      now: VECTOR_NOW,
    })
    expect(new TextDecoder().decode(plaintext)).toBe(RESULT_PLAINTEXT)

    const report = runNode(nodeResultScript)
    expect(report).toEqual({
      plaintext: RESULT_PLAINTEXT,
      revokedCode: 'invalid_envelope',
      revokedMessage: expect.stringContaining('invalid_envelope'),
      replayCode: 'return_key_unavailable',
      publicKey: resultVector.active.recipient.publicKey,
      privateKeySerialized: false,
    })
    expect(String(report.revokedMessage)).not.toContain(REVOKED_PLAINTEXT)
    expect(String(report.revokedMessage)).not.toContain(RESULT_PLAINTEXT)
  })

  test('the command vector decrypts to the same plaintext in Bun and in Node', async () => {
    const recipient = await deriveRemoteCommandKeyPair(toBytes(commandVector.recipientIkm))
    const plaintext = await openRemoteContent({
      envelope: {
        version: 1,
        suite: REMOTE_CONTENT_SUITE,
        keyId: commandVector.aad.keyId,
        enc: commandVector.enc,
        ciphertext: commandVector.ciphertext,
        aad: commandVector.aad,
      },
      keyId: commandVector.aad.keyId,
      recipientPrivateKey: recipient.privateKey,
      replayGuard: createRemoteContentReplayGuard({
        workspaceId: commandVector.aad.workspaceId,
        runtimeNodeId: commandVector.aad.runtimeNodeId,
        ledger: { claim: async () => true },
        now: () => VECTOR_NOW,
      }),
      now: VECTOR_NOW,
    })
    expect(new TextDecoder().decode(plaintext)).toBe(commandVector.plaintext)
    expect(runNode(nodeCommandScript)).toEqual({ plaintext: commandVector.plaintext })
  })

  test('the checked-in vectors declare separate key purposes and hold no plaintext', async () => {
    expect(commandVector.keyPurpose).toBe('command_encryption')
    expect(resultVector.keyPurpose).toBe('return')
    expect(commandVector.aad.payloadType).toBe('command.input')
    expect(resultVector.active.aad.payloadType).toBe('execution.result')
    expect(resultVector.revoked.aad.payloadType).toBe('execution.result')
    expect(resultVector.active.recipient.keyId.startsWith('return_')).toBe(true)
    expect(resultVector.revoked.recipient.keyId.startsWith('return_')).toBe(true)
    expect(commandVector.aad.keyId.startsWith('return_')).toBe(false)
    // A runtime command key identity is not a return descriptor.
    expect(() =>
      parseRemoteResultRecipient({
        ...resultVector.active.recipient,
        keyId: commandVector.aad.keyId,
      })
    ).toThrow()

    const resultText = readFileSync(resultFixturePath, 'utf8')
    expect(resultText).not.toContain(RESULT_PLAINTEXT)
    expect(resultText).not.toContain(REVOKED_PLAINTEXT)
    expect(resultText).not.toMatch(/PRIVATE KEY/)
    expect(Object.hasOwn(resultVector, 'plaintext')).toBe(false)
    expect(Object.hasOwn(resultVector.active, 'plaintext')).toBe(false)
    expect(Object.hasOwn(resultVector.revoked, 'plaintext')).toBe(false)

    // The fixture carries the derived public key only: the unwrapped private
    // material behind the return epoch never appears in it.
    const hpke = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes128Gcm(),
    })
    const derived = await hpke.kem.deriveKeyPair(toBytes(resultVector.active.recipientIkm))
    const pkcs8 = toBase64Url(await crypto.subtle.exportKey('pkcs8', derived.privateKey))
    expect(resultText).not.toContain(pkcs8)
    expect(resultText).not.toContain(pkcs8.slice(0, 24))
  })
})
