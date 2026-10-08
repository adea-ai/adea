import { describe, expect, test } from 'bun:test'
import type {
  ApiModelFundingBinding,
  ApiModelExecutionTarget,
} from '@adea-ai/api-client/model-connections'
import {
  createWorkspaceModelMetadataAdapter,
  projectModelSelectionFunding,
  type ModelMetadataDependencies,
} from '../src/server/model-connections-proxy'
import {
  handleModelMetadata,
  parseModelMetadataRequest,
  type ModelMetadataRouteDependencies,
} from '../src/server/model-connections-routes'
import { installedModelMetadataPort } from '../src/server/model-connections-sdk'

const WORKSPACE = '00000000-0000-4000-8000-000000000001'
const CP_WORKSPACE = 'wsp_01JABCDEF0123456789ABCDEFG'
const OTHER_CP_WORKSPACE = 'wsp_01JABCDEF0123456789ABCDEFH'
const TARGET: ApiModelExecutionTarget = {
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
}
const CORRELATION = {
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  traceId: 'trc_01JABCDEF0123456789ABCDEFG',
}
const BINDING: ApiModelFundingBinding = {
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  selectionRef: `msel_${'1'.repeat(32)}`,
  selectionRevision: 2,
}
const CHOICE = { connectionRef: `mconn_${'2'.repeat(32)}`, providerModel: 'test-model' }
const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const REGISTER = {
  credentialRef: `crd_${'1'.repeat(26)}`,
  credentialRevision: 2,
  idempotencyKey: 'register-model:one',
}
const REVOKE = {
  connectionRef: CHOICE.connectionRef,
  expectedRevision: 3,
  idempotencyKey: 'revoke-model:one',
}
const CONNECTION = {
  workspaceId: CP_WORKSPACE,
  connectionRef: CHOICE.connectionRef,
  revision: 3,
  provider: 'anthropic',
  accountRef: 'test-account',
  authKind: 'api_key',
  fundingSource: 'byo_api',
  status: 'active',
  models: ['test-model'],
  credentialRef: REGISTER.credentialRef,
  credentialRevision: 2,
  workspaceGrant: { grantRef: 'private-grant' },
  secret: 'secret-canary',
}
const FUNDING = {
  schemaVersion: 'model-funding-display/v1',
  workspaceId: CP_WORKSPACE,
  ...BINDING,
  state: 'ready',
  provider: 'anthropic',
  providerModel: 'test-model',
  accountRef: 'provider-account',
  authKind: 'api_key',
  fundingSource: 'byo_api',
  authorityRevision: 4,
  authorizationRef: 'recorded-auth:one',
  expiresAt: '2026-10-08T12:10:00.000Z',
  fundingOwner: {
    ownerRef: 'payer:separate',
    kind: 'workspace_account',
    displayName: 'Team billing',
    revision: 3,
    evidenceRef: 'payer-evidence:one',
  },
}

async function fixture(answer: Record<string, unknown>) {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const key = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString(
    'base64'
  )
  const requests: Record<string, unknown>[] = []
  const scopes: string[][] = []
  const dependencies: ModelMetadataDependencies = {
    target: () => TARGET,
    now: () => NOW,
    resolveControlPlaneScope: async () => ({ workspaceId: CP_WORKSPACE }),
    environment: {
      CONTROL_PLANE_SIGNING_KEY: `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----`,
      CONTROL_PLANE_SIGNING_KEY_ID: 'synthetic-model-test',
      CONTROL_PLANE_SIGNING_ISSUER: 'https://adea.test',
    },
    port: {
      supported: true,
      invoke: async (_method, credential, body) => {
        requests.push(body)
        scopes.push(
          JSON.parse(Buffer.from(credential.token.split('.')[1]!, 'base64url').toString()).scopes
        )
        return { requestId: body.requestId, correlation: body.correlation, data: answer }
      },
    },
  }
  return {
    dependencies,
    requests,
    scopes,
    adapter: createWorkspaceModelMetadataAdapter(WORKSPACE, true, CORRELATION, dependencies),
  }
}

type MutableRouteDependencies = {
  -readonly [Key in keyof ModelMetadataRouteDependencies]: ModelMetadataRouteDependencies[Key]
}
function routes(hop: ModelMetadataDependencies): MutableRouteDependencies {
  return {
    guard: () => null,
    resolvePrincipal: async () => ({
      clearTemporaryCredential: false,
      sessionRotated: false,
      temporary: false,
      principal: { kind: 'user', userId: 'test-user' },
    }),
    authorize: async () => true,
    canManage: async () => true,
    hop: () => hop,
    json: (payload, _resolution, _request, init) => Response.json(payload, init),
    unavailable: (_request, status = 404) =>
      Response.json({ code: 'workspace_unavailable' }, { status }),
    invalid: () => Response.json({ code: 'invalid_request' }, { status: 400 }),
    failure: (_request, code, message, status) => Response.json({ code, message }, { status }),
  }
}

function request(action: string, input: unknown = {}) {
  return new Request('https://adea.test/api/workspaces/test/model-connections', {
    method: 'POST',
    body: JSON.stringify({ action, input }),
    headers: { 'content-type': 'application/json' },
  })
}

describe('model metadata product boundary', () => {
  test('registration and revocation use existing vault references and write scope without inferred readiness', async () => {
    const item = await fixture({ connection: CONNECTION })
    const result = await item.adapter.create(REGISTER)
    expect(result.connection.models).toEqual([])
    expect(result.connection).not.toHaveProperty('credentialRef')
    expect(result.connection).not.toHaveProperty('workspaceGrant')
    expect(JSON.stringify(result)).not.toContain('secret-canary')
    expect(item.requests[0]).toMatchObject({
      operation: 'model-connections.create',
      payload: { credentialRef: REGISTER.credentialRef, credentialRevision: 2 },
      idempotencyKey: REGISTER.idempotencyKey,
    })
    const revoked = await fixture({ connection: { ...CONNECTION, status: 'revoked', revision: 4 } })
    expect((await revoked.adapter.revoke(REVOKE)).connection.status).toBe('revoked')
    expect(revoked.requests[0]).toMatchObject({
      operation: 'model-connections.revoke',
      payload: { connectionRef: CHOICE.connectionRef, expectedRevision: 3 },
      idempotencyKey: REVOKE.idempotencyKey,
    })
    expect(item.scopes).toEqual([['credential:write']])
    expect(revoked.scopes).toEqual([['credential:write']])
    const wrong = await fixture({ connection: { ...CONNECTION, workspaceId: OTHER_CP_WORKSPACE } })
    await expect(wrong.adapter.create(REGISTER)).rejects.toMatchObject({
      code: 'READINESS_UNAVAILABLE',
    })
  })

  test('registration and revocation reject secrets, authority fields, noncanonical refs and stale shapes', () => {
    expect(parseModelMetadataRequest({ action: 'connections.create', input: REGISTER })).toEqual({
      action: 'connections.create',
      input: REGISTER,
    })
    expect(parseModelMetadataRequest({ action: 'connections.revoke', input: REVOKE })).toEqual({
      action: 'connections.revoke',
      input: REVOKE,
    })
    for (const input of [
      { ...REGISTER, secret: 'canary' },
      { ...REGISTER, target: TARGET },
      { ...REGISTER, provider: 'anthropic' },
      { ...REGISTER, credentialId: REGISTER.credentialRef },
      { ...REGISTER, credentialRef: 'arbitrary-vault-id' },
      { ...REGISTER, credentialRevision: 0 },
      { ...REGISTER, idempotencyKey: 'short' },
    ])
      expect(parseModelMetadataRequest({ action: 'connections.create', input })).toBeNull()
    for (const input of [
      { ...REVOKE, fundingOwner: FUNDING.fundingOwner },
      { ...REVOKE, expectedRevision: 0 },
      { ...REVOKE, connectionRef: 'arbitrary-id' },
    ])
      expect(parseModelMetadataRequest({ action: 'connections.revoke', input })).toBeNull()
  })

  test('model mutation authorization checks management at request and publication boundaries', async () => {
    for (const [action, input] of [
      ['connections.create', REGISTER],
      ['connections.revoke', REVOKE],
    ] as const) {
      const item = await fixture({
        connection:
          action === 'connections.create' ? CONNECTION : { ...CONNECTION, status: 'revoked' },
      })
      const member = routes(item.dependencies)
      member.authorize = async (_principal, permission) => permission === 'workspace.read'
      expect((await handleModelMetadata(request(action, input), WORKSPACE, member)).status).toBe(
        403
      )
      expect(item.requests).toHaveLength(0)
      const revoked = routes(item.dependencies)
      let writeChecks = 0
      revoked.authorize = async (_principal, permission) =>
        permission === 'workspace.read' || ++writeChecks === 1
      const response = await handleModelMetadata(request(action, input), WORKSPACE, revoked)
      expect(response.status).toBe(404)
      expect(item.requests).toHaveLength(1)
      expect(JSON.stringify(await response.json())).not.toContain('test-account')
    }
  })
  test('missing host target and currently unsupported public release stay inactive without a signed hop', async () => {
    let resolved = 0
    const adapter = createWorkspaceModelMetadataAdapter(WORKSPACE, false, CORRELATION, {
      resolveControlPlaneScope: async () => {
        resolved++
        return { workspaceId: CP_WORKSPACE }
      },
    })
    expect(await adapter.list()).toEqual({
      availability: 'unavailable',
      target: null,
      connections: [],
      canManage: false,
    })
    expect(await adapter.getDefaults()).toEqual({
      availability: 'unavailable',
      defaults: null,
      canManage: false,
    })
    await expect(adapter.resolve({ role: 'lead' })).rejects.toMatchObject({
      code: 'READINESS_UNAVAILABLE',
    })
    expect(resolved).toBe(0)
    expect(installedModelMetadataPort.supported).toBeFalse()
  })

  test('defaults retain distinct roles and CAS identity under the existing write scope', async () => {
    const { adapter, requests, scopes } = await fixture({
      defaults: {
        workspaceId: CP_WORKSPACE,
        revision: 3,
        lead: CHOICE,
        direct: { ...CHOICE, providerModel: 'direct-model' },
      },
    })
    const result = await adapter.setDefaults({
      expectedRevision: 2,
      lead: CHOICE,
      direct: { ...CHOICE, providerModel: 'direct-model' },
      idempotencyKey: 'model-defaults-action:one',
    })
    expect(result.defaults?.lead?.providerModel).toBe('test-model')
    expect(result.defaults?.child).toBeUndefined()
    expect(result.defaults?.direct?.providerModel).toBe('direct-model')
    expect(requests[0]).toMatchObject({
      operation: 'model-defaults.set',
      workspaceId: CP_WORKSPACE,
      idempotencyKey: 'model-defaults-action:one',
      payload: { expectedRevision: 2 },
    })
    expect(scopes).toEqual([['credential:write']])
  })

  test('connection revocation dominates inconsistent readiness and strips private metadata', async () => {
    const { adapter } = await fixture({
      connections: [
        {
          connection: {
            ...CHOICE,
            workspaceId: CP_WORKSPACE,
            revision: 1,
            provider: 'anthropic',
            accountRef: 'test-account',
            authKind: 'api_key',
            fundingSource: 'byo_api',
            status: 'revoked',
            credentialRef: 'private-credential',
            secret: 'secret-canary',
          },
          models: [
            { providerModel: 'test-model', readiness: { ready: true, reasonCode: 'READY' } },
          ],
        },
      ],
    })
    const result = await adapter.list()
    expect(result.connections[0]?.models[0]?.readiness.reasonCode).toBe('CONNECTION_REVOKED')
    expect(JSON.stringify(result)).not.toContain('secret-canary')
    expect(JSON.stringify(result)).not.toContain('private-credential')
  })

  test('wrong-workspace metadata and implicit override substitutions are rejected', async () => {
    const wrong = await fixture({ defaults: { workspaceId: OTHER_CP_WORKSPACE, revision: 1 } })
    await expect(wrong.adapter.getDefaults()).rejects.toMatchObject({
      code: 'READINESS_UNAVAILABLE',
    })
    const resolve = await fixture({
      selection: {
        schemaVersion: 'model-selection/v1',
        workspaceId: CP_WORKSPACE,
        ...CHOICE,
        ...TARGET,
        providerModel: 'wrong-model',
        provider: 'anthropic',
        selectionRef: BINDING.selectionRef,
        selectionRevision: 2,
        authKind: 'api_key',
        fundingSource: 'byo_api',
      },
    })
    await expect(
      resolve.adapter.resolve({ role: 'direct', override: CHOICE })
    ).rejects.toMatchObject({ code: 'READINESS_UNAVAILABLE' })
  })

  test('funding exposes only explicit payer evidence bound to the accepted execution and mapped workspace', () => {
    const result = projectModelSelectionFunding(FUNDING, WORKSPACE, CP_WORKSPACE, BINDING, NOW)
    expect(result).toMatchObject({
      workspaceId: WORKSPACE,
      ...BINDING,
      fundingOwner: {
        ownerRef: 'payer:separate',
        kind: 'workspace_account',
        displayName: 'Team billing',
        revision: 3,
      },
    })
    expect(result).not.toHaveProperty('authorizationRef')
    expect(JSON.stringify(result)).not.toContain('payer-evidence:one')
    for (const patch of [
      { workspaceId: OTHER_CP_WORKSPACE },
      { selectionRevision: 1 },
      { attemptId: 'att_01JABCDEF0123456789ABCDEFH' },
      { fundingOwner: undefined },
      { fundingOwner: { ...FUNDING.fundingOwner, evidenceRef: undefined } },
    ])
      expect(() =>
        projectModelSelectionFunding(
          { ...FUNDING, ...patch },
          WORKSPACE,
          CP_WORKSPACE,
          BINDING,
          NOW
        )
      ).toThrow('Model metadata is unavailable')
  })

  test('expired or revoked disclosures return binding and bounded reason without stale payer data', () => {
    const expired = projectModelSelectionFunding(
      FUNDING,
      WORKSPACE,
      CP_WORKSPACE,
      BINDING,
      NOW + 600_000
    )
    expect(expired).toEqual({
      schemaVersion: 'model-funding-display/v1',
      workspaceId: WORKSPACE,
      ...BINDING,
      state: 'blocked',
      reasonCode: 'READINESS_UNAVAILABLE',
    })
    const revoked = projectModelSelectionFunding(
      { ...FUNDING, state: 'blocked', reasonCode: 'WORKSPACE_GRANT_REVOKED' },
      WORKSPACE,
      CP_WORKSPACE,
      BINDING,
      NOW
    )
    expect(revoked).not.toHaveProperty('fundingOwner')
    expect(revoked).toMatchObject({ reasonCode: 'WORKSPACE_GRANT_REVOKED' })
  })

  test('browser input never supplies target, payer, credentials, authority, or inherited direct choices', () => {
    expect(
      parseModelMetadataRequest({ action: 'selection.resolve', input: { role: 'direct' } })
    ).toEqual({ action: 'selection.resolve', input: { role: 'direct' } })
    for (const input of [
      { role: ['lead'] },
      { role: 'lead', target: TARGET },
      { role: 'direct', secret: 'canary' },
      { role: 'lead', fundingOwner: FUNDING.fundingOwner },
    ])
      expect(parseModelMetadataRequest({ action: 'selection.resolve', input })).toBeNull()
    expect(
      parseModelMetadataRequest({
        action: 'funding.get',
        input: { ...BINDING, authorityRevision: 4 },
      })
    ).toBeNull()
  })

  test('request authorization denies nonmembers, member writes and funding without exact accepted audience', async () => {
    const item = await fixture({ funding: FUNDING })
    const nonmember = routes(item.dependencies)
    nonmember.authorize = async () => false
    expect((await handleModelMetadata(request('list'), WORKSPACE, nonmember)).status).toBe(404)
    const member = routes(item.dependencies)
    member.authorize = async (_principal, permission) => permission === 'workspace.read'
    expect(
      (
        await handleModelMetadata(
          request('defaults.set', { expectedRevision: 1, idempotencyKey: 'defaults-member:one' }),
          WORKSPACE,
          member
        )
      ).status
    ).toBe(403)
    expect(
      (
        await handleModelMetadata(
          request('funding.get', BINDING),
          WORKSPACE,
          routes(item.dependencies)
        )
      ).status
    ).toBe(404)
    expect(item.requests).toHaveLength(0)
  })

  test('workspace and accepted funding audiences are rechecked before publishing payer data', async () => {
    const item = await fixture({ funding: FUNDING })
    const dependencies = routes(item.dependencies)
    let reads = 0
    dependencies.authorize = async () => ++reads === 1
    dependencies.authorizeFundingBinding = async () => true
    const denied = await handleModelMetadata(
      request('funding.get', BINDING),
      WORKSPACE,
      dependencies
    )
    expect(denied.status).toBe(404)
    expect(JSON.stringify(await denied.json())).not.toContain('Team billing')
    expect(item.requests).toHaveLength(1)
    dependencies.authorize = async () => true
    let audienceChecks = 0
    dependencies.authorizeFundingBinding = async () => ++audienceChecks === 1
    const audienceDenied = await handleModelMetadata(
      request('funding.get', BINDING),
      WORKSPACE,
      dependencies
    )
    expect(audienceDenied.status).toBe(404)
    expect(JSON.stringify(await audienceDenied.json())).not.toContain('Team billing')
  })

  test('funding expiry during the final publication check strips payer disclosure', async () => {
    const item = await fixture({ funding: FUNDING })
    let clock = NOW
    const dependencies = routes({ ...item.dependencies, now: () => clock })
    let reads = 0
    dependencies.authorizeFundingBinding = async () => {
      if (++reads === 2) clock = Date.parse(FUNDING.expiresAt)
      return true
    }
    const response = await handleModelMetadata(
      request('funding.get', BINDING),
      WORKSPACE,
      dependencies
    )
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({
      funding: {
        schemaVersion: 'model-funding-display/v1',
        workspaceId: WORKSPACE,
        ...BINDING,
        state: 'blocked',
        reasonCode: 'READINESS_UNAVAILABLE',
      },
    })
  })
})
