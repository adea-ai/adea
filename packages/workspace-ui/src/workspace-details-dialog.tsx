import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { WorkspaceSummary, WorkspaceUpdate } from '@adea-ai/types'
import { WorkspaceIdentityMark } from '@adea-ai/app-ui/components/workspace-identity-mark'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { SettingsNavigation } from '@adea-ai/ui/components/composites/settings'
import { ModalDialog } from '@adea-ai/ui/components/ui/modal-dialog'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@adea-ai/ui/components/ui/alert-dialog'
import { Tabs, TabsContent } from '@adea-ai/ui/components/ui/tabs'
import { Brain, LockKeyhole, Settings2, Sparkles } from 'lucide-solid'
import { createEffect, createSignal, lazy, on, Show, Suspense, type Accessor } from 'solid-js'

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
  let deleteOpener: HTMLButtonElement | undefined
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [confirmationName, setConfirmationName] = createSignal('')
  const [deleting, setDeleting] = createSignal(false)
  const [deleteError, setDeleteError] = createSignal('')
  const resetDeletion = () => {
    setConfirmDelete(false)
    setConfirmationName('')
    setDeleteError('')
  }
  createEffect(on(() => [props.workspace.id, props.workspace.version, props.open], resetDeletion))
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
      setOrderError(
        'Workspace order could not be saved. Refresh your workspace list and try again.'
      )
    } finally {
      setMoving(false)
    }
  }
  const deleteConfirmed = async () => {
    if (
      props.workspace.isPersonal ||
      !props.workspace.canDelete ||
      deleting() ||
      confirmationName() !== props.workspace.name ||
      !props.onDeleteWorkspace
    )
      return
    setDeleting(true)
    setDeleteError('')
    try {
      await props.onDeleteWorkspace({
        confirmationName: confirmationName(),
        expectedVersion: props.workspace.version,
      })
      setDeleting(false)
      resetDeletion()
      close()
    } catch (error) {
      setDeleteError(
        error instanceof Error &&
          ['WorkspaceCleanupRefusal', 'WorkspaceCleanupPending'].includes(error.name)
          ? error.message
          : error instanceof Error &&
              'code' in error &&
              error.code === 'workspace_deletion_cleanup_required'
            ? error.message
            : 'Workspace could not be deleted. Check its current name and try again.'
      )
    } finally {
      setDeleting(false)
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
    if (deleting()) return
    resetDeletion()
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
        <TabsContent value="general" id="workspace-settings-panel-general" class="min-h-0 min-w-0">
          <div class="conventional-settings-panel">
            <header>
              <Settings2 aria-hidden="true" />
              <div>
                <h3>{workspaceSettingsSectionLabels.general}</h3>
                <p>How this workspace looks and where it opens.</p>
              </div>
            </header>
            <WorkspaceIdentitySettings
              workspace={props.workspace}
              {...(props.onUpdateWorkspace ? { onUpdate: props.onUpdateWorkspace } : {})}
            />
            <Show when={props.onReorderWorkspaces && workspacePosition() >= 0}>
              <SettingsRow
                label="Workspace order"
                description="Move this workspace in your own workspace list."
              >
                <div class="flex flex-col gap-2">
                  <p role="status">
                    Position {workspacePosition() + 1} of {props.workspaceOrder?.length ?? 0}
                  </p>
                  <div class="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={moving() || workspacePosition() <= 0}
                      onClick={() => void moveWorkspace(-1)}
                    >
                      Move up
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        moving() || workspacePosition() >= (props.workspaceOrder?.length ?? 0) - 1
                      }
                      onClick={() => void moveWorkspace(1)}
                    >
                      Move down
                    </Button>
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
                Your personal workspace stays with your account. You can rename it, change its mark
                and settings, and move it in your workspace list.
              </p>
            </Show>
            <Show
              when={
                !props.workspace.isPersonal && props.workspace.canDelete && props.onDeleteWorkspace
              }
            >
              <section class="mt-6 flex flex-col gap-3" aria-label="Delete workspace">
                <h4>Delete workspace</h4>
                <Show when={props.workspace.deletionPending}>
                  <p role="status">
                    Deletion is pending. This workspace stays visible until cleanup finishes. Retry
                    deletion to continue.
                  </p>
                </Show>
                <p>
                  Permanent deletion is currently unavailable until Adea can verify cleanup
                  completion. Your workspace and its data will be kept.
                </p>
                <Button
                  ref={(element) => {
                    deleteOpener = element
                  }}
                  variant="destructive"
                  onClick={() => {
                    resetDeletion()
                    setConfirmDelete(true)
                  }}
                >
                  Delete workspace
                </Button>
              </section>
            </Show>
          </div>
        </TabsContent>
        <TabsContent value="memory" id="workspace-settings-panel-memory" class="min-h-0 min-w-0">
          <div class="conventional-settings-panel">
            <header>
              <Brain aria-hidden="true" />
              <div>
                <h3>{workspaceSettingsSectionLabels.memory}</h3>
                <p>
                  Notes for agents working in {props.workspace.name}. Agents can propose notes; they
                  become memory only when you accept them.
                </p>
              </div>
            </header>
            <Show when={section() === 'memory'}>
              <MemoryPane service={props.services?.memory} workspaceId={props.workspace.id} />
            </Show>
          </div>
        </TabsContent>
        <TabsContent value="skills" id="workspace-settings-panel-skills" class="min-h-0 min-w-0">
          <div class="conventional-settings-panel">
            <header>
              <Sparkles aria-hidden="true" />
              <div>
                <h3>{workspaceSettingsSectionLabels.skills}</h3>
                <p>
                  Skills and agent profiles {props.workspace.name} uses for cloud runs, from the
                  Control Plane catalog.
                </p>
              </div>
            </header>
            <Show when={section() === 'skills'}>
              <SkillsPane client={apiClient()} workspaceId={props.workspace.id} />
            </Show>
          </div>
        </TabsContent>
        <TabsContent
          value="connections"
          id="workspace-settings-panel-connections"
          class="min-h-0 min-w-0"
        >
          <div class="conventional-settings-panel">
            <header>
              <LockKeyhole aria-hidden="true" />
              <div>
                <h3>{workspaceSettingsSectionLabels.connections}</h3>
                <p>
                  Devices and self-hosted runtimes registered to this workspace, git hosting and
                  harness accounts on this device, and connector credentials for cloud agents.
                  Device secrets stay in the device vault.
                </p>
              </div>
            </header>
            <Show when={props.open && section() === 'connections'}>
              <Suspense fallback={<p role="status">Loading device connections…</p>}>
                <ConnectionsPane service={props.services?.connections} />
              </Suspense>
              <Suspense fallback={<p role="status">Loading execution hosts…</p>}>
                <RuntimeNodesPane client={apiClient()} workspaceId={props.workspace.id} />
              </Suspense>
              <Suspense fallback={<p role="status">Loading cloud connections…</p>}>
                <CloudConnectionsPane client={apiClient()} workspaceId={props.workspace.id} />
              </Suspense>
            </Show>
          </div>
        </TabsContent>
      </Tabs>
      <AlertDialog
        open={confirmDelete()}
        onOpenChange={(open) => {
          if (!deleting()) {
            if (open) setConfirmDelete(true)
            else resetDeletion()
          }
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            if (props.open && deleteOpener?.isConnected) {
              event.preventDefault()
              deleteOpener.focus()
            }
          }}
        >
          <AlertDialogTitle>Delete {props.workspace.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Permanent deletion is unavailable until Adea can verify cleanup. Your workspace and its
            data will be kept. Once supported, deletion will be permanent and cannot be undone.
          </AlertDialogDescription>
          <Label for="workspace-delete-confirmation">Type {props.workspace.name} to confirm</Label>
          <Input
            id="workspace-delete-confirmation"
            value={confirmationName()}
            disabled={deleting()}
            onInput={(event) => setConfirmationName(event.currentTarget.value)}
          />
          <Show when={deleteError()}>
            <Alert variant="destructive">
              <AlertDescription>{deleteError()}</AlertDescription>
            </Alert>
          </Show>
          <div class="flex justify-end gap-2">
            <Button variant="outline" disabled={deleting()} onClick={resetDeletion}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting() || confirmationName() !== props.workspace.name}
              aria-busy={deleting()}
              onClick={() => void deleteConfirmed()}
            >
              {deleting() ? 'Deleting…' : 'Permanently delete workspace'}
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </ModalDialog>
  )
}
