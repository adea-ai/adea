// Browser-side integration harness for the production DevWorkspaceEntry
// terminal selection path. It supplies a deterministic RuntimeService
// projection and authenticated stream boundary; it does not create a PTY.
import { workspaceStore } from '@adea-ai/state'
import {
  DevWorkspaceEntry,
  layoutStorageKeyV2,
  serializeLayoutPreferencesV2,
} from '@adea-ai/dev-view'
import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
import type {
  CapabilitySnapshot,
  DevCommand,
  DevReply,
  DevStreamFrame,
  DevStreamGrant,
  Scope,
  TerminalRecord,
} from '@adea-ai/types/dev-runtime'
import { render } from 'solid-js/web'

const scope: Scope = {
  accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  runtimeNodeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
}
const projectId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const primaryWorktreeId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const otherWorktreeId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const primarySessionId = '11111111-1111-4111-8111-111111111111'
const otherSessionId = '22222222-2222-4222-8222-222222222222'
const primaryTerminalId = '33333333-3333-4333-8333-333333333333'
const otherTerminalId = '44444444-4444-4444-8444-444444444444'
const splitTerminalId = '55555555-5555-4555-8555-555555555555'
const scenario = new URLSearchParams(location.search).get('scenario') ?? 'primary'

type RecordedCommand = Readonly<{
  operation: string
  sessionId?: string
  worktreeId?: string
  terminalId?: string
  generation?: number
  direction?: string
  fromSequence?: string
}>

const state = {
  commands: [] as RecordedCommand[],
  attachments: [] as Array<{
    terminalId: string
    direction: string
    generation: number
    fromSequence: string
  }>,
  primaryListHeld: false,
  releasePrimaryList: undefined as (() => void) | undefined,
  nextGrant: 0,
}

function terminal(id: string, runtimeSessionId: string, generation: number): TerminalRecord {
  const worktreeId = runtimeSessionId === primarySessionId ? primaryWorktreeId : otherWorktreeId
  return {
    id,
    scope,
    runtimeSessionId,
    worktreeId,
    sidecarId: '66666666-6666-4666-8666-666666666666',
    processRecordId: '77777777-7777-4777-8777-777777777777',
    state: 'running',
    health: 'healthy',
    lastSeq: '0',
    generation,
  }
}

const terminals = [
  terminal(primaryTerminalId, primarySessionId, 7),
  terminal(splitTerminalId, primarySessionId, 8),
  terminal(otherTerminalId, otherSessionId, 9),
]

function success(command: DevCommand, value: unknown): DevReply {
  return {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: true,
    value,
    observedAt: new Date().toISOString(),
  } as DevReply
}

function pageForSession(runtimeSessionId: string) {
  return {
    items: terminals.filter((item) => item.runtimeSessionId === runtimeSessionId),
    observedAt: new Date().toISOString(),
  }
}

function makeSnapshot(requestScope: Scope): CapabilitySnapshot {
  const granted = ['dev.session.read', 'dev.terminal.attach', 'dev.terminal.input'] as const
  const denied = scenario === 'deny-input' ? ['dev.terminal.input'] : []
  const withManage = scenario !== 'no-manage'
  return {
    scope: requestScope,
    granted: [
      ...granted.filter((capability) => !denied.includes(capability)),
      ...(withManage ? ['dev.terminal.manage' as const] : []),
    ],
    unavailable: [
      ...denied.map((capability) => ({ capability, reason: 'permission_denied' as const })),
      ...(!withManage
        ? [{ capability: 'dev.terminal.manage' as const, reason: 'permission_denied' as const }]
        : []),
    ],
    channelGeneration: 1,
    observedAt: new Date().toISOString(),
  }
}

function grantFor(command: DevCommand): DevStreamGrant {
  state.nextGrant += 1
  const body = command.body as { direction: 'read' | 'write'; fromSequence?: string }
  return {
    schemaVersion: 1,
    grantId: `00000000-0000-4000-8000-${String(state.nextGrant).padStart(12, '0')}`,
    protocol: 'terminal-bytes-v1',
    channelId: '88888888-8888-4888-8888-888888888888',
    scope: command.scope,
    resource: command.resource!,
    direction: body.direction,
    fromSequence: body.fromSequence ?? '0',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxFrameBytes: 65_536,
  }
}

const runtime: DevRuntimeService = {
  state: () => ({ status: 'ready' }),
  ready: Promise.resolve(),
  preferenceScope: () => scope,
  projection: async () => ({
    observedAt: new Date().toISOString(),
    // The no-session scenario is a project-less runtime: the add-project
    // empty states are exactly what a fresh machine must show.
    groups:
      scenario === 'no-session'
        ? []
        : [
            {
              id: 'group-fixture',
              name: 'Fixture group',
              projects: [
                {
                  id: projectId,
                  name: 'Terminal integration project',
                  repository: 'fixture/repository',
                  branch: 'main',
                  sessions: [
                    {
                      id: primarySessionId,
                      title: 'Primary session',
                      worktreeId: primaryWorktreeId,
                      state: 'active',
                      generation: 5,
                      terminalId: primaryTerminalId,
                    },
                    {
                      id: otherSessionId,
                      title: 'Other session',
                      worktreeId: otherWorktreeId,
                      state: 'active',
                      generation: 6,
                      terminalId: otherTerminalId,
                    },
                  ],
                },
              ],
            },
          ],
  }),
  capabilitySnapshot: async (requestScope) => makeSnapshot(requestScope),
  execute: async (command) => {
    const body = command.body as Record<string, unknown>
    state.commands.push({
      operation: command.operation,
      sessionId: typeof body.runtimeSessionId === 'string' ? body.runtimeSessionId : undefined,
      worktreeId: typeof body.worktreeId === 'string' ? body.worktreeId : undefined,
      terminalId: typeof body.terminalId === 'string' ? body.terminalId : command.resource?.id,
      generation:
        typeof body.expectedGeneration === 'number'
          ? body.expectedGeneration
          : command.resource?.generation,
      direction: typeof body.direction === 'string' ? body.direction : undefined,
      fromSequence: typeof body.fromSequence === 'string' ? body.fromSequence : undefined,
    })

    if (command.operation === 'dev.session.list') return success(command, pageForSession(''))
    if (command.operation === 'dev.terminal.list') {
      const runtimeSessionId = String(body.runtimeSessionId ?? '')
      if (
        scenario === 'retry' &&
        state.commands.filter((item) => item.operation === 'dev.terminal.list').length === 1
      ) {
        return {
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: false,
          error: {
            code: 'unavailable',
            retryable: true,
            message: 'The deterministic runtime is temporarily unavailable.',
          },
        } as DevReply
      }
      if (scenario === 'race' && runtimeSessionId === primarySessionId && !state.primaryListHeld) {
        state.primaryListHeld = true
        return new Promise<DevReply>((resolve) => {
          state.releasePrimaryList = () =>
            resolve(success(command, pageForSession(runtimeSessionId)))
        })
      }
      return success(command, pageForSession(runtimeSessionId))
    }
    if (command.operation === 'dev.terminal.attach' || command.operation === 'dev.terminal.input')
      return success(command, grantFor(command))
    if (command.operation === 'dev.terminal.resize')
      return success(
        command,
        terminals.find((item) => item.id === command.resource?.id)
      )
    return {
      schemaVersion: 1,
      operation: command.operation,
      requestId: command.requestId,
      ok: false,
      error: {
        code: 'unsupported_capability',
        retryable: false,
        message: 'The integration harness has no handler for this operation.',
      },
    } as DevReply
  },
  streams: () => ({
    connect(grant, handlers) {
      state.attachments.push({
        terminalId: grant.resource.id,
        direction: grant.direction,
        generation: grant.resource.generation,
        fromSequence: grant.fromSequence,
      })
      let open = true
      const socket = {
        get open() {
          return open
        },
        bufferedAmount: 0,
        send(_frame: DevStreamFrame) {},
        close() {
          open = false
        },
      }
      queueMicrotask(() => {
        if (!open) return
        handlers.onFrame({
          type: 'opened',
          protocol: grant.protocol,
          generation: grant.resource.generation,
          nextSequence: grant.fromSequence,
        })
        if (grant.direction === 'read') {
          handlers.onFrame({
            type: 'data',
            sequence: grant.fromSequence,
            bytes: new TextEncoder().encode(`selected terminal ${grant.resource.id}`),
          })
        }
      })
      return socket
    },
  }),
}

const storage = new Map<string, string>()
if (scenario === 'explicit') {
  const key = layoutStorageKeyV2(scope, projectId, primarySessionId)
  storage.set(
    key,
    serializeLayoutPreferencesV2({
      schemaVersion: 2,
      scope,
      projectId,
      runtimeSessionId: primarySessionId,
      center: {
        kind: 'split',
        id: 'explicit-split',
        direction: 'row',
        ratio: 0.5,
        children: [
          { kind: 'leaf', id: 'explicit-terminal', pane: 'terminal', resourceId: splitTerminalId },
          { kind: 'leaf', id: 'primary-terminal', pane: 'terminal' },
        ],
      },
      utility: [
        {
          pane: 'files',
          side: 'left',
          order: 0,
          visible: true,
          size: 288,
          lastNonzeroSize: 288,
          fullWidth: false,
        },
        {
          pane: 'source_control',
          side: 'left',
          order: 1,
          visible: false,
          size: 288,
          lastNonzeroSize: 288,
          fullWidth: false,
        },
        {
          pane: 'browser',
          side: 'right',
          order: 2,
          visible: false,
          size: 288,
          lastNonzeroSize: 288,
          fullWidth: false,
        },
        {
          pane: 'devices',
          side: 'right',
          order: 3,
          visible: false,
          size: 288,
          lastNonzeroSize: 288,
          fullWidth: false,
        },
        {
          pane: 'agents',
          side: 'right',
          order: 4,
          visible: false,
          size: 288,
          lastNonzeroSize: 288,
          fullWidth: false,
        },
        {
          pane: 'history',
          side: 'right',
          order: 5,
          visible: false,
          size: 288,
          lastNonzeroSize: 288,
          fullWidth: false,
        },
      ],
      focusMode: false,
      focusTargetId: 'primary-terminal',
    })
  )
}

const harness = {
  report() {
    return {
      commands: state.commands,
      attachments: state.attachments,
      primaryListHeld: state.primaryListHeld,
    }
  },
  async releasePrimaryList() {
    state.releasePrimaryList?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  },
  selectSession(runtimeSessionId: string) {
    workspaceStore.getState().setSelectedRuntimeSessionId(runtimeSessionId)
  },
}

declare global {
  interface Window {
    devWorkspaceRuntimeTerminalHarness: typeof harness
  }
}

function mount() {
  const container = document.getElementById('harness-root')
  if (!container) throw new Error('harness root missing')
  // The no-session scenario leaves the store unseeded so the center panes
  // render their "select a project" empty states, not a bound terminal.
  if (scenario !== 'no-session') workspaceStore.getState().setSelectedDevProjectId(projectId)
  render(
    () => (
      <DevWorkspaceEntry
        runtime={runtime}
        {...(scenario === 'explicit'
          ? {
              storage: {
                getItem: (key: string) => storage.get(key) ?? null,
                setItem: (key: string, value: string) => storage.set(key, value),
                removeItem: (key: string) => storage.delete(key),
              },
            }
          : {})}
      />
    ),
    container
  )
  window.devWorkspaceRuntimeTerminalHarness = harness
}

mount()
