import { expect, test } from 'bun:test'
import { createApiClient } from '../../src/index'

test('runtime inventory is workspace scoped and forwards cancellation', async () => {
  const requests: Request[] = []
  const signal = new AbortController().signal
  const client = createApiClient({
    baseUrl: 'https://adea.invalid/api',
    fetchImpl: async (url, init) => {
      requests.push(new Request(url, init))
      expect(init?.signal).toBe(signal)
      return Response.json({ nodes: [], connections: [], discovery: { state: 'available' } })
    },
  })
  expect(await client.listRuntimeNodes('workspace/1', signal)).toMatchObject({ nodes: [] })
  await client.listRuntimeNodeConnections('workspace/1', 'node/2', 'cursor+3', signal)
  expect(requests.map((request) => request.url)).toEqual([
    'https://adea.invalid/api/v1/workspaces/workspace%2F1/runtime-nodes',
    'https://adea.invalid/api/v1/workspaces/workspace%2F1/runtime-nodes/node%2F2/connections?cursor=cursor%2B3',
  ])
  expect(requests.every((request) => request.method === 'GET')).toBe(true)
})

test('registration keys and arbitrary trust metadata never enter the inventory cache projection', async () => {
  const node = {
    id: 'node',
    controlPlaneRuntimeNodeRefId: 'rnr_node',
    kind: 'local_device',
    displayName: 'Laptop',
    health: 'healthy',
    pairingState: 'paired',
    lastProofAt: null,
    lastSeenAt: null,
    platform: 'macOS',
    softwareVersion: '1.0.0',
  }
  const client = createApiClient({
    fetchImpl: async () =>
      Response.json({
        nodes: [
          {
            ...node,
            keys: [{ publicKey: 'public-key-canary' }],
            trustMetadata: { arbitrary: 'trust-metadata-canary' },
          },
        ],
      }),
  })
  expect(await client.listRuntimeNodes('workspace')).toEqual({ nodes: [node] })
})
