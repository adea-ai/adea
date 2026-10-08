import { expect, test } from 'bun:test'
import { createCurrentProductReaderHandler } from './current-product-reader.mjs'

const request = (body, credential = 'synthetic') =>
  new Request('http://127.0.0.1/current-product', {
    method: 'POST',
    headers: { Authorization: `Bearer ${credential}` },
    body: JSON.stringify(body),
  })

test('authenticates strict identifier requests and returns fresh server evidence without wrapper', async () => {
  let revision = 1
  const input = { workspaceId: 'workspace', intentId: 'intent', principalId: 'transport' }
  const handler = createCurrentProductReaderHandler({
    credential: 'synthetic',
    readCurrent: async (value) => {
      expect(value).toEqual(input)
      return { canonicalActorPrincipalId: 'user:recorded', authorityRevision: revision++ }
    },
  })
  for (const expected of [1, 2]) {
    const result = await handler(
      new Request('http://127.0.0.1/current-product', {
        method: 'POST',
        headers: { Authorization: 'Bearer synthetic' },
        body: JSON.stringify(input),
      })
    )
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({
      canonicalActorPrincipalId: 'user:recorded',
      authorityRevision: expected,
    })
  }
})

test('denies unauthorized, oversized, caller authority and revoked reads without leaking errors', async () => {
  let calls = 0
  const handler = createCurrentProductReaderHandler({
    credential: 'synthetic',
    readCurrent: async () => {
      calls++
      throw new Error('private authority detail')
    },
  })
  const input = { workspaceId: 'workspace', intentId: 'intent', principalId: 'transport' }
  expect((await handler(request(input, 'wrong'))).status).toBe(401)
  expect((await handler(request({ ...input, canonicalActorPrincipalId: 'caller' }))).status).toBe(
    400
  )
  expect((await handler(request('x'.repeat(4097)))).status).toBe(413)
  expect(calls).toBe(0)
  const denied = await handler(request(input))
  expect(denied.status).toBe(404)
  expect(await denied.text()).toBe('')
  expect(calls).toBe(1)
})
