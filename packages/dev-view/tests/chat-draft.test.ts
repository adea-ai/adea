import { describe, expect, test } from 'bun:test'

import { formatToken } from '@adea-ai/ui/components/conversation'
import {
  chatDraftScopeKey,
  createChatSendRequests,
  expandChatDraftForSend,
  normalizeChatDraft,
  submitChatDraftSnapshot,
  type ChatDraftSnapshot,
  type ChatDraftValue,
} from '../src/chat/draft'
import { makeChatUserInput } from '../src/chat/model/commands'

const IDENTITY = {
  runtimeSessionId: 'session-1',
  generation: 3,
  scopeKey: chatDraftScopeKey({
    accountId: 'account-1',
    workspaceId: 'workspace-1',
    runtimeNodeId: 'node-1',
  }),
}

const block = {
  id: 'paste-1',
  seq: 1,
  lines: 2,
  content: 'const answer = 42\nconsole.log(answer)',
}

const draft: ChatDraftValue = {
  text: `Please inspect this:\n${formatToken(block)}\nThanks`,
  blocks: [block],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('Chat atomic drafts', () => {
  test('expands known paste tokens into the existing plain-text runtime prompt', () => {
    expect(expandChatDraftForSend(draft)).toBe(
      'Please inspect this:\nconst answer = 42\nconsole.log(answer)\nThanks'
    )
  })

  test('refuses unresolved token markers and expanded prompts over the existing limit', () => {
    expect(() =>
      expandChatDraftForSend({ text: 'See [ Paste #9 · 2 lines ]', blocks: [] })
    ).toThrow('pasted content is unavailable')

    const oversized = {
      ...block,
      content: 'x'.repeat(65_537),
    }
    expect(() =>
      expandChatDraftForSend({ text: formatToken(oversized), blocks: [oversized] })
    ).toThrow('65,536 characters')

    const emptyBlock = { ...block, lines: 1, content: '' }
    expect(() =>
      expandChatDraftForSend({ text: formatToken(emptyBlock), blocks: [emptyBlock] })
    ).toThrow('cannot be empty after pasted content is expanded')
  })

  test('keeps the existing chat transport plain text and enforces its prompt ceiling', () => {
    const input = makeChatUserInput({
      runtimeSessionId: IDENTITY.runtimeSessionId,
      generation: IDENTITY.generation,
      text: expandChatDraftForSend(draft),
      now: () => new Date('2026-10-01T12:00:00.000Z'),
    })
    expect(input).toMatchObject({
      runtimeSessionId: IDENTITY.runtimeSessionId,
      generation: IDENTITY.generation,
      source: 'chat_user',
      text: 'Please inspect this:\nconst answer = 42\nconsole.log(answer)\nThanks',
    })
    expect(input).not.toHaveProperty('blocks')
    expect(() =>
      makeChatUserInput({
        runtimeSessionId: IDENTITY.runtimeSessionId,
        generation: IDENTITY.generation,
        text: 'x'.repeat(65_537),
      })
    ).toThrow('65,536 characters')
  })

  test('drops orphaned and ambiguous blocks while keeping valid text and its matching block', () => {
    const orphan = { ...block, id: 'paste-2', seq: 2 }
    const duplicate = { ...block, id: 'paste-2', seq: 3 }
    const normalized = normalizeChatDraft({
      text: formatToken(block),
      blocks: [block, orphan, duplicate],
    })

    expect(normalized).toEqual({ text: formatToken(block), blocks: [block] })
  })

  test('captures prompt content before awaiting delivery and preserves a newer edit', async () => {
    const submitted: ChatDraftSnapshot = {
      identity: IDENTITY,
      hostRevision: 4,
      localRevision: 2,
    }
    let current = submitted
    const pending = deferred<void>()
    let delivered = ''
    let clearCount = 0

    const send = submitChatDraftSnapshot({
      draft,
      submitted,
      current: () => current,
      deliver: async (prompt) => {
        delivered = prompt
        await pending.promise
      },
      clear: () => {
        clearCount += 1
      },
    })

    current = { ...submitted, hostRevision: 5, localRevision: 3 }
    pending.resolve()
    await send

    expect(delivered).toBe(expandChatDraftForSend(draft))
    expect(clearCount).toBe(0)
  })

  test('pending sends stay attached to their session generation and release their own token', () => {
    const requests = createChatSendRequests()
    const oldSession = `${IDENTITY.runtimeSessionId}:3`
    const newSession = `${IDENTITY.runtimeSessionId}:4`
    const finishOld = requests.begin(oldSession)
    expect(requests.isPending(oldSession)).toBe(true)
    expect(requests.isPending(newSession)).toBe(false)

    const finishNew = requests.begin(newSession)
    finishOld()
    expect(requests.isPending(oldSession)).toBe(false)
    expect(requests.isPending(newSession)).toBe(true)
    finishNew()
    expect(requests.isPending(newSession)).toBe(false)
  })

  test('clears only after successful delivery when session, generation and revisions still match', async () => {
    const submitted: ChatDraftSnapshot = {
      identity: IDENTITY,
      hostRevision: 4,
      localRevision: 2,
    }
    let clearCount = 0

    await submitChatDraftSnapshot({
      draft,
      submitted,
      current: () => submitted,
      deliver: async () => undefined,
      clear: () => {
        clearCount += 1
      },
    })
    expect(clearCount).toBe(1)

    for (const current of [
      { ...submitted, identity: { ...IDENTITY, runtimeSessionId: 'other-session' } },
      { ...submitted, identity: { ...IDENTITY, generation: IDENTITY.generation + 1 } },
      {
        ...submitted,
        identity: { ...IDENTITY, scopeKey: 'other-account\u0000workspace\u0000node' },
      },
      { ...submitted, hostRevision: submitted.hostRevision + 1 },
      { ...submitted, localRevision: submitted.localRevision + 1 },
    ]) {
      await submitChatDraftSnapshot({
        draft,
        submitted,
        current: () => current,
        deliver: async () => undefined,
        clear: () => {
          clearCount += 1
        },
      })
    }
    expect(clearCount).toBe(1)
  })

  test('leaves the canonical draft intact when delivery fails', async () => {
    let currentDraft = draft
    let clearCount = 0
    const submitted: ChatDraftSnapshot = {
      identity: IDENTITY,
      hostRevision: 4,
      localRevision: 2,
    }

    await expect(
      submitChatDraftSnapshot({
        draft,
        submitted,
        current: () => submitted,
        deliver: async () => {
          throw new Error('transport refused prompt')
        },
        clear: () => {
          currentDraft = { text: '', blocks: [] }
          clearCount += 1
        },
      })
    ).rejects.toThrow('transport refused prompt')

    expect(currentDraft).toEqual(draft)
    expect(clearCount).toBe(0)
  })
})
