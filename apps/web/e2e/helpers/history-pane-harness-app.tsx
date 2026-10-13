import '../../src/start/globals.css'
import type { HarnessRun, RuntimeEvent, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'

// The History pane is mounted by the utility host behind a live runtime. The
// harness mounts the pure pane directly over one session whose title repeats
// across every match, so accessible names have to carry the kind and preview.
import { HistoryPane } from '../../../../packages/dev-view/src/history/history-pane'

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

function Harness() {
  const [jumps, setJumps] = createSignal<string[]>([])
  return (
    <>
      <div class="h-96">
        <HistoryPane
          status={params.get('status') === 'loading' ? 'loading' : 'ready'}
          events={[...base, ...filler]}
          session={session}
          runs={[run]}
          bounded={params.get('bounded') === '1'}
          nowMs={() => Date.parse('2026-09-22T10:20:00.000Z')}
          onJump={(jump) => setJumps((current) => [...current, jump.eventId ?? 'run'])}
        />
      </div>
      <p data-testid="jumps">{jumps().join(',')}</p>
    </>
  )
}

render(() => <Harness />, document.getElementById('harness-root')!)
