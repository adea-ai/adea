import { describe, expect, test } from 'bun:test'

import type { RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import { createUnavailableDevRuntimeService } from '@adea-ai/dev-view/platform'
import {
  createDesktopChatModelHost,
  createDesktopChatLifecycleFence,
  createDesktopChatDraftChangeHandler,
} from '../src/lib/desktop-chat-host'
import {
  chatDraftScopeKey,
  submitChatDraftSnapshot,
} from '../../../packages/dev-view/src/chat/draft'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const OTHER_SCOPE: Scope = {
  ...SCOPE,
  accountId: '00000000-0000-4000-8000-000000000011',
}
const DRAFT_SCOPE_KEY = chatDraftScopeKey(SCOPE)

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
    const lifecycle = createDesktopChatLifecycleFence()
    const request = lifecycle.begin()
    const model = host.get(SCOPE)
    await model.list()
    const conversation = model.project().conversations[0]
    expect(conversation).toBeDefined()
    if (!conversation) return

    expect(host.get(SCOPE)).toBe(model)
    const pasteBlock = {
      id: 'paste-1',
      seq: 1,
      lines: 2,
      content: 'private line one\nprivate line two',
    }
    let ownerProjection: typeof conversation | undefined
    const onDraftChange = createDesktopChatDraftChangeHandler({
      scope: SCOPE,
      modelHost: host,
      lifecycle,
      request,
      onConversationChange: (next) => {
        ownerProjection = next
      },
    })
    onDraftChange(
      { text: 'unfinished [ Paste #1 · 2 lines ] draft', blocks: [pasteBlock] },
      {
        runtimeSessionId: conversation.runtimeSessionId,
        generation: conversation.generation,
        scopeKey: DRAFT_SCOPE_KEY,
      }
    )
    expect(host.draftRevision(SCOPE, conversation.runtimeSessionId)).toBe(1)
    expect(ownerProjection?.draft).toBe('unfinished [ Paste #1 · 2 lines ] draft')
    expect(ownerProjection).toMatchObject({
      draft: 'unfinished [ Paste #1 · 2 lines ] draft',
      draftBlocks: [pasteBlock],
    })
    onDraftChange(
      { text: 'cross-scope [ Paste #1 · 2 lines ] write', blocks: [pasteBlock] },
      {
        runtimeSessionId: conversation.runtimeSessionId,
        generation: conversation.generation,
        scopeKey: chatDraftScopeKey(OTHER_SCOPE),
      }
    )
    expect(host.draftRevision(SCOPE, conversation.runtimeSessionId)).toBe(1)
    expect(ownerProjection?.draft).toBe('unfinished [ Paste #1 · 2 lines ] draft')

    const identity = {
      runtimeSessionId: conversation.runtimeSessionId,
      generation: conversation.generation,
      scopeKey: DRAFT_SCOPE_KEY,
    }
    const submittedDraft = {
      text: 'unfinished [ Paste #1 · 2 lines ] draft',
      blocks: [pasteBlock],
    }
    let localRevision = 0
    let releaseDelivery!: () => void
    const delivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve
    })
    const staleCompletion = submitChatDraftSnapshot({
      draft: submittedDraft,
      submitted: {
        identity,
        hostRevision: 1,
        localRevision,
      },
      current: () => ({
        identity: {
          runtimeSessionId: ownerProjection!.runtimeSessionId,
          generation: ownerProjection!.generation,
          scopeKey: DRAFT_SCOPE_KEY,
        },
        hostRevision: host.draftRevision(SCOPE, conversation.runtimeSessionId),
        localRevision,
      }),
      deliver: async (prompt) => {
        expect(prompt).toContain('private line one\nprivate line two')
        await delivery
      },
      clear: () => onDraftChange({ text: '', blocks: [] }, identity, 1),
    })
    localRevision += 1
    onDraftChange({ text: 'newer [ Paste #1 · 2 lines ] edit', blocks: [pasteBlock] }, identity)
    releaseDelivery()
    await staleCompletion
    expect(ownerProjection).toMatchObject({
      draft: 'newer [ Paste #1 · 2 lines ] edit',
      draftBlocks: [pasteBlock],
    })

    const failedDraft = ownerProjection!
    await expect(
      submitChatDraftSnapshot({
        draft: { text: failedDraft.draft, blocks: failedDraft.draftBlocks },
        submitted: {
          identity,
          hostRevision: host.draftRevision(SCOPE, conversation.runtimeSessionId),
          localRevision,
        },
        current: () => ({
          identity,
          hostRevision: host.draftRevision(SCOPE, conversation.runtimeSessionId),
          localRevision,
        }),
        deliver: async () => {
          throw new Error('transport refused draft')
        },
        clear: () => onDraftChange({ text: '', blocks: [] }, identity),
      })
    ).rejects.toThrow('transport refused draft')
    expect(ownerProjection).toMatchObject({
      draft: 'newer [ Paste #1 · 2 lines ] edit',
      draftBlocks: [pasteBlock],
    })

    // A direct canonical model writer advances the same revision authority.
    expect(model.setDraft(conversation.runtimeSessionId, 'direct canonical draft')?.draft).toBe(
      'direct canonical draft'
    )
    expect(model.project().conversations[0]?.draftBlocks).toEqual([])
    expect(host.draftRevision(SCOPE, conversation.runtimeSessionId)).toBe(3)

    // A deferred send from the old composer cannot overwrite a newer draft.
    expect(
      host.setDraft(
        SCOPE,
        {
          runtimeSessionId: conversation.runtimeSessionId,
          generation: conversation.generation,
          scopeKey: DRAFT_SCOPE_KEY,
        },
        'late clear',
        1
      )
    ).toBeUndefined()
    expect(model.project().conversations[0]?.draft).toBe('direct canonical draft')
    expect(
      host.setDraft(
        SCOPE,
        {
          runtimeSessionId: conversation.runtimeSessionId,
          generation: conversation.generation + 1,
          scopeKey: DRAFT_SCOPE_KEY,
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
          scopeKey: DRAFT_SCOPE_KEY,
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

describe('desktop Chat reading position', () => {
  test('bounds the cache and rejects invalid offsets', () => {
    const host = createDesktopChatModelHost(createUnavailableDevRuntimeService())
    host.get(SCOPE)
    const identity = { runtimeSessionId: 'invalid', generation: 1 }
    for (const top of [-1, Infinity, NaN])
      host.setReadingPosition(SCOPE, identity, { top, following: false })
    expect(host.readingPosition(SCOPE, identity)).toBeUndefined()
    for (let index = 0; index < 101; index += 1)
      host.setReadingPosition(
        SCOPE,
        { runtimeSessionId: `session-${index}`, generation: 1 },
        {
          top: index,
          following: false,
        }
      )
    expect(
      host.readingPosition(SCOPE, { runtimeSessionId: 'session-0', generation: 1 })
    ).toBeUndefined()
    expect(host.readingPosition(SCOPE, { runtimeSessionId: 'session-100', generation: 1 })).toEqual(
      {
        top: 100,
        following: false,
      }
    )
  })

  test('retains per-session positions only within the active authenticated scope', () => {
    const host = createDesktopChatModelHost(createUnavailableDevRuntimeService())
    host.get(SCOPE)
    const first = { runtimeSessionId: 'session-first', generation: 1 }
    const second = { runtimeSessionId: 'session-second', generation: 1 }
    host.setReadingPosition(SCOPE, first, { top: 240, following: false })
    host.setReadingPosition(SCOPE, second, { top: 80, following: true })
    expect(host.readingPosition(SCOPE, first)).toEqual({ top: 240, following: false })
    expect(host.readingPosition(SCOPE, second)).toEqual({ top: 80, following: true })
    expect(host.readingPosition(SCOPE, { ...first, generation: 2 })).toBeUndefined()
    host.get(OTHER_WORKSPACE_SCOPE)
    expect(host.readingPosition(SCOPE, first)).toBeUndefined()
    host.setReadingPosition(SCOPE, first, { top: 900, following: false })
    expect(host.readingPosition(OTHER_WORKSPACE_SCOPE, first)).toBeUndefined()
    host.get(SCOPE)
    expect(host.readingPosition(SCOPE, first)).toBeUndefined()
  })
})
