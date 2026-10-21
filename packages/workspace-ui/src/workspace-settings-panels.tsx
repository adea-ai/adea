import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { WorkspaceSummary, WorkspaceUpdate } from '@adea-ai/types'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Text } from '@adea-ai/ui/components/ui/typography'
import { lazy, Show, Suspense } from 'solid-js'

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
// The Control Plane panes (ADR 0013) load from two entries: the catalog and vault panes (Cloud
// connections) and the host and model panes (Runtime nodes, Lead model). Neither reaches
// Lead chat's code, which has its own entry in `lead-chat.ts`.
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
    memory: `Notes for agents working in ${workspaceName}. Nothing becomes memory until you accept it.`,
    connections: 'Where agents run and how they sign in.',
  }[section]
}

/**
 * The body of one workspace-scoped settings section (identity, Memory
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
  onUpdateWorkspace?: (
    update: WorkspaceUpdate & Readonly<{ expectedVersion: number }>
  ) => Promise<void>
  services?: WorkspacePlatformServices
  workspace: WorkspaceSummary
}) {
  const apiClient = () => props.client ?? props.services?.client
  // Archive needs a client and an owner's non-Home workspace; the server repeats both checks.
  const archiveClient = () =>
    !props.workspace.isPersonal && props.workspace.canArchive ? apiClient() : undefined
  return (
    <>
      <Show when={props.section === 'general'}>
        <WorkspaceIdentitySettings
          workspace={props.workspace}
          {...(props.onUpdateWorkspace ? { onUpdate: props.onUpdateWorkspace } : {})}
        />
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
