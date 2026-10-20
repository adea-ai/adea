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
const publishedReply = (intent = intentId) => {
  const result = reply(intent)
  return {
    ...result,
    childObservations: {
      ...result.childObservations,
      children: result.childObservations.children.map((child) => ({
        ...child,
        outcome: { state: 'completed', publication: { status: 'published' } },
      })),
    },
  }
}
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
  const port = {
    getLeadTurnChildren: async (_workspaceId: string, intent: string) => {
      requested.push(intent)
      return reply(intent) as never
    },
  }
  await createRoot(async (dispose) => {
    const supply = createLeadChildSupply(
      () => port,
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

test('published CP outcome retries the explicit Adea timeline receipt on reconnect', async () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const events = new EventTarget()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events })
  const published: string[] = []
  const port = {
    getLeadTurnChildren: async () =>
      ({
        ...reply(),
        childObservations: {
          ...reply().childObservations,
          children: [
            {
              ...reply().childObservations.children[0],
              outcome: { state: 'completed', publication: { status: 'published' } },
            },
          ],
        },
      }) as never,
    publishLeadTurnChildren: async (_workspace: string, intent: string) => {
      published.push(intent)
      return { published: 1 }
    },
  }
  try {
    await createRoot(async (dispose) => {
      createLeadChildSupply(
        () => port,
        () => identity(),
        lifecycle
      )
      await tick()
      expect(published).toEqual([intentId])
      events.dispatchEvent(new Event('online'))
      await tick()
      expect(published).toEqual([intentId, intentId])
      dispose()
    })
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('terminal lead child supply re-reads on online reconnect', async () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const events = new EventTarget()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events })
  try {
    let reads = 0
    const port = {
      getLeadTurnChildren: async () => {
        reads += 1
        return reply() as never
      },
    }
    await createRoot(async (dispose) => {
      const supply = createLeadChildSupply(
        () => port,
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

test('same-identity client replacement reads through the new client and fences the old response', async () => {
  let completeOld!: (value: unknown) => void
  let oldReads = 0
  let newReads = 0
  const published: string[] = []
  const oldPort = {
    getLeadTurnChildren: async () => {
      oldReads += 1
      return new Promise((resolve) => (completeOld = resolve)) as never
    },
    publishLeadTurnChildren: async (_workspace: string, intent: string) => {
      published.push(`old:${intent}`)
      return { published: 1 }
    },
  }
  const fresh = reply()
  fresh.childObservations.children[0]!.delegationId = 'dlg_new_client'
  const newPort = {
    getLeadTurnChildren: async () => {
      newReads += 1
      return fresh as never
    },
    publishLeadTurnChildren: async (_workspace: string, intent: string) => {
      published.push(`new:${intent}`)
      return { published: 1 }
    },
  }
  const [client, setClient] = createSignal(oldPort as typeof oldPort | typeof newPort)
  await createRoot(async (dispose) => {
    const supply = createLeadChildSupply(client, () => identity(), lifecycle)
    await tick()
    expect(oldReads).toBe(1)
    setClient(newPort)
    await tick()
    expect(newReads).toBe(1)
    expect(supply()).toMatchObject({ children: [{ delegationId: 'dlg_new_client' }] })
    completeOld(publishedReply())
    await tick()
    expect(supply()).toMatchObject({ children: [{ delegationId: 'dlg_new_client' }] })
    expect(published).toEqual([])
    dispose()
  })
})

test('older child results and responses after unmount cannot replace current evidence', async () => {
  const [active, setActive] = createSignal(identity())
  let completeFirst!: (value: unknown) => void
  let reads = 0
  const published: string[] = []
  const firstPort = {
    getLeadTurnChildren: async (_workspaceId: string, intent: string) => {
      reads += 1
      if (intent === intentId) return new Promise((resolve) => (completeFirst = resolve)) as never
      return reply(intent) as never
    },
    publishLeadTurnChildren: async (_workspace: string, intent: string) => {
      published.push(intent)
      return { published: 1 }
    },
  }
  await createRoot(async (dispose) => {
    const supply = createLeadChildSupply(() => firstPort, active, lifecycle)
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
    completeFirst(publishedReply())
    await tick()
    expect(supply()).toMatchObject({
      availability: 'available',
      complete: true,
      children: [{ delegationId: 'dlg_second' }],
    })
    expect(published).toEqual([])
    dispose()
  })

  let completeUnmounted!: (value: unknown) => void
  const unmountedPort = {
    getLeadTurnChildren: async () =>
      new Promise((resolve) => (completeUnmounted = resolve)) as never,
    publishLeadTurnChildren: async (_workspace: string, intent: string) => {
      published.push(intent)
      return { published: 1 }
    },
  }
  await createRoot(async (dispose) => {
    const supply = createLeadChildSupply(
      () => unmountedPort,
      () => identity(),
      lifecycle
    )
    await tick()
    dispose()
    completeUnmounted(publishedReply())
    await tick()
    expect(supply()).toBeUndefined()
    expect(published).toEqual([])
  })
})

test('superseded child refresh cannot publish a delayed old outcome', async () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const events = new EventTarget()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events })
  let completeFirst!: (value: unknown) => void
  let reads = 0
  const published: string[] = []
  const port = {
    getLeadTurnChildren: async () => {
      reads += 1
      return reads === 1
        ? (new Promise((resolve) => (completeFirst = resolve)) as never)
        : (reply() as never)
    },
    publishLeadTurnChildren: async (_workspace: string, intent: string) => {
      published.push(intent)
      return { published: 1 }
    },
  }
  try {
    await createRoot(async (dispose) => {
      const supply = createLeadChildSupply(
        () => port,
        () => identity(),
        lifecycle
      )
      await tick()
      expect(reads).toBe(1)
      events.dispatchEvent(new Event('online'))
      await tick()
      expect(reads).toBe(2)
      expect(supply()).toMatchObject({ availability: 'available' })
      completeFirst(publishedReply())
      await tick()
      expect(published).toEqual([])
      dispose()
    })
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
