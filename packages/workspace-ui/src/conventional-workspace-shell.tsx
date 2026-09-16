import { createApiClient } from '@adea-ai/api-client'
import { AlertTriangle, X } from 'lucide-solid'
import { createEffect, createSignal, lazy, on, Show, Suspense } from 'solid-js'
import { settledData, usePrefetchChannelMessages } from '@adea-ai/data'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'

import { AgentRoster } from './agent-roster'
import { ArtifactDetail } from './artifact-detail'
import { ConversationSurface } from './conversation-surface'
import { TaskBoard } from './task-board'
import { useWorkspaceController } from './use-workspace-controller'
import { WorkspaceSidebar } from './workspace-sidebar'
import { WorkspaceError, WorkspaceSkeleton } from './workspace-states'
import type { SearchResult } from './workspace-utility-dialogs'
import type { WorkspacePlatformServices } from './platform'
import type { WorkspaceView } from './workspace-view-toggle'

const CreateGroupDialog = lazy(() =>
  import('./create-workspace-dialogs').then((module) => ({ default: module.CreateGroupDialog }))
)
const CreateRoomDialog = lazy(() =>
  import('./create-workspace-dialogs').then((module) => ({ default: module.CreateRoomDialog }))
)
const ModalDialog = lazy(() =>
  import('./modal-dialog').then((module) => ({ default: module.ModalDialog }))
)
const WorkspaceSearchDialog = lazy(() =>
  import('./workspace-utility-dialogs').then((module) => ({
    default: module.WorkspaceSearchDialog,
  }))
)
const WorkspaceSettingsDialog = lazy(() =>
  import('./workspace-settings').then((module) => ({ default: module.WorkspaceSettingsDialog }))
)

type DialogId =
  | 'conversation-search'
  | 'create-group'
  | 'create-room'
  | 'details'
  | 'search'
  | 'settings'
  | null

export type WorkspaceDeepLink = Readonly<{
  channel?: string
  message?: string
  task?: string
  thread?: string
  workspace?: string
}>

export function ConventionalWorkspaceShell(props: {
  /** Router-backed deep link state. Reactive, so links apply on SPA navigation. */
  deepLink?: () => WorkspaceDeepLink
  manageSettings?: boolean
  /** Called after a deep link applies — the host removes its params. */
  onConsumeDeepLink?: () => void
  onViewChange?: (view: WorkspaceView) => void
  services?: WorkspacePlatformServices
  view?: WorkspaceView
}) {
  const services = () => props.services
  const controller = useWorkspaceController(services()?.client)
  const prefetchChannelMessages = usePrefetchChannelMessages(
    services()?.client ?? createApiClient(),
    () => controller.workspaceId
  )
  const [dialog, setDialog] = createSignal<DialogId>(null)
  const [accountBusy, setAccountBusy] = createSignal(false)
  const [online, setOnline] = createSignal(true)
  const [searchTargetMessageId, setSearchTargetMessageId] = createSignal<string | null>(null)
  const [selectedArtifactId, setSelectedArtifactId] = createSignal<string | null>(null)
  const [sessionNoticeDismissed, setSessionNoticeDismissed] = createSignal(false)
  const activeSurface = useWorkspaceState((state) => state.activeSurface)
  const globalPanel = useWorkspaceState((state) => state.globalPanel)
  const collapsedRoomIds = useWorkspaceState((state) => state.collapsedRoomIds)
  const drafts = useWorkspaceState((state) => state.drafts)
  const mobileSidebarOpen = useWorkspaceState((state) => state.mobileSidebarOpen)
  const selectedAgentId = useWorkspaceState((state) => state.selectedAgentId)
  const selectedChannelId = useWorkspaceState((state) => state.selectedChannelId)
  const selectedTaskId = useWorkspaceState((state) => state.selectedTaskId)
  const threadRootMessageId = useWorkspaceState((state) => state.threadRootMessageId)
  const sessionRotated = () => settledData(controller.bootstrap)?.sessionRotated ?? false
  const sessionIdentity = () => settledData(controller.bootstrap)?.principal.userId
  const principal = () => settledData(controller.bootstrap)?.principal
  const accountAuthenticated = () =>
    services()?.account?.authenticated ?? Boolean(principal() && !principal()?.temporary)
  const accountLabel = () =>
    services()?.account?.label ??
    (accountAuthenticated() ? (principal()?.displayName ?? 'Account') : 'Sign in')

  createEffect(on(sessionIdentity, () => setSessionNoticeDismissed(false), { defer: true }))

  const selectChannel = (channelId: string, roomId?: string) => {
    setSelectedArtifactId(null)
    setSearchTargetMessageId(null)
    controller.selectChannel(channelId, roomId)
    workspaceStore.getState().setActiveSurface('conversation')
    // Selecting a conversation collapses the drawer only on narrow
    // viewports; at wider widths the sidebar stays as the user left it.
    if (window.matchMedia('(max-width: 48rem)').matches)
      workspaceStore.getState().setMobileSidebarOpen(false)
  }

  createEffect(() => {
    const panel = globalPanel()
    if (panel === 'settings' && !(props.manageSettings ?? true)) return
    if (panel !== 'search' && panel !== 'settings') return
    setDialog(panel)
    workspaceStore.getState().setGlobalPanel(null)
  })

  createEffect(() => {
    if (!(props.manageSettings ?? true)) return
    const openDeepLinkedSettings = () => {
      if (window.location.hash.startsWith('#settings')) setDialog('settings')
    }
    openDeepLinkedSettings()
    window.addEventListener('hashchange', openDeepLinkedSettings)
    return () => window.removeEventListener('hashchange', openDeepLinkedSettings)
  })

  createEffect(() => {
    const updateOnlineStatus = () => setOnline(navigator.onLine)
    updateOnlineStatus()
    window.addEventListener('online', updateOnlineStatus)
    window.addEventListener('offline', updateOnlineStatus)
    return () => {
      window.removeEventListener('online', updateOnlineStatus)
      window.removeEventListener('offline', updateOnlineStatus)
    }
  })

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const editableTarget =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      const targetInClosingDialog =
        dialog() === null &&
        event.target instanceof HTMLElement &&
        Boolean(event.target.closest('[role="dialog"]'))
      const editable = editableTarget && !targetInClosingDialog
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setDialog('search')
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'f' &&
        controller.selectedChannel &&
        !editable
      ) {
        event.preventDefault()
        setDialog('conversation-search')
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        void controller.readStateActions.markAllRead()
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'u' &&
        controller.selectedChannel
      ) {
        event.preventDefault()
        void controller.readStateActions.markChannel({
          action: 'unread',
          channelId: controller.selectedChannel.id,
        })
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault()
        document.querySelector<HTMLTextAreaElement>('[id^="composer-"]')?.focus()
      }
      if (event.altKey && !editable && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        const destinations = controller.channels.filter(
          ({ lifecycleState }) => lifecycleState === 'active'
        )
        if (destinations.length) {
          event.preventDefault()
          const current = Math.max(
            destinations.findIndex(({ id }) => id === selectedChannelId()),
            0
          )
          const direction = event.key === 'ArrowDown' ? 1 : -1
          const next = (current + direction + destinations.length) % destinations.length
          selectChannel(destinations[next]!.id, destinations[next]!.roomId)
        }
      }
      if (event.key === 'Escape' && threadRootMessageId())
        workspaceStore.getState().setThreadRootMessageId(null)
      if (event.key === 'Escape' && selectedArtifactId()) setSelectedArtifactId(null)
    }
    // Capture workspace shortcuts before a portalled dialog's focus trap can
    // stop propagation while it restores focus after closing.
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  })

  createEffect(() => {
    document.title = controller.activeWorkspace
      ? `${controller.activeWorkspace.name} | Adea`
      : 'Adea'
  })

  // Deep links are read through the host's accessor when one is provided —
  // reactive to router search, so links apply on SPA navigation, not just at
  // mount. The URL fallback covers hosts without a router.
  const deepLinkQuery = (): WorkspaceDeepLink => {
    if (props.deepLink) return props.deepLink()
    const query = new URLSearchParams(window.location.search)
    return {
      channel: query.get('channel') ?? undefined,
      message: query.get('message') ?? undefined,
      task: query.get('task') ?? undefined,
      thread: query.get('thread') ?? undefined,
      workspace: query.get('workspace') ?? undefined,
    }
  }
  const consumeDeepLink = () => {
    if (props.onConsumeDeepLink) {
      props.onConsumeDeepLink()
      return
    }
    const url = new URL(window.location.href)
    for (const key of ['channel', 'thread', 'message', 'task', 'workspace'])
      url.searchParams.delete(key)
    window.history.replaceState(null, '', url)
  }
  createEffect(() => {
    if (!controller.workspaceId || !controller.channels.length) return
    const query = deepLinkQuery()
    if (query.workspace && query.workspace !== controller.workspaceId) return
    const channelId = query.channel
    const taskId = query.task
    if (channelId && controller.channels.some(({ id }) => id === channelId)) {
      const channel = controller.channels.find(({ id }) => id === channelId)!
      selectChannel(channel.id, channel.roomId)
      workspaceStore.getState().setThreadRootMessageId(query.thread ?? null)
      setSearchTargetMessageId(query.message ?? null)
    } else if (taskId && controller.tasks.some(({ id }) => id === taskId)) {
      workspaceStore.getState().setSelectedTaskId(taskId)
      workspaceStore.getState().setActiveSurface('tasks')
    } else return
    // Consume the deep link: it applies once. Leaving the params in the URL
    // would re-select the stale destination every time the channel list
    // changes and re-runs this effect.
    consumeDeepLink()
  })

  const selectSearchResult = (result: SearchResult) => {
    if (result.kind === 'settings') {
      setDialog('settings')
      return
    }
    if (result.kind === 'action' && result.id === 'mark-all-read') {
      void controller.readStateActions.markAllRead()
      return
    }
    if (result.kind === 'channel') return selectChannel(result.id)
    if (result.kind === 'room') {
      const item = controller.navigation().rooms.find(({ room }) => room.id === result.id)
      if (item?.selectionChannelId) selectChannel(item.selectionChannelId, item.room.id)
      return
    }
    if (result.kind === 'agent') {
      setSelectedArtifactId(null)
      workspaceStore.getState().setSelectedAgentId(result.id)
      workspaceStore.getState().setActiveSurface('agents')
      return
    }
    if (result.kind === 'message' && result.channelId) {
      selectChannel(result.channelId, result.roomId)
      workspaceStore.getState().setThreadRootMessageId(result.threadRootMessageId ?? null)
      setSearchTargetMessageId(result.messageId ?? result.id)
      return
    }
    if (result.kind === 'artifact') {
      setSelectedArtifactId(result.id)
      return
    }
    workspaceStore.getState().setSelectedTaskId(result.id)
    setSelectedArtifactId(null)
    workspaceStore.getState().setActiveSurface('tasks')
  }

  const signOut = async () => {
    setAccountBusy(true)
    try {
      await services()?.account?.onSignOut()
    } finally {
      setAccountBusy(false)
    }
  }

  return (
    <Show
      when={!controller.bootstrap.isPending && controller.persistenceReady}
      fallback={
        <main class="conventional-workspace conventional-workspace--loading">
          <WorkspaceSkeleton />
        </main>
      }
    >
      <Show
        when={!controller.bootstrap.isError}
        fallback={
          <main class="conventional-workspace conventional-workspace--loading">
            <WorkspaceError
              error={controller.bootstrap.error}
              retry={() => void controller.bootstrap.refetch()}
            />
          </main>
        }
      >
        <Show when={controller.activeWorkspace && controller.workspaceId}>
          <main class="conventional-workspace">
            <a class="conventional-skip-link" href="#workspace-main">
              Skip to workspace content
            </a>
            <WorkspaceSidebar
              agents={controller.agents}
              channelBusy={controller.channelBusy}
              collapsedRoomIds={collapsedRoomIds()}
              mobileOpen={mobileSidebarOpen()}
              navigation={controller.navigation()}
              onArchiveChannel={controller.channelActions.archive}
              onCreateGroup={() => setDialog('create-group')}
              onCreateRoom={() => setDialog('create-room')}
              onRenameChannel={controller.channelActions.rename}
              onOpenAgents={() => {
                setSelectedArtifactId(null)
                workspaceStore.getState().setActiveSurface('agents')
              }}
              onOpenTasks={() => {
                setSelectedArtifactId(null)
                workspaceStore.getState().setActiveSurface('tasks')
              }}
              onMarkAllRead={() => void controller.readStateActions.markAllRead()}
              onChannelIntent={prefetchChannelMessages}
              onSelectChannel={selectChannel}
              onToggleMobile={(open) => workspaceStore.getState().setMobileSidebarOpen(open)}
              onToggleRoom={(roomId) => workspaceStore.getState().toggleRoomCollapsed(roomId)}
              onUpdateRoom={controller.roomActions.update}
              roomBusy={controller.roomBusy}
              selectedChannelId={selectedChannelId()}
              readState={controller.readState}
              workspaceName={controller.activeWorkspace!.name}
            />
            <section id="workspace-main" class="conventional-main" tabIndex={-1}>
              <Show when={sessionRotated() && !sessionNoticeDismissed()}>
                <section class="conventional-session-notice" role="alert">
                  <AlertTriangle aria-hidden="true" />
                  <div>
                    <h2>Your previous session wasn&apos;t recognized</h2>
                    <p>
                      You&apos;re in a new temporary workspace, so earlier tasks and conversations
                      aren&apos;t visible here. Use the workspace switcher to return to your
                      previous workspace if it&apos;s still available.
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="Dismiss session notice"
                    onClick={() => setSessionNoticeDismissed(true)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </section>
              </Show>
              <Show
                when={!controller.workspaceQueries.find(({ isError }) => isError)}
                fallback={(() => {
                  const queryError = controller.workspaceQueries.find(({ isError }) => isError)!
                  return (
                    <WorkspaceError
                      error={queryError.error}
                      retry={() => void queryError.refetch()}
                    />
                  )
                })()}
              >
                <Show
                  when={controller.artifacts.find(({ id }) => id === selectedArtifactId())}
                  fallback={
                    <Show
                      when={activeSurface() === 'conversation'}
                      fallback={
                        <Show
                          when={activeSurface() === 'agents'}
                          fallback={
                            <TaskBoard
                              agents={controller.agents}
                              busy={controller.taskBusy}
                              onArchive={controller.taskActions.archive}
                              onAssign={controller.taskActions.assign}
                              onCancel={controller.taskActions.cancel}
                              onComplete={controller.taskActions.complete}
                              onCreate={controller.taskActions.create}
                              onDependencies={controller.taskActions.dependencies}
                              onMoveRoom={controller.taskActions.moveRoom}
                              onUpdate={controller.taskActions.update}
                              onOpenConversation={(task) =>
                                void controller.taskActions
                                  .openConversation(task)
                                  .then(() =>
                                    workspaceStore.getState().setActiveSurface('conversation')
                                  )
                              }
                              onQueue={controller.taskActions.queue}
                              onReview={controller.taskActions.review}
                              onSelect={(taskId) =>
                                workspaceStore.getState().setSelectedTaskId(taskId)
                              }
                              onStart={controller.taskActions.start}
                              privateContent={services()?.privateContent}
                              rooms={controller.rooms}
                              selectedTaskId={selectedTaskId()}
                              tasks={controller.tasks}
                            />
                          }
                        >
                          <AgentRoster
                            agents={controller.agents}
                            busy={controller.createAgentBusy || controller.agentBusy}
                            onArchive={controller.agentActions.archive}
                            onCreate={controller.createAgent}
                            onMessage={async (agentId) => {
                              await controller.openAgentConversation(agentId)
                              workspaceStore.getState().setActiveSurface('conversation')
                            }}
                            onUpdate={async (agent, input) => {
                              if (
                                input.name.trim() !== agent.name ||
                                input.roleSummary !== (agent.roleSummary ?? null) ||
                                input.avatarRef !== (agent.avatarRef ?? null) ||
                                input.characterRef !== (agent.characterRef ?? null)
                              )
                                await controller.agentActions.presentation(agent.id, {
                                  avatarRef: input.avatarRef,
                                  characterRef: input.characterRef,
                                  name: input.name,
                                  roleSummary: input.roleSummary,
                                })
                              if (input.roomId !== (agent.roomId ?? null))
                                await controller.agentActions.assignRoom(agent.id, input.roomId)
                              if (
                                input.profileId.trim() !== agent.profile.id ||
                                input.profileVersion.trim() !== agent.profile.version
                              )
                                await controller.agentActions.profile(agent.id, {
                                  profileId: input.profileId,
                                  profileVersion: input.profileVersion,
                                })
                            }}
                            rooms={controller.rooms}
                          />
                        </Show>
                      }
                    >
                      <ConversationSurface
                        agents={controller.agents}
                        artifacts={controller.artifacts}
                        channel={controller.selectedChannel}
                        client={controller.client}
                        draft={selectedChannelId() ? (drafts()[selectedChannelId()!] ?? '') : ''}
                        onDraftChange={(value) =>
                          selectedChannelId() &&
                          workspaceStore.getState().setDraft(selectedChannelId()!, value)
                        }
                        onOpenDetails={() => setDialog('details')}
                        onOpenSearch={() => setDialog('conversation-search')}
                        onMarkRead={(lastReadSequence) =>
                          controller.readStateActions.markChannel({
                            action: 'read',
                            channelId: controller.selectedChannel!.id,
                            lastReadSequence,
                          })
                        }
                        onMarkThreadRead={(rootId, lastReadSequence) =>
                          controller.readStateActions.markThread({
                            action: 'read',
                            channelId: controller.selectedChannel!.id,
                            lastReadSequence,
                            threadRootMessageId: rootId,
                          })
                        }
                        onMarkThreadUnread={(rootId) =>
                          controller.readStateActions.markThread({
                            action: 'unread',
                            channelId: controller.selectedChannel!.id,
                            threadRootMessageId: rootId,
                          })
                        }
                        onMarkUnread={() =>
                          controller.readStateActions.markChannel({
                            action: 'unread',
                            channelId: controller.selectedChannel!.id,
                          })
                        }
                        onOpenTask={(taskId) => {
                          workspaceStore.getState().setSelectedTaskId(taskId)
                          workspaceStore.getState().setActiveSurface('tasks')
                        }}
                        privateContent={services()?.privateContent}
                        onThreadChange={(messageId) =>
                          workspaceStore.getState().setThreadRootMessageId(messageId)
                        }
                        onThreadDraftChange={(value) =>
                          threadRootMessageId() &&
                          workspaceStore
                            .getState()
                            .setDraft(`thread:${threadRootMessageId()}`, value)
                        }
                        tasks={controller.tasks}
                        searchTargetMessageId={searchTargetMessageId()}
                        threadDraft={
                          threadRootMessageId()
                            ? (drafts()[`thread:${threadRootMessageId()}`] ?? '')
                            : ''
                        }
                        threadRootMessageId={threadRootMessageId()}
                        transcription={services()?.transcription}
                        workspaceId={controller.workspaceId!}
                      />
                    </Show>
                  }
                >
                  {(artifact) => (
                    <ArtifactDetail
                      artifact={artifact()}
                      dismiss={() => setSelectedArtifactId(null)}
                      openTask={(taskId) => {
                        workspaceStore.getState().setSelectedTaskId(taskId)
                        workspaceStore.getState().setActiveSurface('tasks')
                        setSelectedArtifactId(null)
                      }}
                    />
                  )}
                </Show>
              </Show>
            </section>
            <Suspense fallback={null}>
              {/* Dialogs mount only while their id is active. Rendering every
                  lazy dialog unconditionally asks the browser for each chunk on
                  workspace mount (settings alone is ~108 KB raw), which is the
                  load-time half of the dynamic-import boundary. The dialog
                  primitives already mount only while open, so opening and
                  closing behaves exactly as before. */}
              <Show when={dialog() === 'create-room'}>
                <CreateRoomDialog
                  busy={controller.createRoomBusy}
                  onClose={() => setDialog(null)}
                  onCreate={controller.createRoom}
                  open
                  template={controller.activeWorkspace!.scene}
                />
              </Show>
              <Show when={dialog() === 'create-group'}>
                <CreateGroupDialog
                  busy={controller.createGroupBusy}
                  onClose={() => setDialog(null)}
                  onCreate={controller.createGroup}
                  open
                />
              </Show>
              <Show when={dialog() === 'search' || dialog() === 'conversation-search'}>
                <WorkspaceSearchDialog
                  agents={controller.agents}
                  artifacts={controller.artifacts}
                  channels={controller.channels}
                  client={controller.client}
                  onChannelIntent={prefetchChannelMessages}
                  onClose={() => setDialog(null)}
                  online={online()}
                  onSelect={selectSearchResult}
                  open
                  privateContent={services()?.privateContent}
                  rooms={controller.rooms}
                  scopeChannelId={
                    dialog() === 'conversation-search' ? controller.selectedChannel?.id : undefined
                  }
                  tasks={controller.tasks}
                  workspaceId={controller.workspaceId!}
                />
              </Show>
              <Show when={(props.manageSettings ?? true) && dialog() === 'settings'}>
                <WorkspaceSettingsDialog
                  accountAuthenticated={accountAuthenticated()}
                  accountLabel={accountLabel()}
                  agents={controller.agents}
                  busy={services()?.account?.busy ?? accountBusy()}
                  onClose={() => setDialog(null)}
                  onOpenAgents={() => {
                    setSelectedArtifactId(null)
                    workspaceStore.getState().setActiveSurface('agents')
                  }}
                  onSignIn={() => services()?.account?.onSignIn()}
                  onSignOut={() => void signOut()}
                  open
                  services={services()}
                  workspace={controller.activeWorkspace!}
                />
              </Show>
              <Show when={dialog() === 'details'}>
                <ModalDialog
                  open
                  onClose={() => setDialog(null)}
                  title="Conversation details"
                  description="Canonical Adea identity and scope."
                >
                  <div class="conventional-conversation-details">
                    <p>
                      <span>Kind</span>
                      <strong>{controller.selectedChannel?.kind.replace('_', ' ')}</strong>
                    </p>
                    <p>
                      <span>Visibility</span>
                      <strong>{controller.selectedChannel?.visibility}</strong>
                    </p>
                    <p>
                      <span>Participants</span>
                      <strong>{controller.selectedChannel?.participants.length ?? 0}</strong>
                    </p>
                    <p>
                      <span>Task link</span>
                      <strong>{controller.selectedChannel?.taskId ? 'Linked' : 'None'}</strong>
                    </p>
                  </div>
                </ModalDialog>
              </Show>
            </Suspense>
            <div class="visually-hidden" aria-live="polite">
              {online() ? 'Workspace online' : 'Workspace offline. Drafts remain on this device.'}
            </div>
            <Show when={selectedAgentId()}>
              <span class="visually-hidden">Selected Agent {selectedAgentId()}</span>
            </Show>
          </main>
        </Show>
      </Show>
    </Show>
  )
}
