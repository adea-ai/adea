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
import { resolveHandoffSessionAuthority } from '@adea-ai/dev-view/chat'
import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
import {
  createOrderedScope,
  requestLeadHandoff,
  resolveLeadHandoffSupply,
  type LeadHandoffPort,
} from '../../src/lib/lead-handoff-supply'

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
  handoffTarget?: {
    runtimeSessionId: string
    taskId?: string
    observedGeneration: number
  }
  /** API snapshot shape: the runtime-observed execution session, when any. */
  runtimeSessionId?: string
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
    channels: [
      {
        id: LEAD_CHANNEL_ID,
        kind: 'direct_agent',
        agentId: LEAD_ID,
        lifecycleState: 'active',
      },
    ],
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
  const [deferReads, setDeferReads] = createSignal(false)
  const readQueue: Array<() => void> = []
  // Reads snapshot the backend at call time: releasing the queue out of
  // order replays genuinely stale observations, which is exactly what the
  // epoch must drop.
  const readBackend = <T,>(reader: (state: FixtureBackend) => T): Promise<T> => {
    const snapshot = reader(JSON.parse(JSON.stringify(backend())) as FixtureBackend)
    if (!deferReads()) return Promise.resolve(snapshot)
    return new Promise<T>((resolve) => {
      readQueue.push(() => resolve(snapshot))
    })
  }
  const [runs, setRuns] = createSignal<readonly HarnessRun[]>([])
  const [leadCancelCalls, setLeadCancelCalls] = createSignal(0)
  const [sessionCancelCalls, setSessionCancelCalls] = createSignal(0)
  const [cancelledRunIds, setCancelledRunIds] = createSignal<readonly string[]>([])
  const [supply, setSupply] = createSignal<{
    turn?: HandoffLeadTurn
    agent?: HandoffLeadAgent
    channelId?: string
  }>({})
  const [admissionPosts, setAdmissionPosts] = createSignal<
    readonly {
      channelId: string
      key: string
      body: string
      target: { runtimeSessionId: string; taskId: string; expectedGeneration: number }
    }[]
  >([])
  const pendingAdmissions: Array<{
    resolve: () => void
    reject: (error: Error) => void
  }> = []
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
    getWorkspaceLead: async () =>
      readBackend(() => ({
        lead: {
          id: LEAD_AGENT_ID,
          isWorkspaceLead: true,
          lifecycleState: 'active',
        },
      })),
    listChannels: async () => readBackend((state) => state.channels),
    getChannelLeadTurn: async (_workspaceId, channelId, targetSessionId) =>
      readBackend((state) => {
        const turn = state.turns[channelId] ?? null
        // Canonical target scoping: only the retained turn for the exact
        // requested session is returned.
        if (!turn || turn.handoffTarget?.runtimeSessionId !== targetSessionId)
          return { leadTurn: null }
        return { leadTurn: turn }
      }),
    createMessage: async (_workspaceId, channelId, input) => {
      const body = input as {
        bodyText?: string
        handoffTarget?: {
          runtimeSessionId: string
          taskId: string
          expectedGeneration: number
        }
        idempotencyKey: string
      }
      const target = body.handoffTarget
      if (!target) throw new Error('Lead admission did not return an intent')
      const index = admissionPosts().length + 1
      setAdmissionPosts((posts) => [
        ...posts,
        { channelId, key: body.idempotencyKey, body: body.bodyText ?? '', target },
      ])
      return new Promise((resolve, reject) => {
        pendingAdmissions.push({
          resolve: () =>
            resolve({
              message: { id: `message-${index}` },
              leadTurn: {
                intentId: `intent-${index}`,
                handoffTarget: {
                  runtimeSessionId: target.runtimeSessionId,
                  taskId: target.taskId,
                  observedGeneration: target.expectedGeneration,
                },
              },
            }),
          reject,
        })
      })
    },
    cancelLeadTurn: async (_workspaceId, intentId) => {
      setLeadCancelCalls((count) => count + 1)
      return new Promise((resolve, reject) => {
        pendingLeadCancels.push({ resolve: () => resolve(), reject, intentId })
      })
    },
  }

  // The same epoch ordering production uses: every refresh attempt
  // advances, and only the latest attempt may apply its resolution.
  const supplyScope = createOrderedScope()
  const refreshSupply = async (): Promise<void> => {
    const sessionId = activeId()
    const session = backend().sessions[sessionId]
    if (!session) return
    const epoch = supplyScope.begin()
    const resolution = await resolveLeadHandoffSupply(port, SCOPE.workspaceId, session.taskId, {
      runtimeSessionId: sessionId,
    })
    if (!supplyScope.isCurrent(epoch)) return
    if (activeId() !== sessionId) return
    if (resolution.status !== 'resolved') {
      setSupply(resolution.leadAgent ? { agent: resolution.leadAgent } : {})
      return
    }
    setSupply({
      turn: resolution.leadTurn,
      agent: resolution.leadAgent,
      channelId: resolution.channelId,
    })
  }

  // Mirrors the production request path: stable per-session idempotency
  // key across unknown-outcome retries, admission deferred for busy/error
  // coverage, and the admitted turn recorded as blocked like a real
  // admission receipt.
  // Fixture session authority: the same rules as the desktop host
  // (existence, scope, task binding, liveness, ACTUAL current generation,
  // control permission), over records the fixture buttons can advance
  // behind the view's back. The view's transcript generation is only the
  // claim; the authority record is the ground truth.
  type AuthorityRecord = {
    generation: number
    taskId?: string
    archived: boolean
    lifecycle: string
  }
  const [authoritySessions, setAuthoritySessions] = createSignal<
    Record<string, AuthorityRecord | undefined>
  >({
    'session-1': { generation: 3, taskId: TASK_ID, archived: false, lifecycle: 'active' },
    'session-2': { generation: 2, archived: false, lifecycle: 'active' },
  })
  const [authorityManage, setAuthorityManage] = createSignal(true)
  const harnessRuntime = {
    state: () => ({ status: 'ready' }),
    capabilitySnapshot: async (scope: typeof SCOPE) => ({
      scope,
      granted: authorityManage() ? ['dev.session.manage', 'dev.session.read'] : [],
      unavailable: [],
      channelGeneration: 0,
      observedAt: new Date().toISOString(),
    }),
    execute: async (command: { operation: string; requestId: string; body: unknown }) => {
      if (command.operation !== 'dev.session.get') throw new Error('unexpected operation')
      const sessionId = (command.body as { runtimeSessionId?: string }).runtimeSessionId
      const stored = sessionId ? authoritySessions()[sessionId] : undefined
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
        value: {
          id: sessionId,
          scope: { ...SCOPE },
          projectId: '00000000-0000-4000-8000-000000000005',
          repoId: '00000000-0000-4000-8000-000000000006',
          worktreeId: '00000000-0000-4000-8000-000000000007',
          ...(stored.taskId === undefined ? {} : { taskId: stored.taskId }),
          lifecycle: stored.lifecycle,
          archived: stored.archived,
          projection: 'structured',
          generation: stored.generation,
          version: 4,
        },
        observedAt: new Date().toISOString(),
      }
    },
  } as unknown as DevRuntimeService

  // The REAL production request path: session-authority gate first (actual
  // record, never claimed facts), then admission with the returned triple
  // and receipt verification. Only the transports are deferred fakes.
  const requestHandoff = async (): Promise<void> => {
    const current = supply()
    const activeConversation = active()
    const channelId = current.channelId
    const taskId = activeConversation.taskId
    if (!channelId || !taskId) throw new Error('Handoff request unavailable.')
    const authority = await resolveHandoffSessionAuthority(
      harnessRuntime,
      { ...SCOPE },
      {
        runtimeSessionId: activeConversation.runtimeSessionId,
        taskId,
        observedGeneration: activeConversation.generation,
      }
    )
    await requestLeadHandoff(port, {
      workspaceId: SCOPE.workspaceId,
      channelId,
      runtimeSessionId: authority.runtimeSessionId,
      taskId: authority.taskId,
      expectedGeneration: authority.generation,
    })
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

  // The lead's task-less direct channel carries turns with retained exact
  // targets, mirroring server retention; reads match the active session.
  const observeTurn = (
    state: string,
    targetSessionId = 'session-1',
    observedSessionId: string | undefined = targetSessionId
  ) => {
    updateBackend((previous) => ({
      ...previous,
      channels: [
        {
          id: LEAD_CHANNEL_ID,
          kind: 'direct_agent',
          agentId: LEAD_ID,
          lifecycleState: 'active',
        },
      ],
      turns: {
        ...previous.turns,
        [LEAD_CHANNEL_ID]: {
          intentId: INTENT_ID,
          dispatchId: 'dispatch_11111111111111111111111111111111',
          state,
          handoffTarget: {
            runtimeSessionId: targetSessionId,
            taskId: TASK_ID,
            observedGeneration: 3,
          },
          ...(observedSessionId === undefined ? {} : { runtimeSessionId: observedSessionId }),
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
        <Button type="button" onClick={() => observeTurn('running', 'session-other')}>
          Observe foreign lead turn
        </Button>
        <Button type="button" onClick={() => observeTurn('running', 'session-1', 'session-other')}>
          Observe mismatched binding
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
        <Button
          type="button"
          onClick={() => {
            const pending = pendingAdmissions.shift()
            if (!pending) return
            // The admitted turn starts blocked with the posted exact target,
            // mirroring server retention; the surface re-resolves it.
            const posted = admissionPosts()[admissionPosts().length - 1]
            // The posted channel, not the current selection's: admission
            // commits where it was requested even if the view moved on.
            const channelId = posted?.channelId
            if (channelId && posted) {
              updateBackend((previous) => ({
                ...previous,
                turns: {
                  ...previous.turns,
                  [channelId]: {
                    intentId: 'intent-admitted',
                    state: 'blocked',
                    handoffTarget: {
                      runtimeSessionId: posted.target.runtimeSessionId,
                      taskId: posted.target.taskId,
                      observedGeneration: posted.target.expectedGeneration,
                    },
                  },
                },
              }))
            }
            pending.resolve()
          }}
        >
          Resolve admission
        </Button>
        <Button
          type="button"
          onClick={() => {
            const pending = pendingAdmissions.shift()
            if (!pending) return
            pending.reject(new Error('transport lost'))
          }}
        >
          Reject admission
        </Button>
        <Button
          type="button"
          onClick={() =>
            setAuthoritySessions((records) => ({
              ...records,
              'session-1': { ...records['session-1'], generation: 5 } as never,
            }))
          }
        >
          Advance authority generation
        </Button>
        <Button
          type="button"
          onClick={() => {
            // The session genuinely advances: transcript and authority
            // record move together, stranding the old request's context.
            updateBackend((previous) => ({
              ...previous,
              sessions: {
                ...previous.sessions,
                'session-1': {
                  ...previous.sessions['session-1']!,
                  generation: previous.sessions['session-1']!.generation + 2,
                },
              },
            }))
            setAuthoritySessions((records) => ({
              ...records,
              'session-1': {
                ...records['session-1'],
                generation: (records['session-1']?.generation ?? 3) + 2,
              } as never,
            }))
          }}
        >
          Advance session generation
        </Button>
        <Button
          type="button"
          onClick={() =>
            setAuthoritySessions((records) => ({
              ...records,
              'session-1': { ...records['session-1'], taskId: 'task-other' } as never,
            }))
          }
        >
          Retarget authority task
        </Button>
        <Button type="button" onClick={() => setAuthorityManage((value) => !value)}>
          Toggle session control
        </Button>
        <Button
          type="button"
          onClick={() =>
            setAuthoritySessions((records) => ({ ...records, 'session-1': undefined }))
          }
        >
          Remove authority session
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
        <Button
          type="button"
          onClick={() =>
            setBackend((previous) => {
              const next = {
                ...previous,
                turns: {
                  ...previous.turns,
                  [LEAD_CHANNEL_ID]: {
                    intentId: 'intent-admitted',
                    state: 'running',
                  },
                },
              }
              persistBackend(next)
              return next
            })
          }
        >
          Advance turn silently
        </Button>
        <Button type="button" onClick={() => setDeferReads((value) => !value)}>
          {deferReads() ? 'Stop deferring reads' : 'Defer reads'}
        </Button>
        <Button
          type="button"
          onClick={async () => {
            // Drain to quiescence newest-first: sequential reads re-queue
            // as their predecessors resolve, so one pass cannot suffice.
            for (let wave = 0; wave < 20 && readQueue.length > 0; wave += 1) {
              while (readQueue.length > 0) readQueue.pop()!()
              await new Promise((resolve) => setTimeout(resolve, 0))
            }
          }}
        >
          Release reads LIFO
        </Button>
        <output aria-label="Lead cancel calls">{leadCancelCalls()}</output>
        <output aria-label="Admission posts">{admissionPosts().length}</output>
        <output aria-label="Admission keys">
          {admissionPosts()
            .map((post) => post.key)
            .join(',')}
        </output>
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
        handoff={{
          harnessRuns: runs(),
          leadTurn: supply().turn,
          leadAgent: supply().agent,
          leadChannelId: supply().channelId,
        }}
        onLeadStop={cancelLeadTurn}
        onRequestHandoff={requestHandoff}
        onRefreshLead={() => void refreshSupply()}
      />
    </main>
  )
}

render(() => <Harness />, document.querySelector('#harness-root')!)
