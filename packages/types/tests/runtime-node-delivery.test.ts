import { expect, test } from 'bun:test'

import {
  parseRuntimeNodePullRequest,
  runtimeNodePullMessage,
  verifyRuntimeNodePull,
} from '../src/runtime-node-delivery'

const scope = {
  workspaceId: '12345678-1234-4234-8234-123456789012',
  runtimeNodeId: '12345678-1234-4234-8234-123456789013',
}
const input = {
  version: 1 as const,
  keyId: '12345678-1234-4234-8234-123456789014',
  nonce: '12345678-1234-4234-8234-123456789015',
  issuedAt: '2026-10-07T19:30:00.000Z',
  signature: Buffer.alloc(64).toString('base64url'),
}

test('pull signatures bind version, operation, workspace, node, key, nonce and time', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
  const signed = {
    ...input,
    signature: Buffer.from(
      await crypto.subtle.sign(
        'Ed25519',
        keys.privateKey,
        new TextEncoder().encode(runtimeNodePullMessage(scope, input))
      )
    ).toString('base64url'),
  }
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString(
    'base64url'
  )
  expect(await verifyRuntimeNodePull(scope, signed, publicKey)).toBe(true)
  expect(runtimeNodePullMessage(scope, signed)).toBe(
    JSON.stringify([
      'adea-runtime-node-delivery',
      1,
      'commands.pull',
      scope.workspaceId,
      scope.runtimeNodeId,
      input.keyId,
      input.nonce,
      input.issuedAt,
    ])
  )
  for (const field of ['workspaceId', 'runtimeNodeId'] as const)
    expect(await verifyRuntimeNodePull({ ...scope, [field]: input.nonce }, signed, publicKey)).toBe(
      false
    )
  for (const field of ['keyId', 'nonce', 'issuedAt'] as const)
    expect(
      await verifyRuntimeNodePull(
        scope,
        {
          ...signed,
          [field]: field === 'issuedAt' ? '2026-10-07T19:30:01.000Z' : scope.workspaceId,
        },
        publicKey
      )
    ).toBe(false)
  expect(await verifyRuntimeNodePull(scope, signed, Buffer.alloc(32).toString('base64url'))).toBe(
    false
  )
})

test('pull parser is exact, canonical and bounded with no user/session/content fields', () => {
  expect(parseRuntimeNodePullRequest(input)).toEqual(input)
  for (const value of [
    null,
    [],
    { ...input, version: 2 },
    { ...input, cookie: 'SECRET' },
    { ...input, nonce: 'not-uuid' },
    { ...input, issuedAt: '2026-10-07T19:30:00Z' },
    { ...input, signature: input.signature + '=' },
    { ...input, signature: 'A'.repeat(1000) },
  ])
    expect(parseRuntimeNodePullRequest(value)).toBeNull()
  // Base64url's unused final bits must be canonical as well.
  expect(parseRuntimeNodePullRequest({ ...input, signature: 'A'.repeat(85) + 'B' })).toBeNull()
})
