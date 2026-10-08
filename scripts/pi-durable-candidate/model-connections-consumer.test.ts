import { describe, expect, test } from 'bun:test'
import {
  ControlApiOperations,
  IdentifierSchemas,
  ModelReadinessReasonSchema,
  type ModelExecutionTarget,
} from '@adea-ai/sdk'

import { MODEL_READINESS_REASON_CODES } from '../../apps/web/src/server/model-selection-readiness'
import { createCandidateModelConnections } from './model-connections-consumer'

const WORKSPACE = 'wsp_01JABCDEF0123456789ABCDEFG'
const OTHER_WORKSPACE = 'wsp_01JABCDEF0123456789ABCDEFH'
const CONNECTION_REF = `mconn_${'1'.repeat(32)}`
const CREDENTIAL_REF = IdentifierSchemas.credentialId.parse('crd_01JABCDEF0123456789ABCDEFG')
const TARGET: ModelExecutionTarget = {
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
}
const CHOICE = { connectionRef: CONNECTION_REF, providerModel: 'fixture-model' }
const CONNECTION = {
  connectionRef: CONNECTION_REF,
  revision: 1,
  workspaceId: WORKSPACE,
  ownerRef: 'fixture-owner',
  credentialRef: CREDENTIAL_REF,
  credentialRevision: 1,
  provider: 'anthropic',
  accountRef: 'fixture-account',
  authKind: 'api_key',
  fundingSource: 'byo_api',
  status: 'active',
  models: ['fixture-model'],
  workspaceGrant: {
    grantRef: 'fixture-grant',
    revision: 1,
    status: 'active',
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
}
const DEFAULTS = { workspaceId: WORKSPACE, revision: 1, lead: CHOICE, direct: CHOICE }
const SELECTION = {
  schemaVersion: 'model-selection/v1',
  selectionRef: `msel_${'2'.repeat(32)}`,
  selectionRevision: 1,
  workspaceId: WORKSPACE,
  connectionRef: CONNECTION_REF,
  connectionRevision: 1,
  credentialRef: CREDENTIAL_REF,
  credentialRevision: 1,
  provider: 'anthropic',
  providerModel: 'fixture-model',
  accountRef: 'fixture-account',
  authKind: 'api_key',
  fundingSource: 'byo_api',
  ...TARGET,
  workspaceGrant: { grantRef: 'fixture-grant', revision: 1 },
  configurationRevision: 1,
}
const FUNDING_BINDING = {
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  selectionRef: SELECTION.selectionRef,
  selectionRevision: SELECTION.selectionRevision,
}
const FUNDING = {
  schemaVersion: 'model-funding-display/v1',
  workspaceId: WORKSPACE,
  ...FUNDING_BINDING,
  state: 'ready',
  provider: SELECTION.provider,
  providerModel: SELECTION.providerModel,
  accountRef: SELECTION.accountRef,
  authKind: SELECTION.authKind,
  fundingSource: SELECTION.fundingSource,
  fundingOwner: {
    ownerRef: 'recorded-payer:not-connection-admin',
    kind: 'workspace_account',
    displayName: 'Recorded payer',
    revision: 1,
    evidenceRef: 'payer-evidence:fixture',
  },
  authorizationRef: 'spending:fixture',
  authorityRevision: 1,
  expiresAt: '2099-01-01T00:00:00.000Z',
}

function fixture(transform?: (body: Record<string, any>) => Record<string, any>) {
  const requests: { path: string; body: Record<string, any> }[] = []
  const consumer = createCandidateModelConnections({
    baseUrl: 'http://127.0.0.1:43199',
    serviceToken: 'candidate-synthetic-service-bearer',
    workspaceId: WORKSPACE,
    servicePrincipalId: 'svc_workspace-admin',
    requestId: () => 'req_01JABCDEF0123456789ABCDEFG',
    traceId: () => 'trc_01JABCDEF0123456789ABCDEFG',
    commandId: () => 'cmd_01JABCDEF0123456789ABCDEFG',
    now: () => new Date('2026-10-08T12:00:00.000Z'),
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body))
      const path = new URL(String(url)).pathname
      requests.push({ path, body })
      const data = path.endsWith('/funding/get')
        ? { funding: FUNDING }
        : path.endsWith('/list')
          ? {
              connections: [
                {
                  connection: CONNECTION,
                  models: [
                    {
                      providerModel: 'fixture-model',
                      readiness: { ready: true, reasonCode: 'READY' },
                    },
                  ],
                },
              ],
            }
          : path.includes('/defaults/')
            ? { defaults: DEFAULTS }
            : path.endsWith('/resolve')
              ? { selection: SELECTION }
              : {
                  connection: {
                    ...CONNECTION,
                    status: path.endsWith('/revoke') ? 'revoked' : 'active',
                  },
                }
      const response = {
        contractVersion: body.contractVersion,
        requestId: body.requestId,
        correlation: body.correlation,
        data,
      }
      const output = transform ? transform(response) : response
      return Response.json(output, { status: output.error ? 409 : 200 })
    },
  })
  return { consumer, requests }
}

describe('packed SDK candidate model consumer', () => {
  test('funding reads bind the exact accepted attempt and selection without model work', async () => {
    const h = fixture()
    expect(await h.consumer.funding(FUNDING_BINDING)).toEqual(FUNDING)
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0].path).toBe('/v1/model-connections/selection/funding/get')
    expect(h.requests[0].body.parameters).toEqual(FUNDING_BINDING)
    expect(h.requests[0].body.payload).toBeUndefined()
  })
  test('another attempt cannot supply a schema-valid funding disclosure', async () => {
    const h = fixture((response) => ({
      ...response,
      data: { funding: { ...FUNDING, attemptId: 'att_01JABCDEF0123456789ABCDEFH' } },
    }))
    await expect(h.consumer.funding(FUNDING_BINDING)).rejects.toMatchObject({
      reasonCode: 'READINESS_UNAVAILABLE',
    })
  })
  test('safe readiness reason set matches the actual public SDK schema', () => {
    expect([...MODEL_READINESS_REASON_CODES].toSorted()).toEqual(
      [...ModelReadinessReasonSchema.options].toSorted()
    )
  })

  test('all six actual typed SDK methods reach their exact scoped schema paths', async () => {
    const { consumer, requests } = fixture()
    await consumer.create(
      { credentialRef: CREDENTIAL_REF, credentialRevision: 1 },
      'candidate-create:one'
    )
    expect((await consumer.list({ target: TARGET }))[0]?.models[0]?.readiness.ready).toBeTrue()
    expect(await consumer.getDefaults()).toEqual(DEFAULTS)
    expect(
      await consumer.setDefaults(
        { expectedRevision: 0, lead: CHOICE, direct: CHOICE },
        'candidate-defaults:one'
      )
    ).toEqual(DEFAULTS)
    expect(await consumer.resolve({ role: 'direct', target: TARGET, override: CHOICE })).toEqual(
      SELECTION
    )
    expect(
      (
        await consumer.revoke(
          { connectionRef: CONNECTION_REF, expectedRevision: 1 },
          'candidate-revoke:one'
        )
      ).status
    ).toBe('revoked')
    expect(requests.map((item) => item.path)).toEqual([
      ControlApiOperations.createModelConnection.path,
      ControlApiOperations.listModelConnections.path,
      ControlApiOperations.getModelDefaults.path,
      ControlApiOperations.setModelDefaults.path,
      ControlApiOperations.resolveModelSelection.path,
      ControlApiOperations.revokeModelConnection.path,
    ])
    for (const { body } of requests) {
      expect(body.workspaceId).toBe(WORKSPACE)
      expect(body.caller).toEqual({ servicePrincipalId: 'svc_workspace-admin' })
      expect(JSON.stringify(body)).not.toContain('candidate-synthetic-service-bearer')
    }
    expect(requests[3]?.body.payload.expectedRevision).toBe(0)
    expect(requests[4]?.body.parameters.role).toBe('direct')
    expect(requests[4]?.body.parameters.override).toEqual(CHOICE)
  })

  test('strict real request schemas reject secret-bearing inputs before transport', async () => {
    const { consumer, requests } = fixture()
    const secretInput = {
      credentialRef: CREDENTIAL_REF,
      credentialRevision: 1,
      secret: 'candidate-secret-canary',
    }
    await expect(consumer.create(secretInput, 'candidate-create:secret')).rejects.toMatchObject({
      reasonCode: 'READINESS_UNAVAILABLE',
    })
    expect(requests).toHaveLength(0)
  })

  test('wrong-workspace metadata and miscorrelated responses fail closed', async () => {
    const wrongWorkspace = fixture((response) => ({
      ...response,
      data: { defaults: { ...DEFAULTS, workspaceId: OTHER_WORKSPACE } },
    }))
    await expect(wrongWorkspace.consumer.getDefaults()).rejects.toMatchObject({
      reasonCode: 'READINESS_UNAVAILABLE',
    })
    const wrongIdentity = fixture((response) => ({
      ...response,
      requestId: 'req_01JABCDEF0123456789ABCDEFH',
    }))
    await expect(wrongIdentity.consumer.getDefaults()).rejects.toMatchObject({
      reasonCode: 'READINESS_UNAVAILABLE',
    })
  })

  test('same-workspace responses must bind the requested credential and connection', async () => {
    const wrongCredential = fixture((response) => ({
      ...response,
      data: { connection: { ...CONNECTION, credentialRevision: 2 } },
    }))
    await expect(
      wrongCredential.consumer.create(
        { credentialRef: CREDENTIAL_REF, credentialRevision: 1 },
        'candidate-create:wrong-credential'
      )
    ).rejects.toMatchObject({ reasonCode: 'READINESS_UNAVAILABLE' })
    const wrongConnection = fixture((response) => ({
      ...response,
      data: {
        connection: { ...CONNECTION, connectionRef: `mconn_${'3'.repeat(32)}`, status: 'revoked' },
      },
    }))
    await expect(
      wrongConnection.consumer.revoke(
        { connectionRef: CONNECTION_REF, expectedRevision: 1 },
        'candidate-revoke:wrong-connection'
      )
    ).rejects.toMatchObject({ reasonCode: 'READINESS_UNAVAILABLE' })
  })

  test('an explicit direct override cannot silently resolve a different model', async () => {
    const { consumer } = fixture((response) => ({
      ...response,
      data: { selection: { ...SELECTION, providerModel: 'other-model' } },
    }))
    await expect(
      consumer.resolve({ role: 'direct', target: TARGET, override: CHOICE })
    ).rejects.toMatchObject({ reasonCode: 'READINESS_UNAVAILABLE' })
  })

  test('credential revision denial exposes only the safe code, with no fallback request', async () => {
    const { consumer, requests } = fixture((response) => ({
      contractVersion: response.contractVersion,
      requestId: response.requestId,
      correlation: response.correlation,
      error: {
        code: 'CREDENTIAL_REVISION_CHANGED',
        class: 'stale_reference',
        message: 'provider-secret-canary',
        retryable: false,
        source: 'provider',
      },
    }))
    const error = await consumer
      .resolve({ role: 'direct', target: TARGET, override: CHOICE })
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({ reasonCode: 'CREDENTIAL_REVISION_CHANGED' })
    expect(String(error)).not.toContain('provider-secret-canary')
    expect(JSON.stringify(error)).not.toContain('provider-secret-canary')
    expect(requests).toHaveLength(1)
  })
})
