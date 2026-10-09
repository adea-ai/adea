import { describe, expect, test } from 'bun:test'
import type { DevRuntimeService } from '../src/platform'
import type { RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import { resolveHandoffSessionAuthority } from '../src/chat/model/handoff-authority'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

function record(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: 'session-1',
    scope: SCOPE,
    projectId: 'project-1',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    taskId: 'task-1',
    lifecycle: 'active',
    archived: false,
    projection: 'structured',
    generation: 3,
    version: 7,
    ...overrides,
  }
}

function service(
  overrides: {
    stored?: RuntimeSession | null
    manage?: boolean
    refusal?: string
  } = {}
): DevRuntimeService {
  const { stored = record(), manage = true, refusal } = overrides
  return {
    state: () => ({ status: 'ready' }),
    capabilitySnapshot: async (scope) => ({
      scope,
      granted: manage ? ['dev.session.manage', 'dev.session.read'] : ['dev.session.read'],
      unavailable: [],
      channelGeneration: 0,
      observedAt: new Date().toISOString(),
    }),
    execute: async (command) => {
      if (command.operation !== 'dev.session.get') throw new Error('unexpected operation')
      if (refusal)
        return {
          schemaVersion: 1 as const,
          operation: command.operation,
          requestId: command.requestId,
          ok: false as const,
          error: {
            code: refusal,
            retryable: false,
            message: refusal,
            observedAt: new Date().toISOString(),
          },
        }
      if (!stored)
        return {
          schemaVersion: 1 as const,
          operation: command.operation,
          requestId: command.requestId,
          ok: false as const,
          error: {
            code: 'not_found',
            retryable: false,
            message: 'runtime session not found',
            observedAt: new Date().toISOString(),
          },
        }
      return {
        schemaVersion: 1 as const,
        operation: command.operation,
        requestId: command.requestId,
        ok: true as const,
        value: stored,
        observedAt: new Date().toISOString(),
      }
    },
  } as DevRuntimeService
}

const input = { runtimeSessionId: 'session-1', taskId: 'task-1', observedGeneration: 3 }

describe('resolveHandoffSessionAuthority', () => {
  test('a live controlled session at the observed generation authorizes the exact triple', async () => {
    const authority = await resolveHandoffSessionAuthority(service(), SCOPE, input)
    expect(authority).toEqual({ runtimeSessionId: 'session-1', taskId: 'task-1', generation: 3 })
  })

  test('without session control permission nothing is read or posted', async () => {
    await expect(
      resolveHandoffSessionAuthority(service({ manage: false }), SCOPE, input)
    ).rejects.toThrow('control permission')
  })

  test('a phantom session fails closed', async () => {
    await expect(
      resolveHandoffSessionAuthority(service({ stored: null }), SCOPE, input)
    ).rejects.toThrow('not_found')
  })

  test('a session in another scope fails closed', async () => {
    const other = {
      ...SCOPE,
      workspaceId: '00000000-0000-4000-8000-000000000009',
    }
    await expect(
      resolveHandoffSessionAuthority(service({ stored: record({ scope: other }) }), SCOPE, input)
    ).rejects.toThrow('another scope')
  })

  test('a session bound to another task fails closed', async () => {
    await expect(
      resolveHandoffSessionAuthority(
        service({ stored: record({ taskId: 'task-other' }) }),
        SCOPE,
        input
      )
    ).rejects.toThrow('another task')
  })

  test('an archived or ended session fails closed', async () => {
    for (const stored of [record({ archived: true }), record({ lifecycle: 'completed' })])
      await expect(
        resolveHandoffSessionAuthority(service({ stored }), SCOPE, input)
      ).rejects.toThrow(/archived or ended/)
  })

  test('ACTUAL stale generation fails closed against the host record', async () => {
    // The view still shows generation 3, but the host record already
    // advanced to 5: the request must not be built, let alone posted.
    await expect(
      resolveHandoffSessionAuthority(service({ stored: record({ generation: 5 }) }), SCOPE, input)
    ).rejects.toThrow('advanced to generation 5')
  })

  test('a host refusal surfaces its code instead of inventing', async () => {
    await expect(
      resolveHandoffSessionAuthority(service({ refusal: 'stale_generation' }), SCOPE, input)
    ).rejects.toThrow('stale_generation')
  })
})
