import { expect, test } from 'bun:test'
import { AgentHqApiClient } from '../../src'

test('model registration and revocation send only existing vault pins and CAS identity', async () => {
  const bodies: unknown[] = []
  const client = new AgentHqApiClient({
    baseUrl: 'https://adea.test/api',
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({})
    },
  })
  const create = {
    credentialRef: `crd_${'1'.repeat(26)}`,
    credentialRevision: 2,
    idempotencyKey: 'register-model:one',
  }
  const revoke = {
    connectionRef: `mconn_${'1'.repeat(32)}`,
    expectedRevision: 3,
    idempotencyKey: 'revoke-model:one',
  }
  await client.createModelConnection('workspace', create)
  await client.revokeModelConnection('workspace', revoke)
  expect(bodies).toEqual([
    { action: 'connections.create', input: create },
    { action: 'connections.revoke', input: revoke },
  ])
  const secretInput = { ...create, secret: 'private-canary' }
  const grantInput = { ...revoke, workspaceGrant: {} }
  await expect(client.createModelConnection('workspace', secretInput)).rejects.toThrow(
    'Invalid model metadata input'
  )
  await expect(client.revokeModelConnection('workspace', grantInput)).rejects.toThrow(
    'Invalid model metadata input'
  )
  expect(bodies).toHaveLength(2)
})

test('model metadata methods reuse canonical auth and encode workspace without provider secrets', async () => {
  const requests: Request[] = []
  const client = new AgentHqApiClient({
    baseUrl: 'https://adea.test/api',
    getAccessToken: () => 'synthetic-browser-auth',
    fetchImpl: async (url, init) => {
      requests.push(new Request(url, init))
      return Response.json({})
    },
  })
  await client.listModelConnections('workspace/one')
  await client.getWorkspaceModelDefaults('workspace/one')
  await client.setWorkspaceModelDefaults('workspace/one', {
    expectedRevision: 2,
    direct: { connectionRef: `mconn_${'1'.repeat(32)}`, providerModel: 'direct-model' },
    idempotencyKey: 'model-default-action:one',
  })
  await client.resolveWorkspaceModelSelection('workspace/one', { role: 'direct' })
  const binding = {
    executionId: 'exe_one',
    attemptId: 'att_one',
    selectionRef: `msel_${'2'.repeat(32)}`,
    selectionRevision: 4,
  }
  await client.getModelSelectionFunding('workspace/one', binding)
  for (const request of requests) {
    expect(request.url).toBe('https://adea.test/api/workspaces/workspace%2Fone/model-connections')
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-browser-auth')
    expect(request.method).toBe('POST')
  }
  expect(await requests[2]!.json()).toEqual({
    action: 'defaults.set',
    input: {
      expectedRevision: 2,
      direct: { connectionRef: `mconn_${'1'.repeat(32)}`, providerModel: 'direct-model' },
      idempotencyKey: 'model-default-action:one',
    },
  })
  expect(await requests[4]!.json()).toEqual({ action: 'funding.get', input: binding })
  const secretInput = { role: 'direct' as const, secret: 'provider-secret-canary' }
  await expect(client.resolveWorkspaceModelSelection('workspace/one', secretInput)).rejects.toThrow(
    'Invalid model metadata input'
  )
  const secretChoice = {
    connectionRef: `mconn_${'1'.repeat(32)}`,
    providerModel: 'direct-model',
    secret: 'nested-provider-secret-canary',
  }
  await expect(
    client.resolveWorkspaceModelSelection('workspace/one', {
      role: 'direct',
      override: secretChoice,
    })
  ).rejects.toThrow('Invalid model metadata input')
  expect(requests).toHaveLength(5)
})
