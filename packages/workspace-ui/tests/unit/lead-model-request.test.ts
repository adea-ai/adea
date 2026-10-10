import { expect, test } from 'bun:test'
import type { AgentHqModelConnectionsClient } from '@adea-ai/api-client/model-connections'
import { createLeadModelRequestResolver } from '../../src/lead-model-request'

function fixture() {
  const target = {
    location: 'remote_host',
    harness: 'pi_durable',
    harnessVersion: '1.1.0',
    providerBinding: 'pi_durable_models',
  } as const
  const choice = { connectionRef: `mconn_${'a'.repeat(32)}`, providerModel: 'test-model' }
  const calls: unknown[] = []
  const inventory = {
    availability: 'available',
    target,
    canManage: true,
    connections: [
      {
        ...choice,
        revision: 1,
        provider: 'test',
        accountRef: 'test-account',
        authKind: 'api_key',
        fundingSource: 'byo_api',
        status: 'active',
        models: [
          {
            providerModel: choice.providerModel,
            readiness: { ready: true, reasonCode: 'READY', remedy: null },
          },
        ],
      },
    ],
  } as const
  let ready = true
  let invalid = false
  const client = {
    listModelConnections: async () => {
      calls.push('list')
      return ready ? inventory : { ...inventory, connections: [] }
    },
    resolveWorkspaceModelSelection: async (
      _workspaceId: string,
      input: { role: 'lead' | 'child' }
    ) => {
      calls.push(input)
      return {
        selection: {
          ...choice,
          target,
          provider: 'test',
          authKind: 'api_key',
          fundingSource: 'byo_api',
          selectionRef: `msel_${(input.role === 'lead' ? 'a' : 'b').repeat(32)}`,
          selectionRevision: invalid ? 0 : 1,
        },
      }
    },
  } as unknown as AgentHqModelConnectionsClient
  return {
    resolver: createLeadModelRequestResolver(client),
    choice,
    calls,
    setReady: (value: boolean) => {
      ready = value
    },
    setInvalid: () => {
      invalid = true
    },
  }
}

test('resolves each explicit role independently and retries the same immutable refs', async () => {
  const f = fixture()
  const choices = { lead: f.choice, child: f.choice }
  const first = await f.resolver.resolve('workspace', 'same-save', choices, () => true)
  expect(first?.lead?.selectionRef).not.toBe(first?.child?.selectionRef)
  expect(f.calls).toHaveLength(3)
  expect(Object.isFrozen(first?.child)).toBe(true)
  expect(
    await f.resolver.resolve(
      'workspace',
      'same-save',
      { child: f.choice, lead: f.choice },
      () => true
    )
  ).toBe(first)
  expect(f.calls).toHaveLength(3)
})
test('changed same-key choices and revoked audience cannot reuse retained refs', async () => {
  const f = fixture()
  await f.resolver.resolve('workspace', 'stable-key', { lead: f.choice }, () => true)
  await expect(
    f.resolver.resolve('workspace', 'stable-key', { child: f.choice }, () => true)
  ).rejects.toThrow('retry changed')
  await expect(
    f.resolver.resolve('workspace', 'stable-key', { lead: f.choice }, () => false)
  ).rejects.toThrow('scope changed')
  expect(f.calls).toHaveLength(2)
})
test('no explicit choice invokes no metadata; child-only never inherits lead', async () => {
  const f = fixture()
  expect(await f.resolver.resolve('workspace', 'default', {}, () => true)).toBeUndefined()
  expect(f.calls).toHaveLength(0)
  expect(
    await f.resolver.resolve('workspace', 'child', { child: f.choice }, () => true)
  ).not.toHaveProperty('lead')
})
test('a child-only request reads only the child role: no lead resolution and no other metadata call', async () => {
  const f = fixture()
  await f.resolver.resolve('workspace', 'child-only', { child: f.choice }, () => true)
  expect(f.calls).toEqual(['list', { role: 'child', override: f.choice }])
})
test('unready choice, invalid accepted response and changed audience fail without retained fallback', async () => {
  const f = fixture()
  f.setReady(false)
  await expect(
    f.resolver.resolve('workspace', 'unready', { lead: f.choice }, () => true)
  ).rejects.toThrow('unavailable')
  expect(f.calls).toHaveLength(1)
  f.setReady(true)
  await expect(
    f.resolver.resolve('workspace', 'stale', { lead: f.choice }, () => false)
  ).rejects.toThrow('scope changed')
  f.setInvalid()
  await expect(
    f.resolver.resolve('workspace', 'invalid', { lead: f.choice }, () => true)
  ).rejects.toThrow('response invalid')
})
