import { expect, test } from 'bun:test'

import {
  parseRuntimeNodePullRequest,
  parseRuntimeNodeRetentionReceiptRequest,
  runtimeNodePullMessage,
  runtimeNodeRetentionReceiptMessage,
  verifyRuntimeNodePull,
  verifyRuntimeNodeRetentionReceipt,
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

const receiptBody = {
  category: 'messages',
  receipt: {
    coverage: 'primary',
    observedAt: '2026-10-07T19:30:00.000Z',
    operation: 'delete',
    outcome: 'completed',
    requestId: '12345678-1234-4234-8234-123456789016',
    residualCount: 0,
    subjectId: 'subject-1',
  },
}

test('retention receipt signatures bind the purpose, the body digest and the envelope', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString(
    'base64url'
  )
  const sign = async (body: typeof receiptBody & { envelope: typeof input }) =>
    Buffer.from(
      await crypto.subtle.sign(
        'Ed25519',
        keys.privateKey,
        new TextEncoder().encode(await runtimeNodeRetentionReceiptMessage(scope, body))
      )
    ).toString('base64url')
  const envelope = { ...input, signature: '' }
  const signed = {
    ...receiptBody,
    envelope: { ...envelope, signature: await sign({ ...receiptBody, envelope }) },
  }
  const parsed = parseRuntimeNodeRetentionReceiptRequest(signed)!
  expect(parsed).not.toBeNull()
  expect(await verifyRuntimeNodeRetentionReceipt(scope, parsed, publicKey)).toBe(true)

  // A signature made for the pull purpose never verifies a receipt.
  const pullSignature = Buffer.from(
    await crypto.subtle.sign(
      'Ed25519',
      keys.privateKey,
      new TextEncoder().encode(runtimeNodePullMessage(scope, envelope))
    )
  ).toString('base64url')
  expect(
    await verifyRuntimeNodeRetentionReceipt(
      scope,
      { ...parsed, envelope: { ...parsed.envelope, signature: pullSignature } },
      publicKey
    )
  ).toBe(false)

  // Any change to a receipt field, however small, breaks the signed digest.
  for (const tamper of [
    { receipt: { ...receiptBody.receipt, observedAt: '2026-10-07T19:30:00.001Z' } },
    { receipt: { ...receiptBody.receipt, requestId: '12345678-1234-4234-8234-123456789099' } },
    { receipt: { ...receiptBody.receipt, outcome: 'failed' } },
    { category: 'logs' },
  ]) {
    expect(
      await verifyRuntimeNodeRetentionReceipt(
        scope,
        { ...parsed, ...tamper } as typeof parsed,
        publicKey
      )
    ).toBe(false)
  }
})

test('retention receipt parser is exact: no extra fields, bounded and canonical', () => {
  const valid = { ...receiptBody, envelope: { ...input, signature: input.signature } }
  expect(parseRuntimeNodeRetentionReceiptRequest(valid)).not.toBeNull()
  const invalid: unknown[] = [
    null,
    [],
    { ...valid, extra: true },
    { ...valid, receipt: { ...receiptBody.receipt, extra: 1 } },
    { ...valid, receipt: { ...receiptBody.receipt, requestId: undefined } },
    { ...valid, receipt: { ...receiptBody.receipt, residualCount: -1 } },
    { ...valid, receipt: { ...receiptBody.receipt, residualCount: 1.5 } },
    { ...valid, receipt: { ...receiptBody.receipt, observedAt: '2026-10-07' } },
    { ...valid, receipt: { ...receiptBody.receipt, subjectId: 'has space' } },
    { ...valid, category: '' },
    { ...valid, envelope: { ...input, extra: 1 } },
  ]
  for (const value of invalid) expect(parseRuntimeNodeRetentionReceiptRequest(value)).toBeNull()
})
