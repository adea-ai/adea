import '../../src/start/globals.css'
import { createRoot, createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { workspaceStore } from '@adea-ai/state'
import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
import type { DevCommand, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import { createSharedDevUtilityOwner } from '@adea-ai/dev-view/utility-owner'
import { SharedUtilityArchiveShelf } from '@adea-ai/dev-view/utility-archive-shelf'
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
const archiveCommands: DevCommand[] = []
const presentations: (string | null)[] = []
const utilityHandoffs: Array<{
  scope: Scope
  projectId: string
  runtimeSessionId: string
  sessionGeneration: number
  worktreeId?: string
} | null> = []
window.__adeaDesktop = {
  invoke: async (command, args) => {
    if (command !== 'desktop_chat_presentation')
      throw new Error(`Unexpected bridge command: ${command}`)
    presentations.push(typeof args?.focusedSessionId === 'string' ? args.focusedSessionId : null)
    return null
  },
  listen: async () => () => undefined,
}
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
let archivedSessionAvailable = true
const archivedSession: RuntimeSession = {
  id: '00000000-0000-4000-8000-000000000009',
  scope,
  projectId,
  repoId: '00000000-0000-4000-8000-000000000007',
  worktreeId: '00000000-0000-4000-8000-000000000008',
  displayName: 'Archived desktop conversation',
  archived: true,
  projection: 'structured',
  generation: 9,
  version: 4,
}
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
    if (
      command.operation === 'dev.session.list' ||
      command.operation === 'dev.session.get' ||
      command.operation === 'dev.session.unarchive'
    )
      archiveCommands.push(command)
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
    let value: unknown = undefined
    if (command.operation === 'dev.session.list') {
      value =
        command.body.archived === true
          ? archivedSessionAvailable
            ? { items: [archivedSession] }
            : { items: [] }
          : { items: sessions }
    } else if (command.operation === 'dev.session.get') {
      value = archivedSession
    } else if (command.operation === 'dev.session.unarchive') {
      archivedSessionAvailable = false
      value = {
        id: '00000000-0000-4000-8000-000000000010',
        scope,
        runtimeSessionId: archivedSession.id,
        worktreeId: archivedSession.worktreeId,
        state: 'restored',
        archivedAt: '2026-10-03T00:00:00.000Z',
        archivedBy: 'e2e',
        generation: archivedSession.generation,
        restoredAt: '2026-10-03T00:00:00.000Z',
      }
    } else if (command.operation === 'dev.project.list') {
      value = {
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
    } else if (command.operation === 'dev.group.list') {
      value = { items: [] }
    } else if (command.operation === 'dev.session.events') {
      value = { resource: { generation: 3 }, fromSequence: '0' }
    }
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
let disposeUtilityOwner: () => void = () => undefined
const utilityOwner = createRoot((dispose) => {
  disposeUtilityOwner = dispose
  const owner = createSharedDevUtilityOwner(runtime)
  owner.setView('chat')
  return owner
})
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
window.addEventListener('pagehide', () => {
  utilityOwner.dispose()
  disposeUtilityOwner()
})
render(
  () => (
    <Show when={mounted()} fallback={<p>Dev surface</p>}>
      <DesktopFirstRunChat
        runtime={runtime}
        modelHost={host}
        utilityOwner={utilityOwner}
        archiveAction={<SharedUtilityArchiveShelf owner={utilityOwner} />}
        client={client}
        fallback={<p>Legacy team chat</p>}
        workspaceId={scope.workspaceId}
        temporary={false}
        onSignIn={() => undefined}
        onOpenDev={() => setMounted(false)}
        onCanonicalConversation={(binding) => {
          utilityHandoffs.push(binding ?? null)
          utilityOwner.handoffCanonicalChatConversation(binding)
        }}
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
  // setDraft drops the write unless the identity's scopeKey matches the host's
  // scopeKey(scope) — the exact value chatDraftScopeKey builds in
  // packages/dev-view/src/chat/draft.ts and the real composer passes.
  saveDraft: (draft: string) =>
    host.setDraft(
      scope,
      {
        runtimeSessionId: firstId,
        generation: 3,
        scopeKey: `${scope.accountId}\u0000${scope.workspaceId}\u0000${scope.runtimeNodeId}`,
      },
      draft
    ),
  report: () => ({
    calls: [...calls],
    archiveCommands: [...archiveCommands],
    presentations: [...presentations],
    utilityHandoffs: [...utilityHandoffs],
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
      report(): {
        calls: string[]
        archiveCommands: DevCommand[]
        presentations: (string | null)[]
        utilityHandoffs: Array<{
          scope: Scope
          projectId: string
          runtimeSessionId: string
          sessionGeneration: number
          worktreeId?: string
        } | null>
        closes: number
        selected: string | null
        draft?: string
      }
    }
  }
}
