import { createComponent, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'
import RuntimeNodesPane from '../../../packages/workspace-ui/src/runtime-nodes-pane'
import {
  createDesktopDevRuntimeService,
  createDesktopNativeSessionInventoryDiagnosticService,
} from '../src/lib/desktop-dev-runtime'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const cloudNodeId = '00000000-0000-4000-8000-000000000099'
const commands: DevCommand[] = []
const [workspaceId, setWorkspaceId] = createSignal(scope.workspaceId)
const registered = new URLSearchParams(location.search).get('registered') === 'true'
const bridge = {
  async invoke(operation: string) {
    if (operation !== 'desktop_identity_scope') throw new Error('unexpected shell operation')
    return scope
  },
  async devExecute(command: DevCommand): Promise<DevReply> {
    commands.push(command)
    if (command.operation !== 'dev.session.list') throw new Error('inventory must stay read-only')
    return {
      schemaVersion: 1,
      operation: command.operation,
      requestId: command.requestId,
      ok: true,
      observedAt: '2026-10-15T00:00:00.000Z',
      value: {
        items: [
          {
            id: '00000000-0000-4000-8000-000000000040',
            scope,
            archived: false,
            generation: 1,
            lifecycle: 'ready',
            version: 1,
            projectId: '00000000-0000-4000-8000-000000000020',
            worktreeId: '00000000-0000-4000-8000-000000000050',
            repoId: '00000000-0000-4000-8000-000000000030',
            projection: 'structured',
          },
        ],
        observedAt: '2026-10-15T00:00:00.000Z',
      },
    } as DevReply
  },
  listen: async () => () => {},
}
Object.assign(window, {
  __adeaDesktop: bridge,
  nativeSessionCallerTest: { commands, scope, cloudNodeId, setWorkspaceId },
})
const runtime = createDesktopDevRuntimeService({ expectedWorkspaceId: scope.workspaceId })
await runtime.ready
const createDiagnostics = () =>
  createDesktopNativeSessionInventoryDiagnosticService(runtime, {
    authorizationContext: () => 'fixture-desktop-session',
  })
const [diagnostics, setDiagnostics] = createSignal(createDiagnostics())
Object.assign((window as unknown as { nativeSessionCallerTest: object }).nativeSessionCallerTest, {
  replaceProvider: () => setDiagnostics(createDiagnostics()),
})
const node = {
  id: cloudNodeId,
  displayName: 'Registered desktop',
  kind: 'local_device',
  platform: 'macos',
  softwareVersion: 'test',
  pairingState: 'paired',
  controlPlaneRuntimeNodeRefId: '00000000-0000-4000-8000-000000000098',
  health: 'unknown',
  lastProofAt: null,
}
const client = {
  listRuntimeNodes: async () => ({ nodes: registered ? [node] : [] }),
  listRuntimeNodeConnections: async () => ({
    node,
    discovery: { state: 'unavailable', code: 'CONTROL_PLANE_UNAVAILABLE' },
    connections: [],
    observedAt: '2026-10-15T00:00:00.000Z',
  }),
} as unknown as AgentHqApiClient
const queryClient = new QueryClient()
render(
  () =>
    createComponent(QueryClientProvider, {
      client: queryClient,
      get children() {
        return createComponent(RuntimeNodesPane, {
          client,
          get workspaceId() {
            return workspaceId()
          },
          get nativeSessionInventoryDiagnostics() {
            return diagnostics()
          },
        })
      },
    }),
  document.querySelector('#root')!
)
