import { expect, test } from 'bun:test'
import type {
  ApiModelConnectionsResponse,
  ApiWorkspaceModelDefaults,
} from '@adea-ai/api-client/model-connections'
import { modelReadinessRemedy } from '../../src/lead-model-state'
import { resolveDirectSessionModel } from '../../src/direct-session-model'

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
const defaults = { revision: 1, direct } as ApiWorkspaceModelDefaults

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
      defaults: { revision: 1, direct: { connectionRef: ref('c'), providerModel: 'gpt-5' } },
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

test('with no default and no choice the harness decides, and that is reported as such', () => {
  expect(
    resolveDirectSessionModel({ defaults: { revision: 1 }, connections: listing(ready) })
  ).toEqual({ kind: 'harness_default' })
  expect(resolveDirectSessionModel({ defaults: null, connections: null })).toEqual({
    kind: 'harness_default',
  })
})
