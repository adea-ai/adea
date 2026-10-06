import { describe, expect, test } from 'bun:test'

import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
import type { DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'

import { createDesktopWorkspaceConnectionsService } from '../src/lib/desktop-workspace-connections'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-00000000000a',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const REF_ID = '00000000-0000-4000-8000-0000000000c1'
const PROFILE_ID = '00000000-0000-4000-8000-0000000000d1'

const connections = (version: number, extra: Record<string, unknown> = {}) => ({
  scope: SCOPE,
  gitHosting: [],
  harnessAccounts: [],
  version,
  availableHarnesses: [
    { harnessId: 'pi', displayName: 'Pi', accountHosts: ['api.anthropic.com', 'api.openai.com'] },
  ],
  ...extra,
})

function runtimeWith(
  answer: (command: DevCommand) => unknown,
  options: { ready?: boolean } = {}
): { runtime: DevRuntimeService; commands: DevCommand[] } {
  const commands: DevCommand[] = []
  const runtime: DevRuntimeService = {
    state: () =>
      options.ready === false
        ? { status: 'unavailable', reason: 'capability_unavailable' }
        : { status: 'ready' },
    preferenceScope: () => (options.ready === false ? undefined : SCOPE),
    capabilitySnapshot: async () => {
      throw new Error('unused')
    },
    async execute(command): Promise<DevReply> {
      commands.push(command)
      const value = answer(command)
      if (value instanceof Error)
        return {
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: false,
          error: {
            code: value.message as never,
            retryable: false,
            message: value.message,
            observedAt: new Date().toISOString(),
          },
        }
      return {
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        ok: true,
        value,
        observedAt: new Date().toISOString(),
      }
    },
  }
  return { runtime, commands }
}

describe('desktop workspace connections bridge', () => {
  test('load reads bindings, profiles, and credential refs on the runtime scope', async () => {
    const { runtime, commands } = runtimeWith((command) => {
      if (command.operation === 'dev.connections.get') return connections(2)
      if (command.operation === 'dev.harness.accountProfiles.list')
        return {
          items: [
            {
              id: PROFILE_ID,
              harnessId: 'pi',
              label: 'Work',
              credentialRefId: REF_ID,
              version: 1,
            },
          ],
          observedAt: new Date().toISOString(),
        }
      return {
        items: [
          {
            id: REF_ID,
            scope: SCOPE,
            label: 'Anthropic',
            host: 'api.anthropic.com',
            kind: 'other',
            state: 'ready',
            version: 1,
          },
        ],
        observedAt: new Date().toISOString(),
      }
    })
    const snapshot = await createDesktopWorkspaceConnectionsService(runtime).load()
    expect(snapshot.connections.version).toBe(2)
    expect(snapshot.profiles.map((profile) => profile.id)).toEqual([PROFILE_ID])
    expect(snapshot.credentialRefs.map((ref) => ref.id)).toEqual([REF_ID])
    expect(commands.map((command) => command.operation).toSorted()).toEqual([
      'dev.connections.get',
      'dev.harness.accountProfiles.list',
      'dev.repo.credentialRefs',
    ])
    for (const command of commands) expect(command.scope).toEqual(SCOPE)
  })

  test('mutations send the registry body exactly and decode the reply strictly', async () => {
    const { runtime, commands } = runtimeWith(() => connections(3))
    const service = createDesktopWorkspaceConnectionsService(runtime)
    const result = await service.setGitHosting({
      host: 'github.com',
      credentialRefId: null,
      expectedVersion: 2,
    })
    expect(result.version).toBe(3)
    expect(commands[0]).toMatchObject({
      operation: 'dev.connections.setGitHosting',
      body: { host: 'github.com', credentialRefId: null, expectedVersion: 2 },
      capabilities: ['dev.repo.manage'],
    })
    await service.setHarnessAccount({ harnessId: 'pi', profileId: PROFILE_ID, expectedVersion: 3 })
    expect(commands[1]).toMatchObject({
      operation: 'dev.connections.setHarnessAccount',
      body: { harnessId: 'pi', profileId: PROFILE_ID, expectedVersion: 3 },
    })
  })

  test('a reply that fails strict decode fails closed as corrupt_state', async () => {
    const { runtime } = runtimeWith(() => connections(1, { secret: 'smuggled' }))
    await expect(createDesktopWorkspaceConnectionsService(runtime).load()).rejects.toMatchObject({
      code: 'corrupt_state',
    })
  })

  test('typed refusals surface verbatim and an unbound runtime is unavailable', async () => {
    const { runtime } = runtimeWith(() => new Error('stale_version'))
    await expect(
      createDesktopWorkspaceConnectionsService(runtime).setGitHosting({
        host: 'github.com',
        credentialRefId: REF_ID,
        expectedVersion: 0,
      })
    ).rejects.toMatchObject({ code: 'stale_version' })

    const unbound = runtimeWith(() => connections(0), { ready: false })
    await expect(
      createDesktopWorkspaceConnectionsService(unbound.runtime).load()
    ).rejects.toMatchObject({ code: 'capability_unavailable' })
    expect(unbound.commands).toHaveLength(0)
  })
})
