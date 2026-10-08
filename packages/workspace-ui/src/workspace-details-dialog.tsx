import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { WorkspaceSummary, WorkspaceUpdate } from '@adea-ai/types'
import { WorkspaceIdentityMark } from '@adea-ai/app-ui/components/workspace-identity-mark'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { SettingsNavigation } from '@adea-ai/ui/components/composites/settings'
import { ModalDialog } from '@adea-ai/ui/components/ui/modal-dialog'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Tabs, TabsContent } from '@adea-ai/ui/components/ui/tabs'
import { Brain, LockKeyhole, Settings2, Sparkles } from 'lucide-solid'
import { createEffect, createSignal, For, lazy, Show, Suspense, type Accessor } from 'solid-js'
import { Dynamic } from 'solid-js/web'

import type { WorkspacePlatformServices } from './platform'
import {
  workspaceSettingsHash,
  workspaceSettingsHashPrefix,
  workspaceSettingsSectionFromHash,
  workspaceSettingsSectionLabels,
  workspaceSettingsSections,
  type WorkspaceSettingsSection,
} from './workspace-settings-section'
import { WorkspaceIdentitySettings } from './workspace-identity-settings'

const sectionIcons = {
  general: Settings2,
  memory: Brain,
  skills: Sparkles,
  connections: LockKeyhole,
} satisfies Record<WorkspaceSettingsSection, typeof Brain>

// The panes load when their section opens, never with the dialog chrome — the
// same lazy boundaries the app Settings dialog used for them.
const MemoryPane = lazy(() => import('./memory-pane'))
const ConnectionsPane = lazy(() =>
  import('./connections-pane').then((module) => ({ default: module.ConnectionsPane }))
)
// The Control Plane catalog and vault panes (ADR 0013) load only when Skills
// or Connections opens.
const SkillsPane = lazy(() =>
  import('./control-plane-settings').then((module) => ({ default: module.SkillsPane }))
)
const CloudConnectionsPane = lazy(() =>
  import('./control-plane-settings').then((module) => ({ default: module.CloudConnectionsPane }))
)
const RuntimeNodesPane = lazy(() =>
  import('./control-plane-settings').then((module) => ({ default: module.RuntimeNodesPane }))
)

/**
 * One workspace's own settings, opened from the sidebar's workspace gear:
 * its identity (General), Memory, Skills and Connections. App-wide settings
 * stay in the app Settings dialog. Deep-linked as
 * `#workspace-settings/<section>`; the retired `#settings/workspace|memory|
 * skills|connections` links open the matching section here.
 */
export function WorkspaceDetailsDialog(props: {
  /**
   * The Adea API client for Control Plane-backed sections (Skills, cloud
   * connections). Falls back to `services.client`; without either those
   * sections render their unavailable state.
   */
  client?: AgentHqApiClient
  onClose: () => void
  onDeleteWorkspace?: (
    confirmation: Readonly<{ confirmationName: string; expectedVersion: number }>
  ) => Promise<void>
  /** Saves a versioned workspace identity change; omitted renders read-only. */
  onUpdateWorkspace?: (
    update: WorkspaceUpdate & Readonly<{ expectedVersion: number }>
  ) => Promise<void>
  onReorderWorkspaces?: (workspaceIds: readonly string[]) => Promise<void>
  workspaceOrder?: readonly WorkspaceSummary[]
  open: boolean
  /** The control to restore focus to on close; the shared dialog otherwise
   * restores the element focused before it opened. */
  restoreFocusRef?: Accessor<HTMLButtonElement | undefined>
  services?: WorkspacePlatformServices
  workspace: WorkspaceSummary
}) {
  const apiClient = () => props.client ?? props.services?.client
  const [section, setSection] = createSignal<WorkspaceSettingsSection>('general')
  const sectionDescription = () =>
    ({
      general: 'How this workspace looks and where it opens.',
      memory: `Notes for agents working in ${props.workspace.name}. Agents can propose notes; they become memory only when you accept them.`,
      skills: `Skills and agent profiles ${props.workspace.name} uses for cloud runs, from the Control Plane catalog.`,
      connections:
        'Devices and self-hosted runtimes registered to this workspace, git hosting and harness accounts on this device, and connector credentials for cloud agents. Device secrets stay in the device vault.',
    })[section()]
  const [moving, setMoving] = createSignal(false)
  const [orderError, setOrderError] = createSignal('')
  const workspacePosition = () =>
    props.workspaceOrder?.findIndex((workspace) => workspace.id === props.workspace.id) ?? -1
  const moveWorkspace = async (direction: -1 | 1) => {
    if (moving() || !props.onReorderWorkspaces || !props.workspaceOrder) return
    const ids = props.workspaceOrder.map((workspace) => workspace.id)
    const position = workspacePosition()
    const next = position + direction
    if (position < 0 || next < 0 || next >= ids.length) return
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
  createEffect(() => {
    if (!props.open) return
    const requested = workspaceSettingsSectionFromHash(window.location.hash) ?? 'general'
    setSection(requested)
    // A retired `#settings/<section>` link lands on the canonical hash so the
    // app Settings dialog never reads it as its own.
    const canonical = workspaceSettingsHash(requested)
    if (window.location.hash !== canonical) window.history.replaceState(null, '', canonical)
  })

  const selectSection = (next: WorkspaceSettingsSection) => {
    setSection(next)
    // Only write the deep link when it changes: re-writing the current hash
    // re-resolves the route (#601, see the app Settings dialog).
    const nextHash = workspaceSettingsHash(next)
    if (window.location.hash !== nextHash) window.history.replaceState(null, '', nextHash)
  }
  const close = () => {
    if (window.location.hash.startsWith(workspaceSettingsHashPrefix))
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    props.onClose()
  }

  return (
    <ModalDialog
      modal={false}
      size="settings"
      open={props.open}
      onClose={close}
      restoreFocusRef={props.restoreFocusRef}
      headerLeading={
        <span aria-hidden="true" class="workspace-details-dialog__mark">
          <WorkspaceIdentityMark
            accent={props.workspace.accent}
            logo={props.workspace.logo}
            name={props.workspace.name}
            size="lg"
          />
        </span>
      }
      title={`${props.workspace.name} workspace settings`}
    >
      <Tabs
        id="workspace-settings-tabs"
        class="h-full w-full max-md:data-[orientation=vertical]:flex-col"
        orientation="vertical"
        value={section()}
        onChange={(value) => selectSection(value as WorkspaceSettingsSection)}
      >
        <SettingsNavigation
          class="w-52 max-md:w-full max-md:data-[orientation=vertical]:flex-row max-md:overflow-x-auto max-md:overflow-y-hidden max-md:*:w-max max-md:*:max-w-full max-md:*:flex-none"
          aria-label="Workspace settings sections"
          value={section()}
          onReselect={(value) => selectSection(value as WorkspaceSettingsSection)}
          groups={[
            {
              label: 'Workspace',
              items: workspaceSettingsSections.map((item) => {
                const Icon = sectionIcons[item]
                return {
                  value: item,
                  label: workspaceSettingsSectionLabels[item],
                  icon: <Icon aria-hidden="true" />,
                }
              }),
            },
          ]}
        />
        <TabsContent
          value={section()}
          id={`workspace-settings-panel-${section()}`}
          class="min-h-0 min-w-0"
        >
          <div class="conventional-settings-panel">
            <header>
              <Dynamic component={sectionIcons[section()]} aria-hidden="true" />
              <div>
                <h3>{workspaceSettingsSectionLabels[section()]}</h3>
                <p>{sectionDescription()}</p>
              </div>
            </header>
            <Show when={section() === 'general'}>
              <WorkspaceIdentitySettings
                workspace={props.workspace}
                {...(props.onUpdateWorkspace ? { onUpdate: props.onUpdateWorkspace } : {})}
              />
              <Show when={props.onReorderWorkspaces && workspacePosition() >= 0}>
                <SettingsRow label="Workspace order">
                  <div class="flex flex-col gap-2">
                    <p role="status" aria-label="Workspace order position">
                      Position {workspacePosition() + 1} of {props.workspaceOrder?.length ?? 0}
                    </p>
                    <div class="flex items-center gap-2">
                      <For each={[-1, 1] as const}>
                        {(direction) => (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              moving() ||
                              workspacePosition() + direction < 0 ||
                              workspacePosition() + direction >= (props.workspaceOrder?.length ?? 0)
                            }
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
                <p class="conventional-settings-note">
                  Your personal workspace stays with your account.
                </p>
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
            </Show>
            <Show when={section() === 'memory'}>
              <MemoryPane service={props.services?.memory} workspaceId={props.workspace.id} />
            </Show>
            <Show when={section() === 'skills'}>
              <SkillsPane client={apiClient()} workspaceId={props.workspace.id} />
            </Show>
            <Show when={props.open && section() === 'connections'}>
              <Suspense
                fallback={
                  <p role="status" aria-label="Workspace order position">
                    Loading device connections…
                  </p>
                }
              >
                <ConnectionsPane service={props.services?.connections} />
              </Suspense>
              <Suspense
                fallback={
                  <p role="status" aria-label="Workspace order position">
                    Loading execution hosts…
                  </p>
                }
              >
                <RuntimeNodesPane client={apiClient()} workspaceId={props.workspace.id} />
              </Suspense>
              <Suspense
                fallback={
                  <p role="status" aria-label="Workspace order position">
                    Loading cloud connections…
                  </p>
                }
              >
                <CloudConnectionsPane client={apiClient()} workspaceId={props.workspace.id} />
              </Suspense>
            </Show>
          </div>
        </TabsContent>
      </Tabs>
    </ModalDialog>
  )
}
