import '../../src/start/globals.css'
import type {
  DevCommand,
  DevStreamFrame,
  HarnessRun,
  RuntimeEvent,
  RuntimeSession,
  Scope,
} from '@adea-ai/types/dev-runtime'
import { encodeCbor } from '@adea-ai/types/dev-runtime-wire'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'

// The real SessionHistorySection (not the pure pane) over a fake runtime: the
// scan, the stream replay with its replay-end heartbeat, and the section's own
// focus request and callbacks. "Go to" on a result in another session opens it
// through `onOpenSession`, exactly as the Dev host does.
import type { DevRuntimeService } from '../../../../packages/dev-view/src/platform'
import { SessionHistorySection } from '../../../../packages/dev-view/src/history/session-history-section'
import { createDevUtilityContext } from '../../../../packages/dev-view/src/utility-context'

const scope: Scope = {
  accountId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  runtimeNodeId: '33333333-3333-4333-8333-333333333333',
}

const sessionOf = (id: string, displayName: string): RuntimeSession => ({
  id,
  scope,
  projectId: 'project-1',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  displayName,
  lifecycle: 'active',
  archived: false,
  projection: 'structured',
  generation: 2,
  version: 3,
})
const sessions = [sessionOf('session-a', 'Bound session'), sessionOf('session-b', 'Long session')]

function prompt(sessionId: string, seq: number, text: string): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: `${sessionId}-event-${seq}`,
    runtimeSessionId: sessionId,
    generation: 2,
    seq: String(seq),
    occurredAt: new Date(Date.UTC(2026, 8, 22, 10, 0, seq % 60, 0)).toISOString(),
    receivedAt: '2026-09-22T10:00:10.000Z',
    source: 'host',
    sourceEventId: `${sessionId}-source-${seq}`,
    confidence: 'authoritative',
    classification: 'workspace_metadata',
    kind: 'turn.user_input',
    payload: { text },
  }
}

// The searched prompt is the oldest of many, so showing it takes a real scroll.
const events = new Map<string, RuntimeEvent[]>([
  ['session-a', [prompt('session-a', 1, 'plan the release')]],
  [
    'session-b',
    [
      prompt('session-b', 1, 'find the needle in the haystack'),
      ...Array.from({ length: 40 }, (_, index) =>
        prompt('session-b', index + 2, `filler prompt ${index}`)
      ),
    ],
  ],
])

const ok = (command: DevCommand, value: unknown) =>
  ({
    schemaVersion: 1,
    requestId: command.requestId,
    operation: command.operation,
    ok: true,
    value,
    observedAt: '2026-09-22T10:00:00.000Z',
  }) as never

// Once held, a newly attached stream stays silent: its replay never starts.
let replaysHeld = false
Object.assign(window, { holdReplays: () => (replaysHeld = true) })

const runtime: DevRuntimeService = {
  state: () => ({ status: 'ready' }),
  capabilitySnapshot: async () => {
    throw new Error('not used')
  },
  execute: async (command: DevCommand) => {
    const body = command.body as { runtimeSessionId?: string }
    switch (command.operation) {
      case 'dev.session.list':
        return ok(command, { items: sessions })
      case 'dev.session.get':
        return ok(
          command,
          sessions.find((item) => item.id === body.runtimeSessionId)
        )
      case 'dev.harness.runs':
        return ok(command, { items: [] as HarnessRun[] })
      case 'dev.session.events':
        return ok(command, {
          resource: { generation: 2 },
          fromSequence: '0',
          runtimeSessionId: body.runtimeSessionId,
        })
      default:
        throw new Error(`Unexpected operation: ${command.operation}`)
    }
  },
  streams: () => ({
    connect: (grant, handlers) => {
      const sessionId = (grant as unknown as { runtimeSessionId: string }).runtimeSessionId
      const held = events.get(sessionId) ?? []
      // The replay arrives after the attach returns, then the host's replay-end
      // heartbeat, as `serveRuntimeEvents` sends them.
      if (!replaysHeld)
        setTimeout(() => {
          for (const event of held)
            handlers.onFrame({
              type: 'data',
              sequence: event.seq,
              bytes: encodeCbor(event),
            } as DevStreamFrame)
          handlers.onFrame({
            type: 'heartbeat',
            observedAt: '2026-09-22T10:00:10.000Z',
            throughSequence: held.at(-1)?.seq ?? '0',
          })
        }, 50)
      return { open: true, send: () => undefined, close: () => undefined }
    },
  }),
}

try {
  window.localStorage.setItem('adea.dev.history.scope.v1', 'all')
} catch {
  // Storage may be blocked: the pane then opens on "This session".
}

const [bound, setBound] = createSignal('session-a')
const context = createDevUtilityContext(() => ({
  view: 'dev',
  runtime,
  scope,
  projectId: 'project-1',
  runtimeSessionId: bound(),
  sessionGeneration: 2,
  worktreeId: 'worktree-1',
}))

render(
  () => (
    <div class="h-96">
      <SessionHistorySection
        context={context}
        onOpenSession={(target) => setBound(target.runtimeSessionId)}
      />
    </div>
  ),
  document.getElementById('harness-root')!
)
