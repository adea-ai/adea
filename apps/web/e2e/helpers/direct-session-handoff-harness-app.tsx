// Mounted harness for direct-session handoff interactions (#1177).
//
// Renders the production ChatView with handoff={{}} (the production supply
// path) against a scripted conversation model whose transfer/cancel intents
// stay pending until the fixture resolves them — so busy, single-flight,
// error/retry, and late-completion fences are all drivable from Playwright.
// No backend, database, or shared service is touched.
// No app-shell stylesheet: the ad-hoc fixture server has no theme-cache
// generator, and these interactions assert roles, names, states, and
// behavior — never theme pixels.
import { Button } from '@adea-ai/ui/components/ui/button'
import { createMemo, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { ChatRuntimeError, ChatView, type ChatConversation } from '@adea-ai/dev-view/chat'

const SCOPE = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const

function conversation(
  id: string,
  runId: string | undefined,
  generation: number,
  draft: string
): ChatConversation {
  return {
    runtimeSessionId: id,
    scope: { ...SCOPE },
    projectId: '00000000-0000-4000-8000-000000000005',
    repoId: '00000000-0000-4000-8000-000000000006',
    worktreeId: '00000000-0000-4000-8000-000000000007',
    title: id === 'session-1' ? 'First session' : 'Second session',
    status: 'active',
    archived: false,
    projection: 'structured',
    generation,
    version: 4,
    ...(runId === undefined ? {} : { activeHarnessRunId: runId }),
    draft,
    draftBlocks: [],
    events: [],
    retention: { maxEvents: 1_000, oldestSequence: '0', newestSequence: '0', complete: true },
  }
}

type PendingTransfer = {
  resolve: (next: ChatConversation) => void
  reject: (error: Error) => void
  base: ChatConversation
  direction: { fromView: 'chat' | 'dev'; toView: 'chat' | 'dev' }
}

const STORAGE_KEY = 'direct-handoff-fixture-sessions-v1'

function initialSessions(): Record<string, ChatConversation> {
  // The host-double's durable store: a reload must observe the retained
  // coordination owner, never an in-memory receipt. Each Playwright test
  // runs in a fresh browser context, so fixtures start clean per test.
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, ChatConversation>
      if (parsed && parsed['session-1'] && parsed['session-2']) return parsed
    }
  } catch {
    // Disposable fixture: fall through to the canned sessions.
  }
  return {
    'session-1': conversation('session-1', 'run-1', 3, 'unsent coordination note'),
    'session-2': conversation('session-2', 'run-2', 2, ''),
  }
}

function Harness() {
  const [sessions, setSessions] = createSignal<Record<string, ChatConversation>>(initialSessions())
  const updateSessions = (
    update: (previous: Record<string, ChatConversation>) => Record<string, ChatConversation>
  ): void => {
    setSessions((previous) => {
      const next = update(previous)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // Disposable fixture: persistence is best-effort.
      }
      return next
    })
  }
  const [activeId, setActiveId] = createSignal('session-1')
  const [connected, setConnected] = createSignal(true)
  const [transferCalls, setTransferCalls] = createSignal(0)
  const [cancelCalls, setCancelCalls] = createSignal(0)
  const [lastDirection, setLastDirection] = createSignal('')
  const pendingTransfers: PendingTransfer[] = []

  const active = createMemo(() => sessions()[activeId()]!)

  const model = {
    openTranscript: async () => ({
      state: () => ({
        runtimeSessionId: activeId(),
        generation: active().generation,
        fromSequence: '0',
        events: [],
        availability: { status: 'available' },
        retention: active().retention,
      }),
      subscribe: () => () => {},
      close: () => {},
    }),
    send: async () => {},
    cancel: async () => {
      setCancelCalls((count) => count + 1)
      return active()
    },
    transfer: async (
      runtimeSessionId: string,
      direction: { fromView: 'chat' | 'dev'; toView: 'chat' | 'dev' }
    ) => {
      setTransferCalls((count) => count + 1)
      const base = sessions()[runtimeSessionId]!
      setLastDirection(`${direction.fromView}→${direction.toView}`)
      return new Promise<ChatConversation>((resolve, reject) => {
        pendingTransfers.push({ resolve, reject, base, direction })
      })
    },
  }

  const resolveTransfer = () => {
    // FIFO: the oldest pending intent commits first, like the host log.
    const pending = pendingTransfers.shift()
    if (!pending) return
    const next: ChatConversation = {
      ...pending.base,
      generation: pending.base.generation + 1,
      version: pending.base.version + 1,
      // The host-double retains coordination ownership from the explicit
      // direction, exactly like dev.session.transferInput does.
      coordinationOwner: pending.direction.toView === 'chat' ? 'user' : 'lead',
    }
    updateSessions((previous) => ({ ...previous, [pending.base.runtimeSessionId]: next }))
    pending.resolve(next)
  }

  const rejectTransferStale = () => {
    const pending = pendingTransfers.shift()
    if (!pending) return
    pending.reject(
      new ChatRuntimeError({
        code: 'stale_version',
        retryable: false,
        message: 'input owner version conflict',
      })
    )
  }

  return (
    <main>
      <div>
        <Button type="button" onClick={() => setActiveId('session-1')}>
          Show session 1
        </Button>
        <Button type="button" onClick={() => setActiveId('session-2')}>
          Show session 2
        </Button>
        <Button type="button" onClick={() => setConnected((value) => !value)}>
          {connected() ? 'Go offline' : 'Go online'}
        </Button>
        <Button type="button" onClick={resolveTransfer}>
          Resolve pending transfer
        </Button>
        <Button type="button" onClick={rejectTransferStale}>
          Reject pending transfer stale
        </Button>
        <Button
          type="button"
          onClick={() =>
            // A concurrent handoff commit observed via refresh: newer
            // canonical ownership held by the lead.
            updateSessions((previous) => ({
              ...previous,
              'session-1': {
                ...previous['session-1']!,
                generation: previous['session-1']!.generation + 1,
                version: previous['session-1']!.version + 1,
                coordinationOwner: 'lead',
              },
            }))
          }
        >
          Observe concurrent generation
        </Button>
        <output aria-label="Transfer calls">{transferCalls()}</output>
        <output aria-label="Cancel calls">{cancelCalls()}</output>
        <output aria-label="Last transfer direction">{lastDirection()}</output>
        <output aria-label="Active draft">{active().draft}</output>
        <output aria-label="Active generation">{active().generation}</output>
      </div>
      <ChatView
        conversation={active()}
        model={model}
        autoAttach={false}
        connected={connected()}
        handoff={{}}
      />
    </main>
  )
}

render(() => <Harness />, document.querySelector('#harness-root')!)
