import { expect, test } from 'bun:test'
import { readRuntimeNodePullInput } from '../src/server/runtime-node-delivery-input'

const body = {
  version: 1,
  keyId: '12345678-1234-4234-8234-123456789014',
  nonce: '12345678-1234-4234-8234-123456789015',
  issuedAt: '2026-10-07T19:30:00.000Z',
  signature: Buffer.alloc(64).toString('base64url'),
}
const request = (value: string, headers = {}) =>
  new Request('https://adea.invalid', { method: 'POST', body: value, headers })
test('node pull reads only a bounded exact signed body', async () => {
  expect(await readRuntimeNodePullInput(request(JSON.stringify(body)))).toEqual(body)
  expect(
    await readRuntimeNodePullInput(request(JSON.stringify({ ...body, prompt: 'SECRET' })))
  ).toBeNull()
  expect(
    await readRuntimeNodePullInput(request(' '.repeat(1025), { 'content-length': '1' }))
  ).toBeNull()
  expect(await readRuntimeNodePullInput(request('{'))).toBeNull()
  expect(await readRuntimeNodePullInput(request('{}', { 'content-length': '1025' }))).toBeNull()
})
