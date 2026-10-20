import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createRoot, createSignal } from 'solid-js'
import { createLeadChildSupply, type LeadChildIdentity } from '../src/lib/lead-child-supply'
import {
  createDesktopChatDraftChangeHandler,
  createDesktopChatLifecycleFence,
} from '../src/lib/desktop-chat-host'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const runtimeSessionId = 'session-1'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const laterIntentId = 'ca2d5fda-19cf-4554-a138-a94b8108eaa0'
const dispatchId = `dispatch_${'a'.repeat(32)}`
const identity = (intent = intentId): LeadChildIdentity => ({
  workspaceId,
  runtimeSessionId,
  intentId: intent,
  dispatchId,
})
const reply = (intent = intentId) => ({
  leadTurn: { intentId: intent, dispatchId },
  childObservations: {
    availability: 'available',
    children: [
      {
        delegationId: intent === intentId ? 'dlg_first' : 'dlg_second',
        role: 'research',
        state: 'completed',
        awaitingInput: false,
        stopRequested: false,
        acceptedAt: '2026-10-20T01:00:00.000Z',
        updatedAt: '2026-10-20T01:01:00.000Z',
      },
    ],
    totalChildren: 1,
    complete: true,
  },
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const lifecycle = { current: () => 1, isCurrent: (value: number) => value === 1 }
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

beforeEach(() => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
  })
})

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else Reflect.deleteProperty(globalThis, 'navigator')
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else Reflect.deleteProperty(globalThis, 'document')
})

test('mounted child supply ignores draft object changes and refreshes on exact identity changes', async () => {
  const [conversation, setConversation] = createSignal({ ...identity(), draft: 'one' })
  const requested: string[] = []
  const draftLifecycle = createDesktopChatLifecycleFence()
  const draftRequest = draftLifecycle.begin()
  const changeDraft = createDesktopChatDraftChangeHandler({
    scope: { workspaceId } as never,
    modelHost: {
      setDraft: (_scope: unknown, _identity: unknown, draft: unknown) => ({
        ...conversation(),
        draft,
      }),
    } as never,
    lifecycle: draftLifecycle,
    request: draftRequest,
    onConversationChange: setConversation as never,
  })
  await createRoot(async (dispose) => {
    const supply = createLeadChildSupply(
      {
        getLeadTurnChildren: async (_workspaceId, intent) => {
          requested.push(intent)
          return reply(intent) as never
        },
      },
      () => conversation(),
      lifecycle
    )
    await tick()
    expect(requested).toEqual([intentId])
    expect(supply()).toMatchObject({ availability: 'available', complete: true })
    changeDraft('two', { runtimeSessionId, generation: 1, scopeKey: 'test' })
    await tick()
    expect(requested).toEqual([intentId])
    expect(supply()).toMatchObject({ availability: 'available', complete: true })
    setConversation({ ...conversation(), intentId: laterIntentId })
    await tick()
    expect(requested).toEqual([intentId, laterIntentId])
    dispose()
  })
})

test('terminal lead child supply re-reads on online reconnect', async () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const events = new EventTarget()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events })
  try {
    let reads = 0
    await createRoot(async (dispose) => {
      const supply = createLeadChildSupply(
        {
          getLeadTurnChildren: async () => {
            reads += 1
            return reply() as never
          },
        },
        () => identity(),
        lifecycle
      )
      await tick()
      expect(reads).toBe(1)
      expect(supply()).toMatchObject({ availability: 'available' })
      events.dispatchEvent(new Event('online'))
      await tick()
      expect(reads).toBe(2)
      dispose()
    })
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('older child results and responses after unmount cannot replace current evidence', async () => {
  const [active, setActive] = createSignal(identity())
  let completeFirst!: (value: unknown) => void
  let reads = 0
  await createRoot(async (dispose) => {
    const supply = createLeadChildSupply(
      {
        getLeadTurnChildren: async (_workspaceId, intent) => {
          reads += 1
          if (intent === intentId)
            return new Promise((resolve) => (completeFirst = resolve)) as never
          return reply(intent) as never
        },
      },
      active,
      lifecycle
    )
    await tick()
    expect(reads).toBe(1)
    setActive(identity(laterIntentId))
    await tick()
    expect(reads).toBe(2)
    expect(supply()).toMatchObject({
      availability: 'available',
      complete: true,
      children: [{ delegationId: 'dlg_second' }],
    })
    completeFirst(reply())
    await tick()
    expect(supply()).toMatchObject({
      availability: 'available',
      complete: true,
      children: [{ delegationId: 'dlg_second' }],
    })
    dispose()
  })

  let completeUnmounted!: (value: unknown) => void
  await createRoot(async (dispose) => {
    const supply = createLeadChildSupply(
      {
        getLeadTurnChildren: async () =>
          new Promise((resolve) => (completeUnmounted = resolve)) as never,
      },
      () => identity(),
      lifecycle
    )
    await tick()
    dispose()
    completeUnmounted(reply())
    await tick()
    expect(supply()).toBeUndefined()
  })
})
