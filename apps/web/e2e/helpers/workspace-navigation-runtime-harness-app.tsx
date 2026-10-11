import {
  createMemoryHistory,
  createRoute,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/solid-router'
import type { DevCommand, DevOperation, HarnessRun, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { DevRuntimeService, DevWorkspaceProjection } from '@adea-ai/dev-view/platform'
import { createDesktopChatModelHost } from '../../src/lib/desktop-chat-host'
import { DesktopFirstRunChat } from '../../src/components/desktop-first-run-chat'
import { AgentHqQueryProvider } from '@adea-ai/data/provider'
import { workspaceStore } from '@adea-ai/state'
import type { WorkspacePlatformServices } from '@adea-ai/workspace-ui/platform'
import type { WorkspaceShellProps } from '../../src/components/workspace-shell'
import { WorkspaceNavigation } from '../../src/components/workspace-navigation'
import { render } from 'solid-js/web'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const projectId = 'fixture-adea'
const repoId = '00000000-0000-4000-8000-000000000007'
const worktreeId = '00000000-0000-4000-8000-000000000008'
const sessions: readonly RuntimeSession[] = ([
  { id: 'fixture-shell', displayName: 'First canonical session', lifecycle: 'active' },
  { id: 'fixture-runtime', displayName: 'Second canonical session', lifecycle: 'ready' },
]) as const).map((session) => ({
  id: session.id,
  scope,
  projectId,
  repoId,
  worktreeId,
  displayName: session.displayName,
  lifecycle: session.lifecycle,
  archived: false,
  projection: 'structured',
  generation: 3,
  version: 2,
}))
const projection: DevWorkspaceProjection = {
  observedAt: '2026-10-02T00:00:00.000Z',
  groups: [
    {
      id: 'fixture-group',
      name: 'Runtime group',
      projects: [
        {
          id: projectId,
          name: 'Canonical project',
          repository: 'example/repository',
          branch: 'main',
          sessions: sessions.map((session) => ({
            id: session.id,
            title: session.displayName ?? session.id,
            worktreeId: session.worktreeId,
            state: session.lifecycle,
            generation: session.generation,
          })),
        },
      ],
    },
  ],
}
const project = {
  id: projectId,
  scope,
  name: 'Canonical project',
  groupIds: ['fixture-group'],
  repoIds: [repoId],
  lifecycle: 'ready' as const,
  version: 1,
}
const group = {
  id: 'fixture-group',
  scope,
  name: 'Runtime group',
  projectIds: [projectId],
  sortKey: 'a',
  version: 1,
}
const runtimeCalls: Array<{
  operation: string
  sessionId: string | null
  resourceId: string | null
}> = []
const delayedRequests = new Map<string, number>()
const pendingReleases = new Map<string, Array<() => void>>()
const isReady = () => new URLSearchParams(window.location.search).get('runtime') === 'ready'
const delayedKey = (operation: DevOperation, sessionId: string) => `${operation}:${sessionId}`

function persistPanePreference(runtimeSessionId: string, visibleRightPane: 'browser' | 'agents' | 'history') {
  const utility = [
    ['files', 'left'],
    ['source_control', 'left'],
    ['browser', 'right'],
    ['devices', 'right'],
    ['agents', 'right'],
    ['history', 'right'],
  ] as const
  const document = {
    schemaVersion: 2,
    scope,
    projectId,
    runtimeSessionId,
    center: { kind: 'leaf', id: 'fixture-terminal', pane: 'terminal' },
    utility: utility.map(([pane, side], order) => ({
      pane,
      side,
      order,
      visible: side === 'left' ? pane === 'files' : pane === visibleRightPane,
      size: pane === 'browser' ? 336 : 288,
      lastNonzeroSize: pane === 'browser' ? 336 : 288,
      fullWidth: false,
    })),
    focusMode: false,
    focusTargetId: 'fixture-terminal',
  }
  const key = [
    scope.accountId,
    scope.workspaceId,
    scope.runtimeNodeId,
    projectId,
    runtimeSessionId,
  ]
    .map(encodeURIComponent)
    .join(':')
  window.localStorage.setItem(`adea.dev-layout.v2:${key}`, JSON.stringify(document))
}

persistPanePreference('fixture-shell', 'browser')
persistPanePreference('fixture-runtime', 'browser')

function reply(command: DevCommand, value: unknown) {
  return {
    schemaVersion: 1 as const,
    operation: command.operation,
    requestId: command.requestId,
    ok: true as const,
    value,
    observedAt: '2026-10-02T00:00:00.000Z',
  }
}

function harnessRun(runtimeSessionId: string): HarnessRun {
  const first = runtimeSessionId === 'fixture-shell'
  return {
    id: `run-${runtimeSessionId}`,
    scope,
    runtimeSessionId,
    installationId: 'harness-installation',
    agentProfile: {
      id: 'fixture-agent',
      version: 1,
      displayName: `Agent ${runtimeSessionId}`,
      capabilityPolicyVersion: 1,
    },
    modelId: `model-${runtimeSessionId}`,
    state: first ? 'working' : 'awaiting_input',
    generation: 1,
    startedAt: '2026-10-01T23:59:00.000Z',
    version: 1,
  }
}

const runtime: DevRuntimeService = {
  state: () =>
    isReady()
      ? { status: 'ready' }
      : { status: 'unavailable', reason: 'channel_unauthenticated' },
  preferenceScope: () => scope,
  projection: async () => projection,
  capabilitySnapshot: async (requestedScope) => ({
    scope: requestedScope,
    granted: [],
    unavailable: [],
    channelGeneration: 1,
    observedAt: '2026-10-02T00:00:00.000Z',
  }),
  execute: async (command) => {
    const body = command.body as Record<string, unknown>
    const resourceSessionId =
      command.resource?.kind === 'browser_lane' && command.resource.id.startsWith('lane-')
        ? command.resource.id.slice('lane-'.length)
        : null
    const sessionId =
      typeof body.runtimeSessionId === 'string' ? body.runtimeSessionId : resourceSessionId
    runtimeCalls.push({
      operation: command.operation,
      sessionId,
      resourceId: command.resource?.id ?? null,
    })
    const pendingKey = sessionId ? delayedKey(command.operation, sessionId) : undefined
    const pendingCount = pendingKey ? delayedRequests.get(pendingKey) : undefined
    if (pendingKey && pendingCount !== undefined) {
      if (pendingCount <= 1) delayedRequests.delete(pendingKey)
      else delayedRequests.set(pendingKey, pendingCount - 1)
      await new Promise<void>((resolve) => {
        pendingReleases.set(pendingKey, [...(pendingReleases.get(pendingKey) ?? []), resolve])
      })
    }

    if (command.operation === 'dev.project.list') return reply(command, { items: [project] })
    if (command.operation === 'dev.group.list') return reply(command, { items: [group] })
    if (command.operation === 'dev.session.list') return reply(command, { items: sessions })
    if (command.operation === 'dev.session.get') {
      const found = sessions.find((session) => session.id === sessionId)
      if (!found) throw new Error(`unknown session ${String(sessionId)}`)
      return reply(command, found)
    }
    if (command.operation === 'dev.session.events')
      return reply(command, { resource: { generation: 3 }, fromSequence: '0' })
    if (command.operation === 'dev.browser.lanes') {
      const selected = sessions.find((session) => session.id === sessionId)
      return reply(command, {
        items: selected
          ? [
              {
                id: `lane-${selected.id}`,
                scope,
                runtimeSessionId: selected.id,
                kind: 'task_owned',
                profileId: 'profile-fixture',
                state: 'ready',
                automationOwner: 'none',
                generation: 4,
              },
            ]
          : [],
      })
    }
    if (command.operation === 'dev.browser.targets') {
      const laneId = typeof body.browserLaneId === 'string' ? body.browserLaneId : 'lane-unknown'
      const selectedSession = laneId.startsWith('lane-') ? laneId.slice('lane-'.length) : 'unknown'
      return reply(command, {
        items: [
          {
            id: `target-${selectedSession}`,
            browserLaneId: laneId,
            type: 'page',
            url: `https://example.test/${selectedSession}`,
            title: `Page for ${selectedSession}`,
            generation: 4,
          },
        ],
      })
    }
    if (command.operation === 'dev.browser.diagnostics') {
      const laneId = typeof body.browserLaneId === 'string' ? body.browserLaneId : 'lane-unknown'
      return reply(command, {
        items: [
          {
            id: `diagnostic-${laneId}`,
            level: 'info',
            category: 'console',
            message: `Diagnostics for ${laneId}`,
          },
        ],
      })
    }
    if (command.operation === 'dev.resources.ports') return reply(command, { items: [] })
    if (command.operation === 'dev.harness.runs')
      return reply(command, { items: sessionId ? [harnessRun(sessionId)] : [] })
    if (command.operation === 'dev.harness.preferences') return reply(command, { items: [] })
    if (command.operation === 'dev.harness.managedPiStatus')
      return reply(command, {
        scope,
        driverId: 'fixture-driver',
        driverVersion: '1',
        pinnedVersion: '1',
        state: 'absent',
        observedAt: '2026-10-02T00:00:00.000Z',
        generation: 1,
      })
    if (command.operation === 'dev.browser.profilePolicies') return reply(command, { items: [] })
    return reply(command, undefined)
  },
  streams: () => ({
    connect: (_grant, _handlers) => ({ open: true, send: () => undefined, close: () => undefined }),
  }),
}

window.__adeaDesktop = {
  invoke: async () => null,
  listen: async () => () => undefined,
}

const chatModelHost = createDesktopChatModelHost(runtime)
const client = {
  eventStreamHeaders: () => ({}),
  workspaceEventStreamUrl: () => undefined,
} as unknown as AgentHqApiClient
const rootRoute = createRootRoute({ component: () => <Outlet /> })
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => (
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
          name: 'Runtime session test workspace',
          scene: 'home',
          updatedAt: new Date().toISOString(),
        }}
        chatEntry={(fallback) => (
          <DesktopFirstRunChat
            client={client}
            fallback={fallback}
            onOpenDev={() => undefined}
            onSignIn={() => undefined}
            runtime={runtime}
            modelHost={chatModelHost}
            temporary={false}
            workspaceId={scope.workspaceId}
          />
        )}
        client={client}
        platform="desktop"
        services={{ devRuntime: runtime } as WorkspacePlatformServices}
        virtual={false}
        virtualProps={{} as WorkspaceShellProps}
        workspaces={[]}
      />
    </AgentHqQueryProvider>
  ),
})
const routeTree = rootRoute.addChildren([appRoute])
const initialView = new URLSearchParams(window.location.search).get('view') ?? 'chat'
const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: [`/?view=${initialView}&devE2e=preserved`] }),
})
workspaceStore.getState().setSelectedDevProjectId(projectId)
workspaceStore.getState().setSelectedRuntimeSessionId('fixture-shell')
const root = document.getElementById('harness-root')
if (!root) throw new Error('runtime navigation harness root missing')
render(() => <RouterProvider router={router} />, root)

window.workspaceNavigationRuntimeHarness = {
  delayNext(operation, sessionId, count = 1) {
    delayedRequests.set(delayedKey(operation, sessionId), Math.max(1, count))
  },
  resolveDelayed(operation, sessionId) {
    const key = delayedKey(operation, sessionId)
    const releases = pendingReleases.get(key) ?? []
    pendingReleases.delete(key)
    for (const release of releases) release()
  },
  report() {
    return [...runtimeCalls]
  },
  setPanePreference(runtimeSessionId, pane) {
    persistPanePreference(runtimeSessionId, pane)
  },
}

declare global {
  interface Window {
    workspaceNavigationRuntimeHarness: {
      delayNext(operation: DevOperation, sessionId: string, count?: number): void
      resolveDelayed(operation: DevOperation, sessionId: string): void
      report(): Array<{ operation: string; sessionId: string | null; resourceId: string | null }>
      setPanePreference(
        runtimeSessionId: string,
        pane: 'browser' | 'agents' | 'history'
      ): void
    }
  }
}
