import { expect, test } from 'bun:test'
import type {
  ApiModelFundingView,
  AgentHqModelConnectionsClient,
} from '@adea-ai/api-client/model-connections'
import {
  currentModelFundingView,
  modelConnectionsQueryKeys,
  modelConnectionsQueryOptions,
  modelConnectionsMutationOptions,
} from '../../src/model-connections'
import { QueryClient } from '@tanstack/solid-query'

test('model registration and revocation refresh inventory without treating mutations as ready', async () => {
  const received: unknown[] = []
  const client = {
    createModelConnection: async (workspaceId: string, input: unknown) => {
      received.push({ workspaceId, input })
      return { connection: { models: [] } }
    },
    revokeModelConnection: async (workspaceId: string, input: unknown) => {
      received.push({ workspaceId, input })
      return { connection: { models: [] } }
    },
  } as unknown as AgentHqModelConnectionsClient
  const queries = new QueryClient()
  const workspaceInventoryKey = modelConnectionsQueryKeys.listForClient('workspace', 1)
  const otherInventoryKey = modelConnectionsQueryKeys.listForClient('other', 2)
  queries.setQueryData(workspaceInventoryKey, { connections: [] })
  queries.setQueryData(otherInventoryKey, { connections: [] })
  const create = modelConnectionsMutationOptions.create(client, queries, 'workspace')
  const revoke = modelConnectionsMutationOptions.revoke(client, queries, 'workspace')
  const registerInput = {
    credentialRef: 'crd_existing',
    credentialRevision: 1,
    idempotencyKey: 'register-model:one',
  }
  const revokeInput = {
    connectionRef: 'mconn_existing',
    expectedRevision: 1,
    idempotencyKey: 'revoke-model:one',
  }
  expect(await create.mutationFn(registerInput)).toEqual({ connection: { models: [] } })
  await create.onSuccess()
  expect(queries.getQueryState(workspaceInventoryKey)?.isInvalidated).toBeTrue()
  expect(queries.getQueryState(otherInventoryKey)?.isInvalidated).toBeFalse()
  await revoke.mutationFn(revokeInput)
  await revoke.onSuccess()
  expect(received).toEqual([
    { workspaceId: 'workspace', input: registerInput },
    { workspaceId: 'workspace', input: revokeInput },
  ])
  queries.clear()
})

test('model inventory cache identity is isolated between signed clients under one workspace', async () => {
  const first = { listModelConnections: async () => ({ owner: 'first' }) }
  const replacement = { listModelConnections: async () => ({ owner: 'replacement' }) }
  const firstOptions = modelConnectionsQueryOptions.list(
    first as unknown as AgentHqModelConnectionsClient,
    'workspace'
  )
  const replacementOptions = modelConnectionsQueryOptions.list(
    replacement as unknown as AgentHqModelConnectionsClient,
    'workspace'
  )

  expect(firstOptions.queryKey).not.toEqual(replacementOptions.queryKey)
  expect(
    firstOptions.queryKey.slice(0, modelConnectionsQueryKeys.list('workspace').length)
  ).toEqual(modelConnectionsQueryKeys.list('workspace'))
  expect(await firstOptions.queryFn()).toEqual({ owner: 'first' })
  expect(await replacementOptions.queryFn()).toEqual({ owner: 'replacement' })
})

test('funding query keys bind every accepted execution reference and never use a role default', () => {
  const binding = {
    executionId: 'exe_one',
    attemptId: 'att_one',
    selectionRef: 'msel_one',
    selectionRevision: 1,
  }
  const keys = [
    modelConnectionsQueryKeys.funding('workspace', binding),
    modelConnectionsQueryKeys.funding('workspace', { ...binding, attemptId: 'att_two' }),
    modelConnectionsQueryKeys.funding('workspace', { ...binding, selectionRevision: 2 }),
    modelConnectionsQueryKeys.funding('other-workspace', binding),
  ]
  expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(4)
  const client = {} as AgentHqModelConnectionsClient
  expect(modelConnectionsQueryOptions.funding(client, 'workspace').enabled).toBeFalse()
  expect(modelConnectionsQueryOptions.funding(client, 'workspace', binding)).toMatchObject({
    enabled: true,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
})

test('expired payer disclosure loses payer fields and preserves only accepted binding', () => {
  const funding: ApiModelFundingView = {
    schemaVersion: 'model-funding-display/v1',
    workspaceId: 'workspace',
    executionId: 'exe_one',
    attemptId: 'att_one',
    selectionRef: 'msel_one',
    selectionRevision: 1,
    state: 'ready',
    provider: 'anthropic',
    providerModel: 'fixture-model',
    accountRef: 'account-one',
    authKind: 'api_key',
    fundingSource: 'byo_api',
    authorityRevision: 1,
    expiresAt: '2026-10-08T12:00:00.000Z',
    fundingOwner: {
      ownerRef: 'payer-one',
      kind: 'workspace_account',
      displayName: 'Team payer',
      revision: 1,
    },
  }
  expect(currentModelFundingView(funding, Date.parse(funding.expiresAt))).toEqual({
    schemaVersion: funding.schemaVersion,
    workspaceId: funding.workspaceId,
    executionId: funding.executionId,
    attemptId: funding.attemptId,
    selectionRef: funding.selectionRef,
    selectionRevision: funding.selectionRevision,
    state: 'blocked',
    reasonCode: 'READINESS_UNAVAILABLE',
  })
})
