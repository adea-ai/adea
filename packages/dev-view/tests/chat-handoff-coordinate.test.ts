// Direct-session handoff coordination (#1177): the persisted authoritative
// coordination transfer (`dev.session.transferCoordination`) through the
// real ChatConversationModel, with actual draft preservation — the live
// model maps, not a boolean flag.
import { describe, expect, test } from 'bun:test'

import type { DevCommand, DevReply, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import type { DevRuntimeService } from '../src/platform'
import { createChatConversationModel } from '../src/chat/model'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const SESSION_ID = '00000000-0000-4000-8000-000000000010'

function session(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: SESSION_ID,
    scope: SCOPE,
    projectId: 'project-1',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    lifecycle: 'active',
    archived: false,
    projection: 'structured',
    generation: 3,
    version: 7,
    activeHarnessRunId: 'run-1',
    ...overrides,
  }
}

function ok<T>(operation: DevReply['operation'], value: T): DevReply {
  return {
    schemaVersion: 1,
    operation,
    requestId: 'request-1',
    ok: true,
    value,
    observedAt: '2026-09-22T10:00:00.000Z',
  } as DevReply
}

function err(
  operation: DevReply['operation'],
  code: string,
  message: string,
  retryable: boolean
): DevReply {
  return {
    schemaVersion: 1,
    operation,
    requestId: 'request-1',
    ok: false,
    error: { code, message, retryable },
    observedAt: '2026-09-22T10:00:00.000Z',
  } as DevReply
}

function hierarchy(): DevReply {
  return ok('dev.project.list', {
    items: [
      {
        id: 'project-1',
        scope: SCOPE,
        repoIds: ['repo-1'],
        lifecycle: 'ready',
        version: 1,
      },
    ],
    observedAt: '2026-09-22T10:00:00Z',
  })
}

function fakeService(execute: DevRuntimeService['execute']): DevRuntimeService {
  return {
    state: () => ({ status: 'ready' }),
    capabilitySnapshot: async () => ({
      scope: SCOPE,
      granted: [],
      unavailable: [],
      channelGeneration: 1,
      observedAt: '',
    }),
    execute,
  }
}

describe('handoff transferCoordination', () => {
  test('builds the exact fenced command and adopts the bumped generation', async () => {
    const seen: DevCommand[] = []
    let stored = session()
    const service = fakeService(async (command) => {
      if (command.operation === 'dev.project.list') return hierarchy()
      if (command.operation === 'dev.session.list')
        return ok(command.operation, { items: [stored], observedAt: '2026-09-22T10:00:00Z' })
      if (command.operation === 'dev.session.transferCoordination') {
        seen.push(command as DevCommand)
        stored = {
          ...stored,
          coordinationOwner: 'user',
          generation: stored.generation + 1,
          version: stored.version + 1,
        }
        return ok(command.operation, stored)
      }
      if (command.operation === 'dev.session.get') return ok(command.operation, stored)
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE)
    await model.attach(SESSION_ID)

    const next = await model.coordinate(SESSION_ID, { toHolder: 'user' })

    expect(seen).toHaveLength(1)
    const body = seen[0]?.body as Record<string, unknown>
    expect(body).toMatchObject({
      runtimeSessionId: SESSION_ID,
      expectedGeneration: 3,
      toHolder: 'user',
      expectedOwnerVersion: 7,
    })
    expect('harnessRunId' in body).toBe(false)
    const resource = seen[0]?.resource as { kind: string; id: string; generation: number }
    expect(resource).toMatchObject({ kind: 'runtime_session', id: SESSION_ID, generation: 3 })
    // The confirmed receipt is adopted: same session, new generation/version.
    expect(next.runtimeSessionId).toBe(SESSION_ID)
    expect(next.generation).toBe(4)
    expect(next.version).toBe(8)
    expect(next.coordinationOwner).toBe('user')
  })

  test('a handoff names the exact bound run for the host to validate', async () => {
    const seen: DevCommand[] = []
    let stored = session()
    const service = fakeService(async (command) => {
      if (command.operation === 'dev.project.list') return hierarchy()
      if (command.operation === 'dev.session.list')
        return ok(command.operation, { items: [stored], observedAt: '2026-09-22T10:00:00Z' })
      if (command.operation === 'dev.session.transferCoordination') {
        seen.push(command as DevCommand)
        stored = {
          ...stored,
          coordinationOwner: 'lead',
          coordinationHarnessRunId: 'run-1',
          generation: stored.generation + 1,
          version: stored.version + 1,
        }
        return ok(command.operation, stored)
      }
      if (command.operation === 'dev.session.get') return ok(command.operation, stored)
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE)
    await model.attach(SESSION_ID)

    const next = await model.coordinate(SESSION_ID, { toHolder: 'lead', harnessRunId: 'run-1' })

    const body = seen[0]?.body as Record<string, unknown>
    expect(body).toMatchObject({ toHolder: 'lead', harnessRunId: 'run-1' })
    expect(next.coordinationOwner).toBe('lead')
  })

  test('a stale owner version propagates its code for conflict detection', async () => {
    const service = fakeService(async (command) => {
      if (command.operation === 'dev.project.list') return hierarchy()
      if (command.operation === 'dev.session.list')
        return ok(command.operation, { items: [session()], observedAt: '2026-09-22T10:00:00Z' })
      if (command.operation === 'dev.session.transferCoordination')
        return err(command.operation, 'stale_version', 'coordination owner version conflict', false)
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE)
    await model.attach(SESSION_ID)
    await expect(model.coordinate(SESSION_ID, { toHolder: 'user' })).rejects.toMatchObject({
      code: 'stale_version',
    })
  })

  test('coordination preserves the live draft text and revision', async () => {
    let stored = session()
    const service = fakeService(async (command) => {
      if (command.operation === 'dev.project.list') return hierarchy()
      if (command.operation === 'dev.session.list')
        return ok(command.operation, { items: [stored], observedAt: '2026-09-22T10:00:00Z' })
      if (command.operation === 'dev.session.transferCoordination') {
        stored = {
          ...stored,
          coordinationOwner: 'user',
          generation: stored.generation + 1,
          version: stored.version + 1,
        }
        return ok(command.operation, stored)
      }
      if (command.operation === 'dev.session.get') return ok(command.operation, stored)
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE)
    await model.attach(SESSION_ID)
    model.setDraft(SESSION_ID, 'unsent coordination note')
    const revisionBefore = model.draftRevision(SESSION_ID)

    const next = await model.coordinate(SESSION_ID, { toHolder: 'user' })

    expect(next.draft).toBe('unsent coordination note')
    expect(model.draftRevision(SESSION_ID)).toBe(revisionBefore)
    expect(next.generation).toBe(4)
  })

  test('lead-stop preserves the live draft, and a failed transfer leaves it intact', async () => {
    const stored = session()
    const service = fakeService(async (command) => {
      if (command.operation === 'dev.project.list') return hierarchy()
      if (command.operation === 'dev.session.list')
        return ok(command.operation, { items: [stored], observedAt: '2026-09-22T10:00:00Z' })
      if (command.operation === 'dev.session.cancelHarness')
        return ok(command.operation, {
          id: 'run-1',
          scope: SCOPE,
          runtimeSessionId: SESSION_ID,
          installationId: 'inst-1',
          agentProfile: {
            id: 'profile-1',
            version: 1,
            displayName: 'profile-1',
            capabilityPolicyVersion: 1,
          },
          state: 'cancelled',
          generation: 3,
          version: 2,
        })
      if (command.operation === 'dev.session.transferCoordination')
        return err(command.operation, 'stale_version', 'coordination owner version conflict', false)
      if (command.operation === 'dev.session.get') return ok(command.operation, stored)
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE)
    await model.attach(SESSION_ID)
    model.setDraft(SESSION_ID, 'do not lose this')
    const revisionBefore = model.draftRevision(SESSION_ID)

    const afterCancel = await model.cancel(SESSION_ID)
    expect(afterCancel.draft).toBe('do not lose this')
    expect(model.draftRevision(SESSION_ID)).toBe(revisionBefore)

    await expect(model.coordinate(SESSION_ID, { toHolder: 'user' })).rejects.toMatchObject({
      code: 'stale_version',
    })
    expect(model.project().conversations[0]?.draft).toBe('do not lose this')
    expect(model.draftRevision(SESSION_ID)).toBe(revisionBefore)
  })
})
