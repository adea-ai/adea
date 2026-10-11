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
import { render } from 'solid-js/web'

import { WorkspaceNavigation } from '../../src/components/workspace-navigation'
import type { WorkspaceShellProps } from '../../src/components/workspace-shell'

const calls: Array<{ command: string; sessionId: string | null }> = []
const runtimeCalls: string[] = []
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
    return {
      schemaVersion: 1 as const,
      operation: command.operation,
      requestId: command.requestId,
      ok: true as const,
      value:
        command.operation === 'dev.device.list'
          ? {
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
          : command.operation === 'dev.device.capabilities'
            ? {
                items: [
                  { platform: 'ios', state: 'available', observedAt: new Date().toISOString() },
                  { platform: 'android', state: 'unavailable', observedAt: new Date().toISOString() },
                ],
                observedAt: new Date().toISOString(),
              }
            : {},
    } as never
  },
} satisfies Partial<DevRuntimeService> as DevRuntimeService
const utilityOwner = createSharedDevUtilityOwner(runtime)

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

window.workspaceNavigationPresentationHarness = {
  report: () => {
    const context = utilityOwner.context()
    return {
      calls: [...calls],
      runtimeCalls: [...runtimeCalls],
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
  showChat: () => router.navigate({ search: { view: 'chat' } as never, replace: true }),
  showVirtual: () => router.navigate({ search: { view: 'virtual' } as never, replace: true }),
}

declare global {
  interface Window {
    workspaceNavigationPresentationHarness: {
      report(): {
      calls: Array<{ command: string; sessionId: string | null }>
      runtimeCalls: string[]
        utility: {
          view: string
          scope?: { accountId: string; workspaceId: string; runtimeNodeId: string }
          projectId?: string
          runtimeSessionId?: string
          sessionGeneration?: number
          revision: number
        }
      }
      showChat(): Promise<void>
      showVirtual(): Promise<void>
    }
  }
}
