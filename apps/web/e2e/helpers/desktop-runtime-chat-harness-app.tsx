import '../../src/start/globals.css'
import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { workspaceStore } from '@adea-ai/state'
import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
import type { DevCommand, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import { DesktopFirstRunChat } from '../../src/components/desktop-first-run-chat'
import { createDesktopChatModelHost } from '../../src/lib/desktop-chat-host'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const projectId = '00000000-0000-4000-8000-000000000004'
const firstId = '00000000-0000-4000-8000-000000000005'
const secondId = '00000000-0000-4000-8000-000000000006'
const calls: string[] = []
let closes = 0
let delayed = false
let resolveList: (() => void) | undefined
let refuse = false
const sessions: RuntimeSession[] = [firstId, secondId].map((id, index) => ({
  id,
  scope,
  projectId,
  repoId: '00000000-0000-4000-8000-000000000007',
  worktreeId: '00000000-0000-4000-8000-000000000008',
  displayName: index === 0 ? 'First canonical session' : 'Second canonical session',
  lifecycle: 'active',
  archived: false,
  projection: 'structured',
  generation: 3,
  version: 2,
}))
const runtime: DevRuntimeService = {
  state: () => ({ status: 'ready' }),
  preferenceScope: () => scope,
  projection: async () => ({
    groups: [
      {
        id: 'group',
        name: 'Runtime group',
        projects: [
          {
            id: projectId,
            name: 'Canonical project',
            repository: 'Repository',
            branch: 'main',
            sessions: sessions.map((session) => ({
              id: session.id,
              title: session.displayName!,
              worktreeId: session.worktreeId,
              state: session.lifecycle,
              generation: session.generation,
            })),
          },
        ],
      },
    ],
  }),
  capabilitySnapshot: async () => {
    throw new Error('Unexpected capability mutation')
  },
  execute: async (command: DevCommand) => {
    calls.push(command.operation)
    if (command.operation === 'dev.session.list' && delayed) {
      delayed = false
      await new Promise<void>((resolve) => {
        resolveList = resolve
      })
    }
    if (command.operation === 'dev.session.list' && refuse)
      return {
        ok: false,
        error: { code: 'unavailable', message: 'Refused', retryable: true },
      } as never
    const value =
      command.operation === 'dev.project.list'
        ? {
            items: [
              {
                id: projectId,
                scope,
                name: 'Canonical project',
                groupIds: [],
                repoIds: [sessions[0]!.repoId],
                lifecycle: 'ready',
                version: 1,
              },
            ],
          }
        : command.operation === 'dev.group.list'
          ? { items: [] }
          : command.operation === 'dev.session.list'
            ? { items: sessions }
            : command.operation === 'dev.session.events'
              ? { resource: { generation: 3 }, fromSequence: '0' }
              : undefined
    if (!value) throw new Error(`Unexpected operation: ${command.operation}`)
    return {
      schemaVersion: 1,
      requestId: command.requestId,
      operation: command.operation,
      ok: true,
      value,
      observedAt: '2026-09-26T00:00:00Z',
    } as never
  },
  streams: () => ({
    connect: () => ({
      open: true,
      send: () => undefined,
      close: () => {
        closes += 1
      },
    }),
  }),
}
const host = createDesktopChatModelHost(runtime)
const client = {
  getWorkspace: () => {
    throw new Error('Returning Chat must not depend on onboarding authorities')
  },
} as unknown as AgentHqApiClient
const [mounted, setMounted] = createSignal(true)
workspaceStore.getState().setSelectedDevProjectId(projectId)
workspaceStore.getState().setSelectedRuntimeSessionId(firstId)
workspaceStore.getState().setMobileSidebarOpen(true)
const root = document.getElementById('harness-root')!
render(
  () => (
    <Show when={mounted()} fallback={<p>Dev surface</p>}>
      <DesktopFirstRunChat
        runtime={runtime}
        modelHost={host}
        client={client}
        fallback={<p>Legacy team chat</p>}
        workspaceId={scope.workspaceId}
        temporary={false}
        onSignIn={() => undefined}
        onOpenDev={() => setMounted(false)}
      />
    </Show>
  ),
  root
)

window.desktopRuntimeChatHarness = {
  unmount: () => setMounted(false),
  remount: () => setMounted(true),
  delayNextAttach: () => {
    delayed = true
  },
  resolveAttach: () => {
    resolveList?.()
    resolveList = undefined
  },
  refuseAttach: (value: boolean) => {
    refuse = value
  },
  selectFirst: () => workspaceStore.getState().setSelectedRuntimeSessionId(firstId),
  selectSecond: () => workspaceStore.getState().setSelectedRuntimeSessionId(secondId),
  saveDraft: (draft: string) =>
    host.setDraft(scope, { runtimeSessionId: firstId, generation: 3 }, draft),
  report: () => ({
    calls: [...calls],
    closes,
    selected: workspaceStore.getState().selectedRuntimeSessionId,
    draft: host
      .get(scope)
      .project()
      .conversations.find((conversation) => conversation.runtimeSessionId === firstId)?.draft,
  }),
}
declare global {
  interface Window {
    desktopRuntimeChatHarness: {
      unmount(): void
      remount(): void
      delayNextAttach(): void
      resolveAttach(): void
      refuseAttach(value: boolean): void
      selectFirst(): void
      selectSecond(): void
      saveDraft(draft: string): unknown
      report(): { calls: string[]; closes: number; selected: string | null; draft?: string }
    }
  }
}
