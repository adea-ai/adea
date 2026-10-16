import { expect, test } from 'bun:test'
import type {
  ApiModelConnectionsResponse,
  ApiModelDefaultsResponse,
} from '@adea-ai/api-client/model-connections'
import { modelReadinessRemedy } from '../../src/lead-model-state'
import { readDirectLaunchModel, resolveDirectSessionModel } from '../../src/direct-session-model'

const ref = (letter: string) => `mconn_${letter.repeat(32)}`
const target = {
  location: 'remote_host',
  harness: 'pi',
  harnessVersion: '1.0.0',
  providerBinding: 'pi_model_runtime',
} as const
const listing = (readiness: { ready: boolean; reasonCode: string }, status = 'active') =>
  ({
    availability: 'available',
    canManage: true,
    target,
    connections: [
      {
        connectionRef: ref('a'),
        revision: 1,
        provider: 'openai',
        accountRef: 'account:a',
        authKind: 'api_key',
        fundingSource: 'byo_api',
        status,
        models: [{ providerModel: 'gpt-5', readiness }],
      },
    ],
  }) as unknown as ApiModelConnectionsResponse
const ready = { ready: true, reasonCode: 'READY' }
const direct = { connectionRef: ref('a'), providerModel: 'gpt-5' }
const read = (defaults: ApiModelDefaultsResponse['defaults']): ApiModelDefaultsResponse => ({
  availability: 'available',
  canManage: true,
  defaults,
})
const defaults = read({ revision: 1, direct })

test('the stored direct default initializes a new session when it is ready', () => {
  const result = resolveDirectSessionModel({ defaults, connections: listing(ready) })
  expect(result.kind).toBe('workspace_default')
  if (result.kind === 'workspace_default') expect(result.model.choice).toEqual(direct)
})

test('an existing session keeps its own pin and the default never replaces it', () => {
  const pinned = { connectionRef: ref('b'), providerModel: 'older-model' }
  const result = resolveDirectSessionModel({
    existing: pinned,
    explicit: direct,
    defaults,
    connections: listing(ready),
  })
  expect(result).toEqual({ kind: 'existing', choice: pinned })
})

test('an explicit per-session choice wins over the default and is checked on its own', () => {
  const other = { connectionRef: ref('a'), providerModel: 'gpt-5-mini' }
  const result = resolveDirectSessionModel({
    explicit: other,
    defaults,
    connections: listing(ready),
  })
  // The default is ready, but the explicit choice is not in the listing: no fallback to the default.
  expect(result).toMatchObject({
    kind: 'blocked',
    source: 'explicit',
    choice: other,
    reasonCode: 'MODEL_UNAVAILABLE',
  })
})

test('an unavailable or unauthorized default blocks with its recovery path and never falls back', () => {
  for (const code of ['QUOTA_EXHAUSTED', 'CREDENTIAL_EXPIRED', 'WORKSPACE_GRANT_REVOKED']) {
    const result = resolveDirectSessionModel({
      defaults,
      connections: listing({ ready: false, reasonCode: code }),
    })
    expect(result).toMatchObject({ kind: 'blocked', source: 'workspace_default', reasonCode: code })
    if (result.kind === 'blocked') expect(result.remedy).toEqual(modelReadinessRemedy(code))
  }
  expect(
    resolveDirectSessionModel({ defaults, connections: listing(ready, 'revoked') })
  ).toMatchObject({ kind: 'blocked', reasonCode: 'CONNECTION_REVOKED' })
  expect(
    resolveDirectSessionModel({
      defaults: read({ revision: 1, direct: { connectionRef: ref('c'), providerModel: 'gpt-5' } }),
      connections: listing(ready),
    })
  ).toMatchObject({ kind: 'blocked', reasonCode: 'CONNECTION_MISSING' })
})

test('an unreadable listing is unverifiable, not ready and not the harness default', () => {
  for (const connections of [null, undefined, { availability: 'unavailable' }, 'secret text']) {
    expect(resolveDirectSessionModel({ defaults, connections })).toMatchObject({
      kind: 'blocked',
      reasonCode: 'READINESS_UNAVAILABLE',
    })
  }
})

test('the harness decides only after a verified absence or an inactive host', () => {
  expect(
    resolveDirectSessionModel({ defaults: read({ revision: 1 }), connections: listing(ready) })
  ).toEqual({ kind: 'harness_default', verified: 'absent' })
  expect(resolveDirectSessionModel({ defaults: read(null), connections: null })).toEqual({
    kind: 'harness_default',
    verified: 'absent',
  })
  expect(
    resolveDirectSessionModel({
      defaults: { availability: 'unavailable', canManage: false, defaults: null },
      connections: null,
    })
  ).toEqual({ kind: 'harness_default', verified: 'inactive' })
})

test('a defaults read that is missing, loading, failed or malformed blocks and never falls back', () => {
  for (const unread of [
    null,
    undefined,
    { availability: 'mystery', canManage: true, defaults: null },
    { availability: 'available', canManage: true, defaults: 'secret text' },
    { availability: 'available', canManage: true, defaults: { revision: 'x' } },
  ]) {
    const result = resolveDirectSessionModel({
      defaults: unread as unknown as ApiModelDefaultsResponse,
      connections: listing(ready),
    })
    expect(result).toMatchObject({
      kind: 'blocked',
      source: 'workspace_default',
      reasonCode: 'READINESS_UNAVAILABLE',
    })
    expect(result).not.toHaveProperty('choice')
  }
})

test('an existing pin and an explicit choice do not depend on the defaults read', () => {
  const pinned = { connectionRef: ref('b'), providerModel: 'older-model' }
  expect(
    resolveDirectSessionModel({ existing: pinned, defaults: null, connections: null })
  ).toEqual({ kind: 'existing', choice: pinned })
  expect(
    resolveDirectSessionModel({ explicit: direct, defaults: null, connections: listing(ready) })
      .kind
  ).toBe('explicit')
})

const reads = (
  stored: () => Promise<ApiModelDefaultsResponse>,
  listed: () => Promise<ApiModelConnectionsResponse> = async () => listing(ready)
) => {
  const calls = { defaults: 0, listing: 0 }
  return {
    calls,
    client: {
      getWorkspaceModelDefaults: async () => {
        calls.defaults += 1
        return stored()
      },
      listModelConnections: async () => {
        calls.listing += 1
        return listed()
      },
    },
  }
}

test('a ready stored default becomes the launch model id', async () => {
  const { client } = reads(async () => defaults)
  expect(await readDirectLaunchModel(client, 'workspace-1')).toEqual({
    kind: 'model',
    modelId: 'gpt-5',
  })
})

test('a failed defaults read blocks the launch and reads no listing', async () => {
  const { client, calls } = reads(async () => {
    throw new Error('network')
  })
  const result = await readDirectLaunchModel(client, 'workspace-1')
  expect(result.kind).toBe('blocked')
  expect(calls.listing).toBe(0)
})

test('a failed listing read blocks instead of using the harness model', async () => {
  const { client } = reads(
    async () => defaults,
    async () => {
      throw new Error('network')
    }
  )
  const result = await readDirectLaunchModel(client, 'workspace-1')
  expect(result.kind).toBe('blocked')
  if (result.kind === 'blocked') expect(result.message).toContain('No other model was substituted')
})

test('an unauthorized default blocks with its recovery path', async () => {
  const { client } = reads(
    async () => defaults,
    async () => listing({ ready: false, reasonCode: 'CREDENTIAL_EXPIRED' })
  )
  const result = await readDirectLaunchModel(client, 'workspace-1')
  expect(result.kind).toBe('blocked')
  if (result.kind === 'blocked')
    expect(result.message).toContain(modelReadinessRemedy('CREDENTIAL_EXPIRED')!.message)
})

test('verified absence leaves the harness model and never reads the listing', async () => {
  const { client, calls } = reads(async () => read({ revision: 1 }))
  expect(await readDirectLaunchModel(client, 'workspace-1')).toEqual({ kind: 'harness_default' })
  expect(calls.listing).toBe(0)
})
