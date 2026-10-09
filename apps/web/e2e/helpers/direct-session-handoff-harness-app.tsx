// Mounted harness for direct-session handoff interactions (#1177).
//
// Renders the production ChatView with handoff supply against scripted
// conversation, run, and lead-turn facts. Lead cancellation and session-run
// cancellation stay pending until the fixture resolves them — so busy,
// single-flight, error/retry, replacement, and late-completion fences are
// all drivable from Playwright. Lead-turn facts persist in localStorage so
// a reload re-reads them like a canonical source would; each Playwright
// test runs in a fresh browser context, so fixtures start clean per test.
// No backend, database, or shared service is touched.
import { Button } from '@adea-ai/ui/components/ui/button'
import { createMemo, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import {
  ChatView,
  type ChatConversation,
  type HandoffLeadAgent,
  type HandoffLeadTurn,
} from '@adea-ai/dev-view/chat'

const LEAD_AGENT: HandoffLeadAgent = {
  id: '00000000-0000-4000-8000-0000000000b2',
  isWorkspaceLead: true,
  lifecycleState: 'active',
}
import type { HarnessRun } from '@adea-ai/types/dev-runtime'

const SCOPE = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const

const STORAGE_KEY = 'direct-handoff-fixture-v2'

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

function harnessRun(id: string, sessionId: string): HarnessRun {
  return {
    id,
    scope: { ...SCOPE },
    runtimeSessionId: sessionId,
    installationId: 'inst-1',
    agentProfile: {
      id: 'profile-1',
      version: 1,
      displayName: 'profile-1',
      capabilityPolicyVersion: 1,
    },
    state: 'working',
    generation: 3,
    version: 1,
  }
}

type FixtureState = {
  sessions: Record<string, ChatConversation>
  leadTurns: Record<string, HandoffLeadTurn | undefined>
}

function initialState(): FixtureState {
  // The durable side of the host-double: a reload must observe the same
  // lead-turn facts and sessions, never in-memory UI state.
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as FixtureState
      if (parsed && parsed.sessions?.['session-1'] && parsed.sessions?.['session-2'])
        return { sessions: parsed.sessions, leadTurns: parsed.leadTurns ?? {} }
    }
  } catch {
    // Disposable fixture: fall through to the canned state.
  }
  return {
    sessions: {
      'session-1': conversation('session-1', 'run-1', 3, 'unsent coordination note'),
      'session-2': conversation('session-2', 'run-2', 2, ''),
    },
    leadTurns: {},
  }
}

type PendingLeadCancel = {
  resolve: () => void
  reject: (error: Error) => void
  sessionId: string
}
type PendingIntent = {
  resolve: (value: ChatConversation) => void
  reject: (error: Error) => void
  sessionId: string
}

function persistFixture(
  nextSessions: Record<string, ChatConversation>,
  nextLeads: Record<string, HandoffLeadTurn | undefined>
): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sessions: nextSessions, leadTurns: nextLeads })
    )
  } catch {
    // Disposable fixture: persistence is best-effort.
  }
}

function Harness() {
  const [sessions, setSessions] = createSignal(initialState().sessions)
  const [leadTurns, setLeadTurns] = createSignal<Record<string, HandoffLeadTurn | undefined>>(
    initialState().leadTurns
  )
  const [activeId, setActiveId] = createSignal('session-1')
  const leadTurn = createMemo(() => leadTurns()[activeId()])
  const [runs, setRuns] = createSignal<readonly HarnessRun[]>([])
  const [connected, setConnected] = createSignal(true)
  const [leadCancelCalls, setLeadCancelCalls] = createSignal(0)
  const [sessionCancelCalls, setSessionCancelCalls] = createSignal(0)
  const [cancelledRunIds, setCancelledRunIds] = createSignal<readonly string[]>([])
  const pendingLeadCancels: PendingLeadCancel[] = []
  const pendingSessionCancels: PendingIntent[] = []

  const updateSessions = (
    update: (previous: Record<string, ChatConversation>) => Record<string, ChatConversation>
  ): void => {
    setSessions((previous) => {
      const next = update(previous)
      persistFixture(next, leadTurns())
      return next
    })
  }
  const updateLeadTurn = (next: HandoffLeadTurn | undefined): void => {
    const id = activeId()
    setLeadTurns((previous) => {
      const turns = { ...previous, [id]: next }
      persistFixture(sessions(), turns)
      return turns
    })
  }

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
    cancel: async (runtimeSessionId: string, harnessRunId?: string) => {
      setSessionCancelCalls((count) => count + 1)
      const current = sessions()[runtimeSessionId]!
      const runId = harnessRunId ?? current.activeHarnessRunId ?? 'run-missing'
      setCancelledRunIds((ids) => [...ids, runId])
      return new Promise<ChatConversation>((resolve, reject) => {
        pendingSessionCancels.push({ resolve, reject, sessionId: runtimeSessionId })
      })
    },
  }

  // The canonical lead-turn cancel path, standing in for cancelLeadTurn:
  // deferred so busy/error/retry and late completion are drivable.
  const cancelLeadTurn = async () => {
    setLeadCancelCalls((count) => count + 1)
    const sessionId = activeId()
    return new Promise<void>((resolve, reject) => {
      pendingLeadCancels.push({ resolve, reject, sessionId })
    })
  }

  const resolveLeadCancel = () => {
    const pending = pendingLeadCancels.shift()
    if (!pending) return
    // The terminal state lands on the intent's owning session, never
    // whatever happens to be active when the fixture resolves.
    const owner = pending.sessionId
    setLeadTurns((previous) => {
      const current = previous[owner]
      const turns = {
        ...previous,
        [owner]: current ? { ...current, state: 'cancelled', canCancel: false } : undefined,
      }
      persistFixture(sessions(), turns)
      return turns
    })
    pending.resolve()
  }

  const resolveSessionCancel = () => {
    const pending = pendingSessionCancels.shift()
    if (!pending) return
    pending.resolve(sessions()[pending.sessionId]!)
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
        <Button
          type="button"
          onClick={() =>
            updateLeadTurn({
              intentId: '00000000-0000-4000-8000-0000000000a1',
              agentId: LEAD_AGENT.id,
              dispatchId: 'dispatch_11111111111111111111111111111111',
              state: 'running',
              canCancel: true,
            })
          }
        >
          Observe live lead turn
        </Button>
        <Button
          type="button"
          onClick={() =>
            updateLeadTurn(
              leadTurn() ? { ...leadTurn()!, state: 'completed', canCancel: false } : undefined
            )
          }
        >
          Observe lead turn completed
        </Button>
        <Button type="button" onClick={() => updateLeadTurn(undefined)}>
          Clear lead turn
        </Button>
        <Button
          type="button"
          onClick={() =>
            updateLeadTurn({
              intentId: '00000000-0000-4000-8000-0000000000a1',
              agentId: '00000000-0000-4000-8000-0000000000c3',
              dispatchId: 'dispatch_11111111111111111111111111111111',
              state: 'running',
              canCancel: true,
            })
          }
        >
          Observe foreign turn
        </Button>
        <Button type="button" onClick={() => resolveLeadCancel()}>
          Resolve lead cancel
        </Button>
        <Button type="button" onClick={() => resolveSessionCancel()}>
          Resolve session cancel
        </Button>
        <Button
          type="button"
          onClick={() =>
            updateSessions((previous) => ({
              ...previous,
              'session-1': {
                ...previous['session-1']!,
                activeHarnessRunId: 'run-2',
              },
            }))
          }
        >
          Replace bound run
        </Button>
        <Button type="button" onClick={() => setRuns([harnessRun('run-2', 'session-1')])}>
          Supply replacement run facts
        </Button>
        <output aria-label="Lead cancel calls">{leadCancelCalls()}</output>
        <output aria-label="Session cancel calls">{sessionCancelCalls()}</output>
        <output aria-label="Cancelled run ids">{cancelledRunIds().join(',')}</output>
        <output aria-label="Active draft">{active().draft}</output>
        <output aria-label="Active generation">{active().generation}</output>
        <output aria-label="Lead turn state">{leadTurn()?.state ?? 'none'}</output>
      </div>
      <ChatView
        conversation={active()}
        model={model}
        autoAttach={false}
        connected={connected()}
        handoff={{ harnessRuns: runs(), leadTurn: leadTurn(), leadAgent: LEAD_AGENT }}
        onLeadStop={cancelLeadTurn}
      />
    </main>
  )
}

render(() => <Harness />, document.querySelector('#harness-root')!)
