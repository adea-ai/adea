import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { WorkspaceSummary, WorkspaceUpdate } from '@adea-ai/types'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Text } from '@adea-ai/ui/components/ui/typography'
import { createSignal, For, lazy, Show, Suspense } from 'solid-js'

import type { WorkspacePlatformServices } from './platform'
import type { WorkspaceSettingsSection } from './workspace-settings-section'
import { WorkspaceIdentitySettings } from './workspace-identity-settings'
import { WorkspaceArchiveSettings } from './workspace-archive-settings'
import { WorkspaceArchivedProjectsSettings } from './workspace-archived-projects-settings'
import { WorkspaceArchivedSettings } from './workspace-archived-settings'
import { WorkspaceExportSettings, WorkspaceRestoreSettings } from './workspace-portable-settings'

// The panes load when their section opens, never with the dialog chrome — the
// same lazy boundaries the app Settings dialog used for them.
const MemoryPane = lazy(() => import('./memory-pane'))
const ConnectionsPane = lazy(() =>
  import('./connections-pane').then((module) => ({ default: module.ConnectionsPane }))
)
// The Control Plane panes (ADR 0013) load from two entries: the catalog and vault panes (Skills,
// Cloud connections) and the host and model panes (Runtime nodes, Lead model). Neither reaches
// Lead chat's code, which has its own entry in `lead-chat.ts`.
const SkillsPane = lazy(() =>
  import('./control-plane-catalog').then((module) => ({ default: module.SkillsPane }))
)
const CloudConnectionsPane = lazy(() =>
  import('./control-plane-catalog').then((module) => ({ default: module.CloudConnectionsPane }))
)
const RuntimeNodesPane = lazy(() =>
  import('./control-plane-hosts').then((module) => ({ default: module.RuntimeNodesPane }))
)
const SelfHostedConnectionsSection = lazy(() =>
  import('./control-plane-hosts').then((module) => ({
    default: module.SelfHostedConnectionsSection,
  }))
)
const LeadModelPane = lazy(() =>
  import('./control-plane-hosts').then((module) => ({ default: module.LeadModelPane }))
)

/** What each workspace-scoped settings section says about itself. */
export function workspaceSectionDescription(
  section: WorkspaceSettingsSection,
  workspaceName: string
): string {
  return {
    general: 'How this workspace looks and where it opens.',
    memory: `Notes for agents working in ${workspaceName}. Agents can propose notes; they become memory only when you accept them.`,
    skills: `Skills and agent profiles ${workspaceName} uses for cloud runs, from the Control Plane catalog.`,
    connections:
      'Devices and self-hosted runtimes registered to this workspace, git hosting and harness accounts on this device, and connector credentials for cloud agents. Device secrets stay in the device vault.',
  }[section]
}

/**
 * The body of one workspace-scoped settings section (identity, Memory, Skills
 * or Connections) for one workspace. The app Settings dialog mounts it under
 * its Workspaces group; each pane saves against the workspace it is given and
 * the host decides which workspace that is.
 */
export function WorkspaceSettingsSectionBody(props: {
  accountPrincipalId?: () => string | null | undefined
  client?: AgentHqApiClient
  section: WorkspaceSettingsSection
  /** True while the dialog is open, so device panes mount only when visible. */
  open: boolean
  onOpenWorkspace?: (workspaceId: string) => Promise<boolean>
  onReorderWorkspaces?: (workspaceIds: readonly string[]) => Promise<void>
  onUpdateWorkspace?: (
    update: WorkspaceUpdate & Readonly<{ expectedVersion: number }>
  ) => Promise<void>
  services?: WorkspacePlatformServices
  workspace: WorkspaceSummary
  workspaceOrder?: readonly WorkspaceSummary[]
}) {
  const apiClient = () => props.client ?? props.services?.client
  // Archive needs a client and an owner's non-Home workspace; the server repeats both checks.
  const archiveClient = () =>
    !props.workspace.isPersonal && props.workspace.canArchive ? apiClient() : undefined
  const [moving, setMoving] = createSignal(false)
  const [orderError, setOrderError] = createSignal('')
  // Home always leads the sidebar, so it is the fixed first slot of this order.
  const orderedWorkspaces = () => {
    const order = props.workspaceOrder ?? []
    return [
      ...order.filter(({ isPersonal }) => isPersonal),
      ...order.filter(({ isPersonal }) => !isPersonal),
    ]
  }
  const firstMovableIndex = () => orderedWorkspaces().filter(({ isPersonal }) => isPersonal).length
  const workspacePosition = () =>
    orderedWorkspaces().findIndex((workspace) => workspace.id === props.workspace.id)
  const canMove = (direction: -1 | 1) => {
    const next = workspacePosition() + direction
    return (
      !props.workspace.isPersonal &&
      next >= firstMovableIndex() &&
      next < orderedWorkspaces().length
    )
  }
  const moveWorkspace = async (direction: -1 | 1) => {
    if (moving() || !props.onReorderWorkspaces || !canMove(direction)) return
    const ids = orderedWorkspaces().map((workspace) => workspace.id)
    const position = workspacePosition()
    const next = position + direction
    ;[ids[position], ids[next]] = [ids[next]!, ids[position]!]
    setMoving(true)
    setOrderError('')
    try {
      await props.onReorderWorkspaces(ids)
    } catch {
      setOrderError('Workspace order could not be saved. Try again.')
    } finally {
      setMoving(false)
    }
  }
  return (
    <>
      <Show when={props.section === 'general'}>
        <WorkspaceIdentitySettings
          workspace={props.workspace}
          {...(props.onUpdateWorkspace ? { onUpdate: props.onUpdateWorkspace } : {})}
        />
        <Show when={props.onReorderWorkspaces && workspacePosition() >= 0}>
          <SettingsRow label="Workspace order">
            <div class="flex flex-col gap-2">
              <p role="status" aria-label="Workspace order position">
                Position {workspacePosition() + 1} of {orderedWorkspaces().length}
              </p>
              <Show when={props.workspace.isPersonal}>
                <Text variant="caption" tone="muted">
                  Home always stays first. Your other workspaces can be reordered below it.
                </Text>
              </Show>
              <div class="flex items-center gap-2">
                <For each={[-1, 1] as const}>
                  {(direction) => (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={moving() || !canMove(direction)}
                      onClick={() => void moveWorkspace(direction)}
                    >
                      Move {direction === -1 ? 'up' : 'down'}
                    </Button>
                  )}
                </For>
              </div>
              <Show when={orderError()}>
                <Alert variant="destructive">
                  <AlertDescription>{orderError()}</AlertDescription>
                </Alert>
              </Show>
            </div>
          </SettingsRow>
        </Show>
        <Show when={props.workspace.isPersonal}>
          <Text variant="caption" tone="muted" class="mt-4">
            Home can’t be archived or deleted. It stays with your account.
          </Text>
        </Show>
        <Show when={apiClient()}>
          {(client) => (
            <>
              <WorkspaceExportSettings client={client()} workspace={props.workspace} />
              <WorkspaceRestoreSettings
                client={client()}
                {...(props.onOpenWorkspace ? { onOpenWorkspace: props.onOpenWorkspace } : {})}
              />
            </>
          )}
        </Show>
        <Show when={!props.workspace.isPersonal && props.workspace.canDelete}>
          <SettingsRow
            label="Delete workspace"
            description={`${props.workspace.deletionPending ? 'Deletion is pending. ' : ''}Permanent deletion is currently unavailable until cleanup is verified. Your workspace and its data will be kept.`}
          >
            <Button variant="destructive" disabled>
              Delete workspace
            </Button>
          </SettingsRow>
        </Show>
        <Show when={archiveClient()}>
          {(client) => <WorkspaceArchiveSettings client={client()} workspace={props.workspace} />}
        </Show>
        <Show when={apiClient()}>
          {(client) => <WorkspaceArchivedSettings client={client()} />}
        </Show>
        <Show when={apiClient()}>
          {(client) => (
            <WorkspaceArchivedProjectsSettings client={client()} workspace={props.workspace} />
          )}
        </Show>
      </Show>
      <Show when={props.section === 'memory'}>
        <MemoryPane service={props.services?.memory} workspaceId={props.workspace.id} />
      </Show>
      <Show when={props.section === 'skills'}>
        <SkillsPane client={apiClient()} workspaceId={props.workspace.id} />
      </Show>
      <Show when={props.open && props.section === 'connections'}>
        <Suspense fallback={<p role="status">Loading device connections…</p>}>
          <ConnectionsPane service={props.services?.connections} />
        </Suspense>
        <Suspense fallback={<p role="status">Loading execution hosts…</p>}>
          <RuntimeNodesPane
            client={apiClient()}
            nativeSessionInventoryDiagnostics={props.services?.nativeSessionInventoryDiagnostics}
            workspaceId={props.workspace.id}
          />
        </Suspense>
        <Suspense fallback={<p role="status">Loading self-hosted hosts…</p>}>
          <SelfHostedConnectionsSection
            accountId={props.accountPrincipalId}
            client={apiClient()}
            workspaceId={props.workspace.id}
          />
        </Suspense>
        <Suspense fallback={<p role="status">Loading agent models…</p>}>
          <LeadModelPane client={apiClient()} workspaceId={props.workspace.id} />
        </Suspense>
        <Suspense fallback={<p role="status">Loading cloud connections…</p>}>
          <CloudConnectionsPane client={apiClient()} workspaceId={props.workspace.id} />
        </Suspense>
      </Show>
    </>
  )
}
