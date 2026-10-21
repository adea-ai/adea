// Query wiring for the self-hosted connection panel (#188), without the code behind the operations. The panel is controlled; this reads the
// existing registration and discovery APIs through the typed client and hands the panel only
// observations. It owns no effect: operations the backend or client do not expose yet are simply
// not passed, and the panel shows them as unavailable.
import type {
  AgentHqApiClient,
  ApiRuntimeNode,
  ApiRuntimeNodeConnectionsResponse,
} from '@adea-ai/api-client'
import { settledData } from '@adea-ai/data'
import { useRuntimeNodeConnectionsQuery, useRuntimeNodesQuery } from '@adea-ai/data/runtime-nodes'
import { SettingsSection } from '@adea-ai/ui/components/composites/settings'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'

import type { DiscoveryRead } from './self-hosted-connection-model'
import {
  SelfHostedConnectionPanel,
  type HostsRead,
  type PanelSlots,
  type SelfHostedOperations,
} from './self-hosted-connection-panel'

export type SelfHostedConnectionPaneCoreProps = Readonly<{
  client?: AgentHqApiClient
  workspaceId: string
  /** The signed-in account. A change of account or workspace resets everything held here. */
  accountId: string
  operations?: SelfHostedOperations
  chosenHostId?: string
  onChooseHost?: (hostId: string | undefined) => void
  requiredCapabilities?: readonly string[]
  /** The code behind the operations; without it the pane is read-only and says why. */
  slots?: PanelSlots
}>

export default function SelfHostedConnectionPaneCore(props: SelfHostedConnectionPaneCoreProps) {
  const scope = createMemo(() =>
    props.client
      ? { client: props.client, workspaceId: props.workspaceId, accountId: props.accountId }
      : undefined
  )
  return (
    <Show
      when={scope()}
      keyed
      fallback={
        <SettingsSection
          title="Self-hosted hosts"
          help="Servers you control that run work for this workspace."
        >
          <EmptyDescription role="status">
            Self-hosted hosts are unavailable in this view.
          </EmptyDescription>
        </SettingsSection>
      }
    >
      {(current) => (
        <Content
          {...current}
          chosenHostId={props.chosenHostId}
          onChooseHost={props.onChooseHost}
          operations={props.operations ?? {}}
          requiredCapabilities={props.requiredCapabilities}
          slots={props.slots}
        />
      )}
    </Show>
  )
}

function Content(
  props: Readonly<{
    accountId: string
    client: AgentHqApiClient
    workspaceId: string
    operations: SelfHostedOperations
    chosenHostId: string | undefined
    onChooseHost: ((hostId: string | undefined) => void) | undefined
    requiredCapabilities: readonly string[] | undefined
    slots: PanelSlots | undefined
  }>
) {
  const nodes = useRuntimeNodesQuery(props.client, () => props.workspaceId)
  const [inspectedId, setInspectedId] = createSignal<string>()
  const [now, setNow] = createSignal(Date.now())
  // Last settled report per host, so switching between hosts does not discard what was read. Its
  // age still shows: freshness is judged from the report's own timestamps.
  const [reports, setReports] = createSignal<
    Readonly<Record<string, ApiRuntimeNodeConnectionsResponse>>
  >({})
  // Age the displayed observations without issuing background calls.
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })
  const connections = useRuntimeNodeConnectionsQuery(
    props.client,
    () => props.workspaceId,
    inspectedId,
    () => undefined
  )

  // What was read stays on screen only while the reader is still authorized for it, and it is
  // mirrored here only from settled results: a query's `data` is backed by a resource, so a read
  // before it settles would suspend the workspace and a read after a failure would throw.
  // - A refusal (401, 403, 404) latches. The list, every cached report and the open host are
  //   dropped and stay dropped, through any retry or later transient error, until a read succeeds
  //   again.
  // - A reset of the query (an audience change erases resident data before it refetches) returns
  //   it to pending, which drops the same things.
  // - A transient failure (network, 5xx) with no refusal keeps what was read, labelled as possibly
  //   out of date.
  const [lastNodes, setLastNodes] = createSignal<readonly ApiRuntimeNode[]>()
  const [listRefusal, setListRefusal] = createSignal<{ status?: number }>()
  const [discoveryRefused, setDiscoveryRefused] = createSignal(false)
  createEffect(() => {
    if (refused(nodes)) {
      setListRefusal(statusOf(nodes.error))
      setLastNodes(undefined)
      setReports({})
      setInspectedId(undefined)
    } else if (nodes.isPending) {
      setLastNodes(undefined)
      setReports({})
      setInspectedId(undefined)
    } else if (nodes.isSuccess && !nodes.isFetching) {
      const data = settledData(nodes)
      if (data) {
        setLastNodes(data.nodes)
        setListRefusal(undefined)
      }
    }
  })
  createEffect(() => {
    if (refused(connections)) {
      setDiscoveryRefused(true)
      setReports({})
    } else if (connections.isSuccess && !connections.isFetching) {
      const id = inspectedId()
      const received = settledData(connections)
      if (id && received?.node.id === id) {
        setDiscoveryRefused(false)
        setReports((current) => ({ ...current, [id]: received }))
      }
    }
  })

  const hosts = (): HostsRead => {
    const refusal = listRefusal()
    if (refusal) {
      if (nodes.isFetching) return { state: 'loading' }
      return failedRead(nodes.isError ? nodes.error : undefined, refusal.status)
    }
    const last = lastNodes()
    if (last)
      return {
        state: 'ready',
        nodes: last,
        ...(nodes.isFetching ? { refreshing: true } : {}),
        ...(!nodes.isFetching && nodes.isError ? { refreshFailed: statusOf(nodes.error) } : {}),
      }
    if (nodes.isFetching || nodes.isPending) return { state: 'loading' }
    return failedRead(nodes.error)
  }

  const discoveryFor = (hostId: string): DiscoveryRead => {
    if (hostId === inspectedId()) {
      if (connections.isFetching) return { state: 'loading' }
      if (connections.isError) return { state: 'failed', ...statusOf(connections.error) }
    }
    // The cache only stores what was read. Whether a report is about this host is decided by the
    // model, which requires both the node id and the Control Plane ref to match the list entry
    // and otherwise shows the mismatch and uses none of the report.
    const page = discoveryRefused() ? undefined : reports()[hostId]
    return page ? { state: 'read', page } : { state: 'not_read' }
  }

  return (
    <SelfHostedConnectionPanel
      scope={{ accountId: props.accountId, workspaceId: props.workspaceId }}
      now={now}
      hosts={hosts()}
      discoveryFor={discoveryFor}
      inspectedId={inspectedId()}
      onInspect={(hostId) => {
        setNow(Date.now())
        setInspectedId(hostId)
      }}
      onRefreshHosts={async () => {
        setNow(Date.now())
        const result = await nodes.refetch()
        if (result.error) throw result.error
      }}
      onCheckHost={async (hostId) => {
        setNow(Date.now())
        if (hostId !== inspectedId()) setInspectedId(hostId)
        // Registration and the Control Plane report are separate reads; a check reads both, since
        // either can downgrade the host.
        const [list, report] = await Promise.all([nodes.refetch(), connections.refetch()])
        if (list.error) throw list.error
        if (report.error) throw report.error
      }}
      operations={props.operations}
      chosenHostId={props.chosenHostId}
      onChooseHost={props.onChooseHost}
      requiredCapabilities={props.requiredCapabilities}
      slots={props.slots}
    />
  )
}

function refused(result: { isError: boolean; error: unknown }): boolean {
  return result.isError && isRefusal(statusOf(result.error).status)
}

function isRefusal(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 404
}

function failedRead(error: unknown, fallbackStatus?: number): HostsRead {
  const status = statusOf(error).status ?? fallbackStatus
  return { state: 'failed', ...(status === undefined ? {} : { status }) }
}

function statusOf(error: unknown): { status?: number } {
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined
  return typeof status === 'number' ? { status } : {}
}
