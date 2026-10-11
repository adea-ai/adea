import { AgentHqQueryProvider } from '@adea-ai/data/provider'
import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
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
import { render } from 'solid-js/web'

import { WorkspaceNavigation } from '../../src/components/workspace-navigation'
import type { WorkspaceShellProps } from '../../src/components/workspace-shell'

const calls: Array<{ command: string; sessionId: string | null }> = []
const utilityPreferenceReads: string[] = []
const storageGetItem = Storage.prototype.getItem
Storage.prototype.getItem = function (key: string) {
  if (key.startsWith('adea.dev-layout.v2:')) utilityPreferenceReads.push(key)
  return storageGetItem.call(this, key)
}
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
const runtime = {
  state: () => ({ status: 'unavailable' as const, reason: 'channel_unauthenticated' as const }),
  preferenceScope: () => scope,
  capabilitySnapshot: async () => ({
    scope,
    granted: [],
    unavailable: [],
    channelGeneration: 0,
    observedAt: new Date().toISOString(),
  }),
  execute: async (command: Parameters<DevRuntimeService['execute']>[0]) => ({
    schemaVersion: 1 as const,
    operation: command.operation,
    requestId: command.requestId,
    ok: false as const,
    error: {
      code: 'channel_unauthenticated' as const,
      retryable: false,
      message: 'Harness runtime is unavailable.',
      observedAt: new Date().toISOString(),
    },
  }),
} satisfies Partial<DevRuntimeService> as DevRuntimeService

const client = {
  eventStreamHeaders: () => ({}),
  workspaceEventStreamUrl: () => undefined,
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
          activeWorkspace={{
            id: scope.workspaceId,
            name: 'Utility owner test workspace',
            scene: 'home',
            updatedAt: new Date().toISOString(),
          }}
          chatEntry={(fallback) => fallback}
          client={client as never}
          platform="desktop"
          services={{ devRuntime: runtime } as WorkspacePlatformServices}
          virtual={false}
          virtualProps={{} as WorkspaceShellProps}
          workspaces={[]}
        />
      </AgentHqQueryProvider>
    )
  },
})
const routeTree = rootRoute.addChildren([appRoute])
const requestedView = new URLSearchParams(window.location.search).get('view')
const initialView =
  requestedView === 'chat' || requestedView === 'virtual' || requestedView === 'dev'
    ? requestedView
    : 'dev'
const router = createRouter({
  routeTree,
  history: createMemoryHistory({
    initialEntries: [`/?view=${initialView}&devProject=fixture-adea&devSession=fixture-shell&devE2e=preserved`],
  }),
})

workspaceStore.getState().setSelectedDevProjectId('fixture-adea')
workspaceStore.getState().setSelectedRuntimeSessionId('fixture-shell')

const root = document.getElementById('harness-root')
if (!root) throw new Error('workspace navigation harness root missing')
render(() => <RouterProvider router={router} />, root)

window.workspaceNavigationPresentationHarness = {
  report: () => [...calls],
  utilityPreferenceReadCount: () => utilityPreferenceReads.length,
  showChat: () => router.navigate({ search: { view: 'chat' } as never, replace: true }),
  showView: (view: 'chat' | 'dev' | 'virtual') =>
    router.navigate({ search: { view, devE2e: 'preserved' } as never, replace: true }),
}

declare global {
  interface Window {
    workspaceNavigationPresentationHarness: {
      report(): Array<{ command: string; sessionId: string | null }>
      utilityPreferenceReadCount(): number
      showChat(): Promise<void>
      showView(view: 'chat' | 'dev' | 'virtual'): Promise<void>
    }
  }
}
