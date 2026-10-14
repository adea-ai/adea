import '../../src/start/globals.css'
import type { HarnessRun, RuntimeEvent, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'

// The History pane is mounted by the utility host behind a live runtime. The
// harness mounts the pure pane directly over one session whose title repeats
// across every match, so accessible names have to carry the kind and preview.
import {
  HistoryPane,
  type HistoryScope,
} from '../../../../packages/dev-view/src/history/history-pane'
import { ResumeRefusedError } from '../../../../packages/dev-view/src/history/all-sessions-model'
import type { AllSessionsScan } from '../../../../packages/dev-view/src/history/all-sessions-scan'

const scope: Scope = {
  accountId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  runtimeNodeId: '33333333-3333-4333-8333-333333333333',
}

const session: RuntimeSession = {
  id: 'session-1',
  scope,
  projectId: 'project-1',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  displayName: 'Deploy planning',
  lifecycle: 'active',
  archived: false,
  projection: 'structured',
  generation: 2,
  version: 3,
}

const run: HarnessRun = {
  id: 'run-2',
  scope,
  runtimeSessionId: session.id,
  installationId: 'installation-1',
  agentProfile: { id: 'profile-1', version: 1, displayName: 'Agent', capabilityPolicyVersion: 1 },
  state: 'completed',
  generation: 2,
  startedAt: '2026-09-22T10:00:00.000Z',
  finishedAt: '2026-09-22T10:01:00.000Z',
  version: 2,
}

function event(seq: number, overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${seq}`,
    runtimeSessionId: session.id,
    generation: 2,
    seq: String(seq),
    occurredAt: '2026-09-22T10:00:10.000Z',
    receivedAt: '2026-09-22T10:00:10.000Z',
    source: 'host',
    sourceEventId: `source-${seq}`,
    confidence: 'authoritative',
    classification: 'workspace_metadata',
    kind: 'turn.user_input',
    payload: {},
    ...overrides,
  }
}

const params = new URLSearchParams(location.search)
const count = Number(params.get('turns') ?? '0')

const base: RuntimeEvent[] = [
  event(1, { payload: { text: 'deploy the staging build' } }),
  event(2, { kind: 'tool.requested', payload: { name: 'bash' } }),
  event(3, {
    kind: 'approval.requested',
    payload: { title: 'Deploy to production' },
  }),
  event(4, {
    kind: 'turn.result',
    payload: { summary: 'Staging is live; production awaits your approval.' },
  }),
  event(5, { kind: 'turn.user_input', payload: { text: 'write the release notes' } }),
]

// `?turns=N` appends N filler prompts so paging past one search page is
// exercised against the 1,000-event retention window (#716).
const filler = Array.from({ length: count }, (_, index) =>
  event(6 + index, { payload: { text: `filler prompt ${index}` } })
)

// #716 All sessions: three sessions that all mention "terminal", one resumable,
// one cancelled, one still running. `?cap=1` swaps in six sessions with 1,000
// matching events each, so the 1,000-row cap is reached from the real model.
function otherSession(id: string, title: string, overrides: Partial<RuntimeSession> = {}) {
  return { ...session, id, displayName: title, ...overrides } as RuntimeSession
}
function otherEvent(sessionId: string, seq: number, overrides: Partial<RuntimeEvent>) {
  return event(seq, {
    eventId: `${sessionId}-event-${seq}`,
    sourceEventId: `${sessionId}-source-${seq}`,
    runtimeSessionId: sessionId,
    occurredAt: new Date(Date.UTC(2026, 8, 22, 10, 0, seq % 60, 0)).toISOString(),
    ...overrides,
  })
}
function otherRun(sessionId: string, state: HarnessRun['state'], extra: Partial<HarnessRun> = {}) {
  return { ...run, id: `run-${sessionId}`, runtimeSessionId: sessionId, state, ...extra }
}

function buildScan(): AllSessionsScan {
  if (params.get('cap') === '1') {
    const sessions = Array.from({ length: 6 }, (_, index) =>
      otherSession(`bulk-${index}`, `Bulk session ${index}`)
    )
    return {
      sessions,
      runs: [],
      events: new Map(
        sessions.map((bulk) => [
          bulk.id,
          Array.from({ length: 1_000 }, (_, index) =>
            otherEvent(bulk.id, index + 1, { payload: { text: `terminal note ${index}` } })
          ),
        ])
      ),
      searched: 6,
      partial: false,
      scannedAt: 0,
    }
  }
  const shell = otherSession('shell', 'Shell switcher')
  const resize = otherSession('resize', 'Fix terminal resize on Windows')
  const review = otherSession('review', 'Review the terminal search spec')
  return {
    sessions: [shell, resize, review],
    runs: [
      otherRun('shell', 'failed', { generation: 6 }),
      otherRun('resize', 'cancelled'),
      otherRun('review', 'working'),
    ],
    events: new Map([
      [
        'shell',
        [
          otherEvent('shell', 1, { payload: { text: 'add a terminal shell switcher' } }),
          otherEvent('shell', 2, {
            kind: 'turn.result',
            payload: { summary: 'Added a Shell menu to the terminal toolbar' },
          }),
          otherEvent('shell', 3, {
            kind: 'tool.requested',
            payload: { name: 'bun test terminal' },
          }),
        ],
      ],
      [
        'resize',
        [otherEvent('resize', 4, { payload: { text: 'why does the terminal lose its size' } })],
      ],
      ['review', [otherEvent('review', 5, { payload: { text: 'review the search spec' } })]],
    ]),
    searched: 3,
    partial: params.get('partial') === '1',
    scannedAt: 0,
  }
}

function Harness() {
  const [jumps, setJumps] = createSignal<string[]>([])
  const [chosen, setChosen] = createSignal<HistoryScope>(
    params.get('scope') === 'all' ? 'all' : 'session'
  )
  const [attempts, setAttempts] = createSignal(0)
  const scopes = params.has('scopes') || params.has('scope')
  const allStatus = params.get('all') ?? 'ready'
  let refuse = params.get('resumeFails') === '1'
  return (
    <>
      <div class="h-96">
        <HistoryPane
          status={
            params.get('status') === 'loading'
              ? 'loading'
              : params.get('status') === 'stale'
                ? 'stale'
                : 'ready'
          }
          onRetry={() => setJumps((current) => [...current, 'retry'])}
          events={[...base, ...filler]}
          session={session}
          runs={[run]}
          bounded={params.get('bounded') === '1'}
          nowMs={() => Date.parse('2026-09-22T10:20:00.000Z')}
          onGo={(jump) =>
            setJumps((current) => [...current, jump.eventId ?? `session:${jump.runtimeSessionId}`])
          }
          {...(scopes
            ? {
                scope: chosen(),
                onScopeChange: setChosen,
                boundSessionId: session.id,
                all:
                  allStatus === 'ready'
                    ? { status: 'ready' as const, scan: buildScan() }
                    : {
                        status:
                          allStatus === 'loading' ? ('loading' as const) : ('unavailable' as const),
                      },
                onRetryAll: () => setAttempts((tries) => tries + 1),
                onResume: async (target: { harnessRunId: string }) => {
                  if (refuse) {
                    refuse = false
                    throw new ResumeRefusedError('the runtime did not accept the request.')
                  }
                  setJumps((current) => [...current, `resume:${target.harnessRunId}`])
                },
              }
            : {})}
        />
      </div>
      <p data-testid="jumps">{jumps().join(',')}</p>
      <p data-testid="attempts">{attempts()}</p>
    </>
  )
}

render(() => <Harness />, document.getElementById('harness-root')!)
