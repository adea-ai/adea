import '../../src/start/globals.css'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import type {
  ApiModelConnection,
  ApiModelConnectionCreateInput,
  ApiModelConnectionRevokeInput,
  ApiModelConnectionsResponse,
  ApiModelDefaultsResponse,
  ApiModelDefaultsSetInput,
} from '@adea-ai/api-client/model-connections'
import type { ApiCloudConnectionsResponse } from '@adea-ai/api-client'
import { ThemeProvider } from '@adea-ai/app-ui/components/theme-provider'
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'

import LeadModelPane from '../../../../packages/workspace-ui/src/lead-model-pane'

/**
 * Mounts the real Agent models section (LeadModelPane) over an in-page fake of its model, credential
 * and lead routes. The scenario comes from `window.adeaLeadModelPaneScenario`, set before this module
 * loads. Nothing here is a real endpoint or credential; every request stays in the page.
 */

type Scenario = {
  client: boolean
  holdReads: boolean
  inventory: ApiModelConnectionsResponse
  defaults: ApiModelDefaultsResponse
  credentials: ApiCloudConnectionsResponse
  lead: unknown
}

type Call = { op: string; input: unknown }

type PaneState = {
  inventory: ApiModelConnectionsResponse
  defaults: ApiModelDefaultsResponse
  credentials: ApiCloudConnectionsResponse
  lead: unknown
  calls: Call[]
  failNext: string[]
  listFailing: boolean
  holdReads: boolean
  heldReads: Array<() => void>
}

export type LeadModelPaneHarness = {
  state: PaneState
  releaseReads: () => void
  failNext: (op: string) => void
  setListFailing: (failing: boolean) => void
  setClient: (enabled: boolean) => void
}

const WORKSPACE_ID = '00000000-0000-4000-8000-0000000000aa'

const fallbackScenario: Scenario = {
  client: true,
  holdReads: false,
  inventory: { availability: 'available', canManage: true, target: null, connections: [] },
  defaults: { availability: 'available', canManage: true, defaults: { revision: 0 } },
  credentials: { canManage: true, connections: [] },
  lead: null,
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function createState(scenario: Scenario): PaneState {
  return {
    inventory: clone(scenario.inventory),
    defaults: clone(scenario.defaults),
    credentials: clone(scenario.credentials),
    lead: clone(scenario.lead),
    calls: [],
    failNext: [],
    listFailing: false,
    holdReads: scenario.holdReads,
    heldReads: [],
  }
}

function createFakeClient(state: PaneState): AgentHqApiClient {
  const record = (op: string, input: unknown) => {
    state.calls.push({ op, input: clone(input) })
  }
  const refuseIfArmed = (op: string) => {
    const index = state.failNext.indexOf(op)
    if (index === -1) return
    state.failNext.splice(index, 1)
    throw new Error(`${op} refused by the fixture`)
  }
  const readGate = async () => {
    if (!state.holdReads) return
    await new Promise<void>((resolve) => {
      state.heldReads.push(resolve)
    })
  }
  const api = {
    async listModelConnections(workspaceId: string) {
      record('listModelConnections', { workspaceId })
      await readGate()
      if (state.listFailing) throw new Error('model connections read refused by the fixture')
      return clone(state.inventory)
    },
    async getWorkspaceModelDefaults(workspaceId: string) {
      record('getWorkspaceModelDefaults', { workspaceId })
      await readGate()
      return clone(state.defaults)
    },
    async setWorkspaceModelDefaults(workspaceId: string, input: ApiModelDefaultsSetInput) {
      record('setWorkspaceModelDefaults', { workspaceId, input })
      refuseIfArmed('setWorkspaceModelDefaults')
      const current = state.defaults.defaults ?? { revision: 0 }
      if (input.expectedRevision !== current.revision) throw new Error('defaults revision moved')
      const next = { ...current, revision: current.revision + 1 }
      if (input.lead) next.lead = input.lead
      if (input.child) next.child = input.child
      if (input.direct) next.direct = input.direct
      state.defaults = { ...state.defaults, defaults: next }
      return clone(state.defaults)
    },
    async createModelConnection(workspaceId: string, input: ApiModelConnectionCreateInput) {
      record('createModelConnection', { workspaceId, input })
      refuseIfArmed('createModelConnection')
      const connection: ApiModelConnection = {
        connectionRef: 'conn_fixture_registered',
        revision: 1,
        provider: 'fixture-provider',
        accountRef: 'fixture-account',
        authKind: 'api_key',
        fundingSource: 'byo_api',
        status: 'active',
        models: [
          {
            providerModel: 'fixture-model',
            readiness: { ready: true, reasonCode: 'READY', remedy: null },
          },
        ],
      }
      state.inventory = {
        ...state.inventory,
        connections: [...state.inventory.connections, connection],
      }
      return { connection: clone(connection) }
    },
    async revokeModelConnection(workspaceId: string, input: ApiModelConnectionRevokeInput) {
      record('revokeModelConnection', { workspaceId, input })
      refuseIfArmed('revokeModelConnection')
      let revoked: ApiModelConnection | undefined
      const connections: ApiModelConnection[] = []
      for (const item of state.inventory.connections) {
        if (item.connectionRef === input.connectionRef) {
          revoked = { ...item, status: 'revoked', revision: item.revision + 1 }
          connections.push(revoked)
        } else connections.push(item)
      }
      if (!revoked) throw new Error('unknown model connection')
      state.inventory = { ...state.inventory, connections }
      return { connection: clone(revoked) }
    },
    async listCloudConnections(workspaceId: string) {
      record('listCloudConnections', { workspaceId })
      return clone(state.credentials)
    },
    async getWorkspaceLead(workspaceId: string) {
      record('getWorkspaceLead', { workspaceId })
      return { lead: clone(state.lead) }
    },
    async ensureWorkspaceLead(workspaceId: string) {
      record('ensureWorkspaceLead', { workspaceId })
      return { lead: clone(state.lead) }
    },
  }
  return api as unknown as AgentHqApiClient
}

const initial =
  (window as unknown as { adeaLeadModelPaneScenario?: Scenario }).adeaLeadModelPaneScenario ??
  fallbackScenario
const state = createState(initial)
const client = createFakeClient(state)
const [activeClient, setActiveClient] = createSignal<AgentHqApiClient | undefined>(
  initial.client ? client : undefined
)

;(window as unknown as { leadModelPaneHarness: LeadModelPaneHarness }).leadModelPaneHarness = {
  state,
  releaseReads: () => {
    state.holdReads = false
    for (const release of state.heldReads.splice(0)) release()
  },
  failNext: (op) => {
    state.failNext.push(op)
  },
  setListFailing: (failing) => {
    state.listFailing = failing
  },
  setClient: (enabled) => {
    setActiveClient(enabled ? client : undefined)
  },
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const root = document.getElementById('harness-root')
if (!root) throw new Error('harness root is missing')

render(
  () => (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <LeadModelPane client={activeClient()} workspaceId={WORKSPACE_ID} />
      </QueryClientProvider>
    </ThemeProvider>
  ),
  root
)
