import { describe, expect, test } from 'bun:test'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { QueryClient } from '@tanstack/solid-query'

import {
  controlPlaneMutationOptions,
  controlPlaneQueryKeys,
  controlPlaneQueryOptions,
} from '../../src/control-plane'

function recordingClient() {
  const calls: unknown[][] = []
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      return {}
    }
  const api = {
    changeWorkspaceCatalogLifecycle: record('lifecycle'),
    createCloudConnection: record('create'),
    listCloudConnections: record('connections'),
    listWorkspaceAgentProfiles: record('profiles'),
    listWorkspaceSkills: record('skills'),
    publishWorkspaceSkill: record('publish'),
    revokeCloudConnection: record('revoke'),
    rotateCloudConnection: record('rotate'),
  } as unknown as AgentHqApiClient
  return { api, calls }
}

function recordingQueryClient() {
  const queryClient = new QueryClient()
  const invalidated: unknown[] = []
  queryClient.invalidateQueries = (async (filters: { queryKey: unknown }) => {
    invalidated.push(filters.queryKey)
  }) as QueryClient['invalidateQueries']
  return { invalidated, queryClient }
}

describe('control plane query contracts', () => {
  test('keys sit under the workspace prefix so leaving a workspace releases them', async () => {
    const { api, calls } = recordingClient()
    expect(controlPlaneQueryKeys.skills('w')).toEqual([
      'workspaces',
      'w',
      'control-plane',
      'skills',
    ])
    expect(controlPlaneQueryKeys.agentProfiles('w')).toEqual([
      'workspaces',
      'w',
      'control-plane',
      'agent-profiles',
    ])
    expect(controlPlaneQueryKeys.cloudConnections('w')).toEqual([
      'workspaces',
      'w',
      'control-plane',
      'cloud-connections',
    ])
    expect(controlPlaneQueryOptions.skills(api, undefined).enabled).toBe(false)
    expect(controlPlaneQueryOptions.cloudConnections(api, 'w', false).enabled).toBe(false)
    // A refusal (unscoped deployment, missing route) is a state, not a retry loop.
    expect(controlPlaneQueryOptions.skills(api, 'w').retry).toBe(false)
    await controlPlaneQueryOptions.skills(api, 'w').queryFn()
    await controlPlaneQueryOptions.agentProfiles(api, 'w').queryFn()
    await controlPlaneQueryOptions.cloudConnections(api, 'w').queryFn()
    expect(calls).toEqual([
      ['skills', 'w'],
      ['profiles', 'w'],
      ['connections', 'w'],
    ])
  })

  test('mutations mint idempotency keys and refresh only the list they change', async () => {
    const { api, calls } = recordingClient()
    const { invalidated, queryClient } = recordingQueryClient()

    const lifecycle = controlPlaneMutationOptions.changeCatalogLifecycle(api, queryClient, 'w')
    const deprecate = {
      action: 'deprecate',
      id: 'prf_1',
      input: { reason: 'Retired' },
      kind: 'profile',
    } as const
    await lifecycle.mutationFn(deprecate)
    await lifecycle.onSuccess(undefined, deprecate)
    const publish = controlPlaneMutationOptions.publishSkill(api, queryClient, 'w')
    await publish.mutationFn({
      content: { instructions: 'x' },
      displayName: 'x',
      idempotencyKey: 'caller-supplied-key-1',
      manifest: { semanticVersion: '1.0.0' },
    })
    await publish.onSuccess()
    const create = controlPlaneMutationOptions.createCloudConnection(api, queryClient, 'w')
    await create.mutationFn({
      connectorRef: 'connector:github',
      provider: 'github',
      secret: 's3cr3t-value',
    })
    await create.onSuccess()
    const rotate = controlPlaneMutationOptions.rotateCloudConnection(api, queryClient, 'w')
    await rotate.mutationFn({
      credentialId: 'crd_1',
      input: { expectedRevision: 1, secret: 's3cr3t-value' },
    })
    const revoke = controlPlaneMutationOptions.revokeCloudConnection(api, queryClient, 'w')
    await revoke.mutationFn({ credentialId: 'crd_1' })
    await revoke.onSuccess()

    expect(calls[0]).toEqual([
      'lifecycle',
      'w',
      { action: 'deprecate', id: 'prf_1', kind: 'profile' },
      { idempotencyKey: expect.stringMatching(/^adea-[0-9a-f-]{36}$/u), reason: 'Retired' },
    ])
    expect(calls[1]?.[2]).toMatchObject({ idempotencyKey: 'caller-supplied-key-1' })
    expect(calls[2]).toEqual([
      'create',
      'w',
      {
        connectorRef: 'connector:github',
        idempotencyKey: expect.stringMatching(/^adea-/u),
        provider: 'github',
        secret: 's3cr3t-value',
      },
    ])
    expect(calls[3]?.slice(0, 3)).toEqual(['rotate', 'w', 'crd_1'])
    expect(calls[4]).toEqual(['revoke', 'w', 'crd_1', { idempotencyKey: expect.any(String) }])
    expect(invalidated).toEqual([
      controlPlaneQueryKeys.agentProfiles('w'),
      controlPlaneQueryKeys.skills('w'),
      controlPlaneQueryKeys.cloudConnections('w'),
      controlPlaneQueryKeys.cloudConnections('w'),
    ])
    // Mutations carrying a secret are not kept in the mutation cache.
    expect(create.gcTime).toBe(0)
    expect(rotate.gcTime).toBe(0)
    // No query key ever carries secret material.
    expect(JSON.stringify(invalidated)).not.toContain('s3cr3t')
  })
})
