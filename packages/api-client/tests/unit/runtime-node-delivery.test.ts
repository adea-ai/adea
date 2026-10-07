import { expect, test } from 'bun:test'
import { RuntimeNodeDeliveryClient } from '../../src/runtime-node-delivery'

test('outbound node pulls carry only signed proof and never user credentials or redirects', async () => {
  let captured: Request | undefined
  let options: RequestInit | undefined
  const client = new RuntimeNodeDeliveryClient({
    baseUrl: 'https://adea.invalid/api',
    fetchImpl: async (url, init) => {
      captured = new Request(url, init)
      options = init
      return Response.json({ command: null })
    },
  })
  const proof = {
    version: 1 as const,
    keyId: crypto.randomUUID(),
    nonce: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    signature: Buffer.alloc(64).toString('base64url'),
  }
  expect(await client.pull('workspace/1', 'node/1', proof)).toEqual({ command: null })
  expect(captured!.url).toBe(
    'https://adea.invalid/api/v1/workspaces/workspace%2F1/runtime-nodes/node%2F1/commands/pull'
  )
  // Bun's Request does not retain these Fetch options; inspect the transport boundary.
  expect(options!.credentials).toBe('omit')
  expect(options!.redirect).toBe('error')
  expect(captured!.headers.has('authorization')).toBe(false)
  expect(captured!.headers.has('cookie')).toBe(false)
  expect(await captured!.json()).toEqual(proof)
})
