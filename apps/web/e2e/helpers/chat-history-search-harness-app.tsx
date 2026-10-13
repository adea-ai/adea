import '../../src/start/globals.css'
import type { HarnessRun, RuntimeEvent, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'

// The conversation history search is not mounted in the shipped shell yet, so
// the harness mounts it directly over one session whose title repeats across
// every match: two events and a resumable run.
import { ChatHistorySearch } from '../../../../packages/dev-view/src/chat/search'

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

function event(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: 'event-1',
    runtimeSessionId: session.id,
    generation: 2,
    seq: '1',
    occurredAt: '2026-09-22T10:00:10.000Z',
    receivedAt: '2026-09-22T10:00:10.000Z',
    source: 'host',
    sourceEventId: 'source-1',
    confidence: 'authoritative',
    classification: 'workspace_metadata',
    kind: 'turn.user_input',
    payload: { text: 'deploy the staging build' },
    ...overrides,
  }
}

const events = new Map<string, readonly RuntimeEvent[]>([
  [
    session.id,
    [
      event({}),
      event({
        eventId: 'approval-1',
        sourceEventId: 'approval-source',
        seq: '2',
        kind: 'approval.requested',
        payload: { title: 'Deploy to production' },
      }),
    ],
  ],
])

function Harness() {
  const [jumps, setJumps] = createSignal<string[]>([])
  return (
    <>
      <ChatHistorySearch
        sessions={[session]}
        runs={[run]}
        events={events}
        onJump={(jump) => setJumps((current) => [...current, jump.eventId ?? 'run'])}
        onResume={() => undefined}
      />
      <p data-testid="jumps">{jumps().join(',')}</p>
    </>
  )
}

render(() => <Harness />, document.getElementById('harness-root')!)
