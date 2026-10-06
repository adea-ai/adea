import '../../src/start/globals.css'
import { AgentHqQueryProvider } from '@adea-ai/data/provider'
import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
import { createSharedDevUtilityOwner } from '@adea-ai/dev-view/utility-owner'
import { workspaceStore } from '@adea-ai/state'
import type { WorkspacePlatformServices } from '@adea-ai/workspace-ui/platform'
import {
  createMemoryHistory,
  createRoute,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/solid-router'
import { createRoot } from 'solid-js'
import { render } from 'solid-js/web'

import { WorkspaceNavigation } from '../../src/components/workspace-navigation'
import type { WorkspaceShellProps } from '../../src/components/workspace-shell'

const calls: Array<{ command: string; sessionId: string | null }> = []
const runtimeCalls: string[] = []
const devCommands: Array<{
  operation: string
  scope: unknown
  body: Record<string, unknown>
  resource?: unknown
}> = []
window.__adeaDesktop = {
  invoke: async (command, args) => {
    calls.push({
      command,
      sessionId: typeof args?.focusedSessionId === 'string' ? args.focusedSessionId : null,
    })
    return null
  },
  listen: async () => () => undefined,
}

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const workspace = {
  id: scope.workspaceId,
  name: 'Contextual sidebar workspace',
  scene: 'home' as const,
  accent: null,
  logo: { kind: 'monogram' as const },
  sortOrder: 0,
  version: 1,
  updatedAt: new Date(0).toISOString(),
}
let archivedSessionAvailable = true
let delayNextArchiveList = false
let waitingForArchiveList = false
let resolveArchiveList: (() => void) | undefined
const runtime = {
  state: () => ({ status: 'ready' as const }),
  preferenceScope: () => scope,
  capabilitySnapshot: async () => ({
    scope,
    granted: [],
    unavailable: [],
    channelGeneration: 0,
    observedAt: new Date().toISOString(),
  }),
  execute: async (command: Parameters<DevRuntimeService['execute']>[0]) => {
    runtimeCalls.push(command.operation)
    devCommands.push({
      operation: command.operation,
      scope: command.scope,
      body: command.body,
      ...(command.resource ? { resource: command.resource } : {}),
    })
    let staleChatArchivePage = false
    if (
      command.operation === 'dev.session.list' &&
      command.body.archived === true &&
      delayNextArchiveList
    ) {
      delayNextArchiveList = false
      staleChatArchivePage = true
      waitingForArchiveList = true
      await new Promise<void>((resolve) => {
        resolveArchiveList = () => {
          waitingForArchiveList = false
          resolveArchiveList = undefined
          resolve()
        }
      })
    }
    const session = {
      id: 'archived-e2e-session',
      scope,
      projectId: 'archived-e2e-project',
      repoId: 'archived-e2e-repo',
      worktreeId: 'archived-e2e-worktree',
      displayName: 'Archived cross-view session',
      archived: true,
      projection: 'structured',
      generation: 7,
      version: 1,
    }
    let value: unknown = {}
    if (command.operation === 'dev.session.list') {
      const listedSession = staleChatArchivePage
        ? {
            ...session,
            id: 'stale-chat-archive-session',
            displayName: 'Stale Chat archive result',
          }
        : session
      value = { items: archivedSessionAvailable ? [listedSession] : [] }
    } else if (command.operation === 'dev.session.get') {
      value = session
    } else if (command.operation === 'dev.session.unarchive') {
      archivedSessionAvailable = false
      value = {
        id: 'archive-e2e-record',
        scope,
        runtimeSessionId: 'archived-e2e-session',
        worktreeId: 'archived-e2e-worktree',
        state: 'restored',
        archivedAt: new Date(0).toISOString(),
        archivedBy: 'e2e',
        generation: 7,
        restoredAt: new Date(0).toISOString(),
      }
    } else if (command.operation === 'dev.device.list') {
      value = {
        items: [
          {
            id: 'scope-device',
            kind: 'ios_simulator',
            name: 'Scope-only simulator',
            platform: 'ios',
            state: 'available',
            generation: 1,
            observedAt: new Date().toISOString(),
          },
        ],
      }
    } else if (command.operation === 'dev.device.capabilities') {
      value = {
        items: [
          { platform: 'ios', state: 'available', observedAt: new Date().toISOString() },
          { platform: 'android', state: 'unavailable', observedAt: new Date().toISOString() },
        ],
        observedAt: new Date().toISOString(),
      }
    }
    return {
      schemaVersion: 1 as const,
      operation: command.operation,
      requestId: command.requestId,
      ok: true as const,
      value,
    } as never
  },
} satisfies Partial<DevRuntimeService> as DevRuntimeService
let disposeUtilityOwner: () => void = () => undefined
const utilityOwner = createRoot((dispose) => {
  disposeUtilityOwner = dispose
  return createSharedDevUtilityOwner(runtime)
})

const client = {
  eventStreamHeaders: () => ({}),
  workspaceEventStreamUrl: () => undefined,
  bootstrapWorkspace: async () => ({
    activeWorkspace: workspace,
    principal: { displayName: 'E2E', temporary: true, userId: 'e2e-user' },
    sessionRotated: false,
    workspaces: [workspace],
  }),
  getWorkspace: async () => ({ workspace, agents: [], tasks: [] }),
  listRooms: async () => [],
  listChannels: async () => [],
  listAgents: async () => [],
  listTasks: async () => [],
  listArtifacts: async () => [],
  getReadState: async () => ({ readState: [] }),
}

const rootRoute = createRootRoute({ component: () => <Outlet /> })
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => {
    return (
      <AgentHqQueryProvider>
        <WorkspaceNavigation
          account={{
            authenticated: false,
            busy: false,
            label: 'Not signed in',
            onSignIn: () => undefined,
            onSignOut: () => undefined,
          }}
          chatEntry={(fallback) => fallback}
          client={client as never}
          platform="desktop"
          services={{ devRuntime: runtime } as WorkspacePlatformServices}
          virtual={false}
          virtualProps={{} as WorkspaceShellProps}
          utilityOwner={utilityOwner}
          workspaces={[]}
        />
      </AgentHqQueryProvider>
    )
  },
})
const routeTree = rootRoute.addChildren([appRoute])
const router = createRouter({
  routeTree,
  history: createMemoryHistory({
    initialEntries: [
      '/?view=dev&devProject=fixture-adea&devSession=fixture-shell&devE2e=preserved',
    ],
  }),
})

workspaceStore.getState().setSelectedDevProjectId('fixture-adea')
workspaceStore.getState().setSelectedRuntimeSessionId('fixture-shell')

const root = document.getElementById('harness-root')
if (!root) throw new Error('workspace navigation harness root missing')
render(() => <RouterProvider router={router} />, root)
window.addEventListener('pagehide', () => {
  utilityOwner.dispose()
  disposeUtilityOwner()
})

window.workspaceNavigationPresentationHarness = {
  report: () => {
    const context = utilityOwner.context()
    return {
      calls: [...calls],
      runtimeCalls: [...runtimeCalls],
      devCommands: [...devCommands],
      pendingArchiveList: waitingForArchiveList,
      utility: {
        view: context.view,
        scope: context.scope,
        projectId: context.projectId,
        runtimeSessionId: context.runtimeSessionId,
        sessionGeneration: context.sessionGeneration,
        revision: context.revision,
      },
    }
  },
  delayNextArchiveList: () => {
    delayNextArchiveList = true
  },
  releaseArchiveList: () => resolveArchiveList?.(),
  showChat: () => router.navigate({ search: { view: 'chat' } as never, replace: true }),
  showVirtual: () => {
    archivedSessionAvailable = true
    return router.navigate({ search: { view: 'virtual' } as never, replace: true })
  },
}

declare global {
  interface Window {
    workspaceNavigationPresentationHarness: {
      report(): {
        calls: Array<{ command: string; sessionId: string | null }>
        runtimeCalls: string[]
        devCommands: Array<{
          operation: string
          scope: unknown
          body: Record<string, unknown>
          resource?: unknown
        }>
        pendingArchiveList: boolean
        utility: {
          view: string
          scope?: { accountId: string; workspaceId: string; runtimeNodeId: string }
          projectId?: string
          runtimeSessionId?: string
          sessionGeneration?: number
          revision: number
        }
      }
      delayNextArchiveList(): void
      releaseArchiveList(): void
      showChat(): Promise<void>
      showVirtual(): Promise<void>
    }
  }
}
