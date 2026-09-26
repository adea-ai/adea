import { describe, expect, test } from 'bun:test'

import type { RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import { createUnavailableDevRuntimeService } from '@adea-ai/dev-view/platform'
import {
  createDesktopChatModelHost,
  createDesktopChatLifecycleFence,
} from '../src/lib/desktop-chat-host'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const OTHER_SCOPE: Scope = {
  ...SCOPE,
  accountId: '00000000-0000-4000-8000-000000000011',
}

const OTHER_WORKSPACE_SCOPE: Scope = {
  ...SCOPE,
  workspaceId: '00000000-0000-4000-8000-000000000012',
}

function session(scope: Scope): RuntimeSession {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    scope,
    projectId: 'project-1',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    lifecycle: 'active',
    archived: false,
    projection: 'structured',
    generation: 1,
    version: 1,
  }
}

describe('desktop chat host', () => {
  test('keeps one model per exact scope and rejects late writes from an old scope', async () => {
    const unavailable = createUnavailableDevRuntimeService()
    const runtime = {
      ...unavailable,
      execute: async (command: { operation: string }) => {
        const value =
          command.operation === 'dev.project.list'
            ? {
                items: [
                  {
                    id: 'project-1',
                    scope: SCOPE,
                    name: 'Project',
                    groupIds: [],
                    repoIds: ['repo-1'],
                    lifecycle: 'ready',
                    version: 1,
                  },
                ],
                observedAt: '2026-09-22T10:00:00.000Z',
              }
            : command.operation === 'dev.session.list'
              ? { items: [session(SCOPE)], observedAt: '2026-09-22T10:00:00.000Z' }
              : { items: [], observedAt: '2026-09-22T10:00:00.000Z' }
        return {
          schemaVersion: 1,
          operation: command.operation,
          requestId: 'request-1',
          ok: true,
          value,
          observedAt: '2026-09-22T10:00:00.000Z',
        } as never
      },
    }
    const host = createDesktopChatModelHost(runtime)
    const model = host.get(SCOPE)
    await model.list()
    const conversation = model.project().conversations[0]
    expect(conversation).toBeDefined()
    if (!conversation) return

    expect(host.get(SCOPE)).toBe(model)
    expect(
      host.setDraft(
        SCOPE,
        { runtimeSessionId: conversation.runtimeSessionId, generation: conversation.generation },
        'unfinished draft'
      )?.draft
    ).toBe('unfinished draft')
    expect(host.draftRevision(SCOPE, conversation.runtimeSessionId)).toBe(1)

    // A deferred send from the old composer cannot overwrite a newer draft.
    expect(
      host.setDraft(
        SCOPE,
        { runtimeSessionId: conversation.runtimeSessionId, generation: conversation.generation },
        'late clear',
        0
      )
    ).toBeUndefined()
    expect(model.project().conversations[0]?.draft).toBe('unfinished draft')
    expect(
      host.setDraft(
        SCOPE,
        {
          runtimeSessionId: conversation.runtimeSessionId,
          generation: conversation.generation + 1,
        },
        'late old-generation write'
      )
    ).toBeUndefined()

    host.get(OTHER_SCOPE)
    expect(
      host.setDraft(
        SCOPE,
        {
          runtimeSessionId: conversation.runtimeSessionId,
          generation: conversation.generation,
        },
        'late cross-account write'
      )
    ).toBeUndefined()
    expect(host.get(OTHER_SCOPE)).not.toBe(model)
    expect(host.get(OTHER_WORKSPACE_SCOPE)).not.toBe(model)
  })

  test('invalidates late attachment continuations after unmount or a newer load', () => {
    const fence = createDesktopChatLifecycleFence()
    const first = fence.begin()
    expect(fence.isCurrent(first)).toBe(true)

    fence.invalidate()
    expect(fence.isCurrent(first)).toBe(false)

    const second = fence.begin()
    expect(fence.isCurrent(second)).toBe(true)
    const third = fence.begin()
    expect(fence.isCurrent(second)).toBe(false)
    expect(fence.isCurrent(third)).toBe(true)
  })
})
