import type { AgentHqApiClient, ApiRuntimeConnection, ApiRuntimeNode } from '@adea-ai/api-client'
import { settledData } from '@adea-ai/data'
import { useRuntimeNodesQuery, useRuntimeNodeConnectionsQuery } from '@adea-ai/data/runtime-nodes'
import { SettingsRow, SettingsSection } from '@adea-ai/ui/components/composites/settings'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import {
  connectionFreshness,
  conservativeNodeProof,
  nodeProofState,
  runtimeInspectionState,
  runtimeInventoryLoadNotice,
  runtimeStateLabel,
  type NodeProof,
} from './runtime-inventory-model'

const DESCRIPTION = 'Registered devices and self-hosted runtimes for this workspace.'

export default function RuntimeNodesPane(props: {
  client?: AgentHqApiClient
  workspaceId: string
}) {
  const scope = createMemo(() =>
    props.client ? { client: props.client, workspaceId: props.workspaceId } : undefined
  )
  return (
    <div class="workspace-runtime-inventory">
      <Show
        when={scope()}
        keyed
        fallback={
          <SettingsSection title="Execution hosts" description={DESCRIPTION}>
            <EmptyDescription role="status">
              Execution hosts are unavailable in this view.
            </EmptyDescription>
          </SettingsSection>
        }
      >
        {(current) => <RuntimeNodesContent {...current} />}
      </Show>
    </div>
  )
}

function RuntimeNodesContent(props: { client: AgentHqApiClient; workspaceId: string }) {
  const nodes = useRuntimeNodesQuery(props.client, () => props.workspaceId)
  const [selectedId, setSelectedId] = createSignal<string>()
  const [now, setNow] = createSignal(Date.now())
  // Age the displayed observations without issuing background discovery calls.
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })
  const inventory = () => (nodes.isFetching ? undefined : settledData(nodes))
  const selectedNode = () => inventory()?.nodes.find((node) => node.id === selectedId())
  return (
    <>
      <SettingsSection title="Execution hosts" description={DESCRIPTION} bodyLayout="content">
        <div class="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={nodes.isFetching}
            onClick={() => {
              setNow(Date.now())
              void nodes.refetch()
            }}
          >
            Refresh hosts
          </Button>
        </div>
        <Show when={nodes.isFetching}>
          <EmptyDescription role="status">Loading execution hosts…</EmptyDescription>
        </Show>
        <Show when={nodes.isError}>
          <EmptyDescription role="status">
            {runtimeInventoryLoadNotice(nodes.error)}
          </EmptyDescription>
        </Show>
        <Show when={inventory()}>
          {(page) => (
            <>
              <Show when={page().nodes.length === 0}>
                <EmptyDescription role="status">
                  No execution hosts are registered in this workspace.
                </EmptyDescription>
              </Show>
              <For each={page().nodes}>
                {(node) => (
                  <SettingsRow
                    label={node.displayName}
                    description={`${node.kind === 'local_device' ? 'Local device' : 'Self-hosted host'} · ${node.platform} · ${node.softwareVersion}`}
                  >
                    <div class="flex flex-wrap items-center gap-2">
                      <Badge variant={node.pairingState === 'revoked' ? 'destructive' : 'outline'}>
                        {node.pairingState === 'revoked' ? 'Revoked' : 'Paired'}
                      </Badge>
                      <Badge variant="secondary">{nodeProofState(node, now())}</Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`View runtimes on ${node.displayName}`}
                        aria-pressed={selectedId() === node.id}
                        onClick={() => setSelectedId(node.id)}
                      >
                        View runtimes
                      </Button>
                    </div>
                  </SettingsRow>
                )}
              </For>
            </>
          )}
        </Show>
      </SettingsSection>
      <Show when={selectedNode()} keyed>
        {(node) => (
          <RuntimeConnectionsContent
            client={props.client}
            workspaceId={props.workspaceId}
            node={node}
            now={now}
          />
        )}
      </Show>
    </>
  )
}

function RuntimeConnectionsContent(props: {
  client: AgentHqApiClient
  workspaceId: string
  node: ApiRuntimeNode
  now: () => number
}) {
  const [cursor, setCursor] = createSignal<string>()
  const [previous, setPrevious] = createSignal<(string | undefined)[]>([])
  const connections = useRuntimeNodeConnectionsQuery(
    props.client,
    () => props.workspaceId,
    () => props.node.id,
    cursor
  )
  const received = () => (connections.isFetching ? undefined : settledData(connections))
  const page = () => {
    const result = received()
    return result?.node.id === props.node.id &&
      result.node.controlPlaneRuntimeNodeRefId === props.node.controlPlaneRuntimeNodeRefId
      ? result
      : undefined
  }
  const next = () => {
    const nextCursor = page()?.nextCursor
    if (!nextCursor) return
    setPrevious([...previous(), cursor()])
    setCursor(nextCursor)
  }
  const back = () => {
    const history = previous()
    setCursor(history.at(-1))
    setPrevious(history.slice(0, -1))
  }
  return (
    <>
      <SettingsSection
        title={`Runtimes on ${props.node.displayName}`}
        description="Inspect host health, runtime connections, and access requirements. Availability is checked again when you start work."
        bodyLayout="content"
      >
        <div class="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={connections.isFetching}
            onClick={() => void connections.refetch()}
          >
            Refresh runtimes
          </Button>
        </div>
        <Show when={connections.isFetching}>
          <EmptyDescription role="status">Loading runtimes…</EmptyDescription>
        </Show>
        <Show when={connections.isError}>
          <EmptyDescription role="status">
            {runtimeInventoryLoadNotice(connections.error)}
          </EmptyDescription>
        </Show>
        <Show when={received() && !page()}>
          <EmptyDescription role="status">
            The host identity changed. Refresh hosts before inspecting runtimes.
          </EmptyDescription>
        </Show>
        <Show when={page()}>
          {(result) => (
            <>
              <Show when={result().discovery.state === 'unavailable'}>
                <EmptyDescription role="status">
                  The Control Plane is unavailable for this host. Registration is retained; refresh
                  to try again.
                </EmptyDescription>
              </Show>
              <Show
                when={result().discovery.state === 'available' && result().connections.length === 0}
              >
                <EmptyDescription role="status">
                  No runtimes were reported for this host.
                </EmptyDescription>
              </Show>
            </>
          )}
        </Show>
        <Show when={previous().length > 0 || page()?.nextCursor}>
          <div class="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={previous().length === 0 || connections.isFetching}
              onClick={back}
            >
              Previous runtimes
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                !page()?.nextCursor ||
                connections.isFetching ||
                page()?.discovery.state !== 'available'
              }
              onClick={next}
            >
              Next runtimes
            </Button>
          </div>
        </Show>
      </SettingsSection>
      <Show when={page()}>
        {(result) => (
          <For each={result().connections}>
            {(connection) => (
              <RuntimeConnectionDetails
                connection={connection}
                node={conservativeNodeProof(props.node, result().node, props.now())}
                now={props.now}
              />
            )}
          </For>
        )}
      </Show>
    </>
  )
}

function RuntimeConnectionDetails(props: {
  connection: ApiRuntimeConnection
  node: NodeProof
  now: () => number
}) {
  const connection = () => props.connection
  const freshness = createMemo(() => connectionFreshness(connection(), props.now()))
  const detail = () => [
    ['Runtime availability', connection().status],
    ['Control Plane node', `${connection().node.status} · health ${connection().node.health}`],
    [
      'Connection',
      `${connection().connection.status} · health ${connection().connection.health} · ${connection().connection.availability}`,
    ],
    ['Inventory freshness', freshness()],
    ['Compatibility', runtimeStateLabel(connection().compatibility.state)],
    [
      'Compatibility limitations',
      connection().compatibility.limitations.join(' · ') || 'None reported',
    ],
    [
      'Reported eligibility',
      `${connection().eligibility.state}${connection().eligibility.reasons.length ? ` · ${connection().eligibility.reasons.map(runtimeStateLabel).join(' · ')}` : ''}`,
    ],
    [
      'Remediation',
      connection().eligibility.remediation.map(runtimeStateLabel).join(' · ') || 'None reported',
    ],
    [
      'Degradations',
      connection().eligibility.degradations.map(runtimeStateLabel).join(' · ') || 'None reported',
    ],
    [
      'Project access',
      `${connection().access.localProjectGrant.required ? 'Grant required' : 'No grant required'} · ${runtimeStateLabel(connection().access.localProjectGrant.state)}`,
    ],
    ['Entitlement', connection().access.entitlement.state],
    [
      'Versions',
      `Adapter ${connection().versions.adapter} · driver ${connection().versions.driver} · harness ${connection().versions.harness}${connection().versions.protocol ? ` · protocol ${connection().versions.protocol}` : ''}`,
    ],
    ['Capabilities', connection().capabilities.join(' · ') || 'None reported'],
    [
      'Capability support',
      connection()
        .capabilityDetails.map(
          (item) =>
            `${item.name}: ${item.support}${item.limitations?.length ? ` · ${item.limitations.join(' · ')}` : ''}`
        )
        .join(' · ') || 'None reported',
    ],
    ['Transport', 'Not reported by discovery; the actual execution reports its transport.'],
    ['Limitations', connection().limitations.join(' · ') || 'None reported'],
  ]
  return (
    <SettingsSection
      title={connection().runtimeDefinitionId}
      description={`${connection().family} · ${runtimeStateLabel(connection().connectionType)} · ${connection().id}`}
    >
      <SettingsRow label="Current assessment" orientation="vertical">
        <Badge variant="outline">
          {runtimeInspectionState(connection(), props.node, props.now())}
        </Badge>
      </SettingsRow>
      <For each={detail()}>
        {([label, description]) => <SettingsRow label={label!} description={description!} />}
      </For>
      <Show when={connection().eligibility.state !== 'eligible'}>
        <EmptyDescription role="status">
          This runtime reports restrictions. Review host compatibility, project grants, entitlement,
          and required capabilities before submitting work.
        </EmptyDescription>
      </Show>
      <Show when={freshness() !== 'fresh'}>
        <EmptyDescription role="status">
          Refresh the runtime inventory before relying on these observations.
        </EmptyDescription>
      </Show>
    </SettingsSection>
  )
}
