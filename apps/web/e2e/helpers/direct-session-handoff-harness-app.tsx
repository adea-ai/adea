// Mounted harness for direct-session handoff interactions (#1177).
//
// Renders the production ChatView against the REAL lead-handoff resolver
// fed by a scripted port backend (roster, channels, turns, deferred
// cancels): the same composed path production takes, with every read
// observable. Fixture buttons mutate the backend; the harness re-resolves
// per active session, so linkage, ambiguity, out-of-order, replacement,
// and reload behavior are all drivable from Playwright. Backend state
// persists in localStorage so a reload re-reads it like a canonical
// source would; each Playwright test runs in a fresh browser context, so
// fixtures start clean per test. No backend, database, or shared service
// is touched.
import { Button } from '@adea-ai/ui/components/ui/button'
import { createMemo, createSignal, onMount } from 'solid-js'
import { render } from 'solid-js/web'
import {
  ChatView,
  type ChatConversation,
  type HandoffLeadAgent,
  type HandoffLeadTurn,
} from '@adea-ai/dev-view/chat'
import type { HarnessRun } from '@adea-ai/types/dev-runtime'
import { resolveLeadHandoffSupply, type LeadHandoffPort } from '../../src/lib/lead-handoff-supply'

const SCOPE = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const

const LEAD_ID = '00000000-0000-4000-8000-0000000000b2'
const TASK_ID = '00000000-0000-4000-8000-0000000000f1'

function conversation(
  id: string,
  runId: string | undefined,
  generation: number,
  draft: string,
  taskId: string | undefined
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
    ...(taskId === undefined ? {} : { taskId }),
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

type BackendChannel = {
  id: string
  kind: string
  agentId?: string
  taskId?: string
  lifecycleState: string
}

type BackendTurn = {
  intentId: string
  dispatchId?: string
  state: string
}

type FixtureBackend = {
  sessions: Record<string, ChatConversation>
  channels: BackendChannel[]
  turns: Record<string, BackendTurn>
}

const STORAGE_KEY = 'direct-handoff-fixture-v3'

function initialBackend(): FixtureBackend {
  // The durable side of the host-double: a reload must observe the same
  // backend facts, never in-memory UI state.
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as FixtureBackend
      if (parsed && parsed.sessions?.['session-1'] && parsed.sessions?.['session-2']) return parsed
    }
  } catch {
    // Disposable fixture: fall through to the canned state.
  }
  return {
    sessions: {
      'session-1': conversation('session-1', 'run-1', 3, 'unsent coordination note', TASK_ID),
      'session-2': conversation('session-2', 'run-2', 2, '', undefined),
    },
    channels: [],
    turns: {},
  }
}

function persistBackend(backend: FixtureBackend): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(backend))
  } catch {
    // Disposable fixture: persistence is best-effort.
  }
}

const LEAD_AGENT_ID = '00000000-0000-4000-8000-0000000000b2'
const LEAD_CHANNEL_ID = '00000000-0000-4000-8000-0000000000c3'
const INTENT_ID = '00000000-0000-4000-8000-0000000000a1'

type PendingLeadCancel = {
  resolve: () => void
  reject: (error: Error) => void
  intentId: string
}
type PendingSessionCancel = {
  resolve: (value: ChatConversation) => void
  reject: (error: Error) => void
  sessionId: string
}

function Harness() {
  const initial = initialBackend()
  const [backend, setBackend] = createSignal<FixtureBackend>(initial)
  const [activeId, setActiveId] = createSignal('session-1')
  const [connected, setConnected] = createSignal(true)
  const [runs, setRuns] = createSignal<readonly HarnessRun[]>([])
  const [leadCancelCalls, setLeadCancelCalls] = createSignal(0)
  const [sessionCancelCalls, setSessionCancelCalls] = createSignal(0)
  const [cancelledRunIds, setCancelledRunIds] = createSignal<readonly string[]>([])
  const [supply, setSupply] = createSignal<{ turn?: HandoffLeadTurn; agent?: HandoffLeadAgent }>({})
  const pendingLeadCancels: PendingLeadCancel[] = []
  const pendingSessionCancels: PendingSessionCancel[] = []

  const active = createMemo(() => backend().sessions[activeId()]!)

  const updateBackend = (update: (previous: FixtureBackend) => FixtureBackend): void => {
    setBackend((previous) => {
      const next = update(previous)
      persistBackend(next)
      return next
    })
    void refreshSupply()
  }

  const port: LeadHandoffPort = {
    getWorkspaceLead: async () => ({
      lead: {
        id: LEAD_AGENT_ID,
        isWorkspaceLead: true,
        lifecycleState: 'active',
      },
    }),
    listChannels: async () => backend().channels,
    getChannelLeadTurn: async (_workspaceId, channelId) => ({
      leadTurn: backend().turns[channelId] ?? null,
    }),
    cancelLeadTurn: async (_workspaceId, intentId) => {
      setLeadCancelCalls((count) => count + 1)
      return new Promise((resolve, reject) => {
        pendingLeadCancels.push({ resolve: () => resolve(), reject, intentId })
      })
    },
  }

  const refreshSupply = async (): Promise<void> => {
    const sessionId = activeId()
    const session = backend().sessions[sessionId]
    if (!session) return
    const resolution = await resolveLeadHandoffSupply(port, SCOPE.workspaceId, session.taskId)
    if (activeId() !== sessionId) return
    if (resolution.status !== 'resolved') {
      setSupply(resolution.leadAgent ? { agent: resolution.leadAgent } : {})
      return
    }
    setSupply({ turn: resolution.leadTurn, agent: resolution.leadAgent })
  }

  onMount(() => {
    void refreshSupply()
  })

  const cancelLeadTurn = async (): Promise<void> => {
    const current = supply().turn
    if (!current) return
    await port.cancelLeadTurn(SCOPE.workspaceId, current.intentId)
  }

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
      const current = backend().sessions[runtimeSessionId]!
      const runId = harnessRunId ?? current.activeHarnessRunId ?? 'run-missing'
      setCancelledRunIds((ids) => [...ids, runId])
      return new Promise<ChatConversation>((resolve, reject) => {
        pendingSessionCancels.push({ resolve, reject, sessionId: runtimeSessionId })
      })
    },
  }

  const resolveLeadCancel = () => {
    const pending = pendingLeadCancels.shift()
    if (!pending) return
    // The terminal state lands on the turn that owns the intent: find its
    // channel rather than whatever happens to be active.
    const entry = Object.entries(backend().turns).find(
      ([, turn]) => turn.intentId === pending.intentId
    )
    updateBackend(
      (previous) => ({
        ...previous,
        turns: entry
          ? { ...previous.turns, [entry[0]]: { ...entry[1], state: 'cancelled' } }
          : previous.turns,
      }),
      false
    )
    pending.resolve()
    void refreshSupply()
  }

  const resolveSessionCancel = () => {
    const pending = pendingSessionCancels.shift()
    if (!pending) return
    pending.resolve(backend().sessions[pending.sessionId]!)
  }

  const observeTurn = (state: string) => {
    updateBackend((previous) => ({
      ...previous,
      channels: [
        {
          id: LEAD_CHANNEL_ID,
          kind: 'direct_agent',
          agentId: LEAD_ID,
          taskId: TASK_ID,
          lifecycleState: 'active',
        },
      ],
      turns: {
        ...previous.turns,
        [LEAD_CHANNEL_ID]: {
          intentId: INTENT_ID,
          dispatchId: 'dispatch_11111111111111111111111111111111',
          state,
        },
      },
    }))
  }

  return (
    <main>
      <div>
        <Button
          type="button"
          onClick={() => {
            setActiveId('session-1')
            void refreshSupply()
          }}
        >
          Show session 1
        </Button>
        <Button
          type="button"
          onClick={() => {
            setActiveId('session-2')
            void refreshSupply()
          }}
        >
          Show session 2
        </Button>
        <Button type="button" onClick={() => setConnected((value) => !value)}>
          {connected() ? 'Go offline' : 'Go online'}
        </Button>
        <Button type="button" onClick={() => observeTurn('running')}>
          Observe live lead turn
        </Button>
        <Button type="button" onClick={() => observeTurn('completed')}>
          Observe lead turn completed
        </Button>
        <Button
          type="button"
          onClick={() => updateBackend((previous) => ({ ...previous, channels: [], turns: {} }))}
        >
          Clear lead turn
        </Button>
        <Button
          type="button"
          onClick={() =>
            updateBackend((previous) => ({
              ...previous,
              channels: [
                ...previous.channels,
                {
                  id: '00000000-0000-4000-8000-0000000000e5',
                  kind: 'direct_agent',
                  agentId: LEAD_ID,
                  taskId: TASK_ID,
                  lifecycleState: 'active',
                },
              ],
            }))
          }
        >
          Add ambiguous channel
        </Button>
        <Button
          type="button"
          onClick={() =>
            updateBackend((previous) => ({
              ...previous,
              channels: [
                ...previous.channels,
                {
                  id: '00000000-0000-4000-8000-0000000000e6',
                  kind: 'direct_agent',
                  agentId: LEAD_ID,
                  taskId: 'task-other',
                  lifecycleState: 'active',
                },
              ],
              turns: {
                ...previous.turns,
                '00000000-0000-4000-8000-0000000000e6': {
                  intentId: 'other-intent',
                  state: 'running',
                },
              },
            }))
          }
        >
          Observe unrelated channel
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
            updateBackend((previous) => ({
              ...previous,
              sessions: {
                ...previous.sessions,
                'session-1': {
                  ...previous.sessions['session-1']!,
                  activeHarnessRunId: 'run-2',
                },
              },
            }))
          }
        >
          Replace bound run
        </Button>
        <Button type="button" onClick={() => setRuns([harnessRun('run-2', 'session-1')])}>
          Supply replacement run facts
        </Button>
        <Button type="button" onClick={() => void refreshSupply()}>
          Refresh lead resolution
        </Button>
        <output aria-label="Lead cancel calls">{leadCancelCalls()}</output>
        <output aria-label="Session cancel calls">{sessionCancelCalls()}</output>
        <output aria-label="Cancelled run ids">{cancelledRunIds().join(',')}</output>
        <output aria-label="Active draft">{active().draft}</output>
        <output aria-label="Active generation">{active().generation}</output>
        <output aria-label="Lead turn state">{supply().turn?.state ?? 'none'}</output>
      </div>
      <ChatView
        conversation={active()}
        model={model}
        autoAttach={false}
        connected={connected()}
        handoff={{ harnessRuns: runs(), leadTurn: supply().turn, leadAgent: supply().agent }}
        onLeadStop={cancelLeadTurn}
      />
    </main>
  )
}

render(() => <Harness />, document.querySelector('#harness-root')!)
