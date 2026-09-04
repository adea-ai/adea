'use client'

import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { useWorkspaceStore } from '@agent-hq/state'

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
  'conversation-search' | 'create-group' | 'create-room' | 'details' | 'search' | 'settings' | null

export function ConventionalWorkspaceShell({
  manageSettings = true,
  services,
}: Readonly<{
  manageSettings?: boolean
  onViewChange?: (view: WorkspaceView) => void
  services?: WorkspacePlatformServices
  view?: WorkspaceView
}> = {}) {
  const controller = useWorkspaceController(services?.client)
  const [dialog, setDialog] = useState<DialogId>(null)
  const [accountBusy, setAccountBusy] = useState(false)
  const [online, setOnline] = useState(true)
  const [searchTargetMessageId, setSearchTargetMessageId] = useState<string | null>(null)
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const [sessionNoticeDismissed, setSessionNoticeDismissed] = useState(false)
  const activeSurface = useWorkspaceStore((state) => state.activeSurface)
  const globalPanel = useWorkspaceStore((state) => state.globalPanel)
  const collapsedRoomIds = useWorkspaceStore((state) => state.collapsedRoomIds)
  const drafts = useWorkspaceStore((state) => state.drafts)
  const mobileSidebarOpen = useWorkspaceStore((state) => state.mobileSidebarOpen)
  const selectedAgentId = useWorkspaceStore((state) => state.selectedAgentId)
  const selectedChannelId = useWorkspaceStore((state) => state.selectedChannelId)
  const selectedTaskId = useWorkspaceStore((state) => state.selectedTaskId)
  const threadRootMessageId = useWorkspaceStore((state) => state.threadRootMessageId)
  const setActiveSurface = useWorkspaceStore((state) => state.setActiveSurface)
  const setGlobalPanel = useWorkspaceStore((state) => state.setGlobalPanel)
  const setDraft = useWorkspaceStore((state) => state.setDraft)
  const setMobileSidebarOpen = useWorkspaceStore((state) => state.setMobileSidebarOpen)
  const setSelectedAgentId = useWorkspaceStore((state) => state.setSelectedAgentId)
  const setSelectedTaskId = useWorkspaceStore((state) => state.setSelectedTaskId)
  const setThreadRootMessageId = useWorkspaceStore((state) => state.setThreadRootMessageId)
  const toggleRoomCollapsed = useWorkspaceStore((state) => state.toggleRoomCollapsed)
  const sessionRotated = controller.bootstrap.data?.sessionRotated ?? false
  const sessionIdentity = controller.bootstrap.data?.principal.userId
  useEffect(() => {
    setSessionNoticeDismissed(false)
  }, [sessionIdentity])
  const principal = controller.bootstrap.data?.principal
  const accountAuthenticated =
    services?.account?.authenticated ?? Boolean(principal && !principal.temporary)
  const accountLabel =
    services?.account?.label ??
    (accountAuthenticated ? (principal?.displayName ?? 'Account') : 'Sign in')
  const selectChannel = useCallback(
    (channelId: string, roomId?: string) => {
      setSelectedArtifactId(null)
      setSearchTargetMessageId(null)
      controller.selectChannel(channelId, roomId)
      setActiveSurface('conversation')
      setMobileSidebarOpen(false)
    },
    [controller.selectChannel, setActiveSurface, setMobileSidebarOpen]
  )

  useEffect(() => {
    if (globalPanel === 'settings' && !manageSettings) return
    if (globalPanel !== 'search' && globalPanel !== 'settings') return
    setDialog(globalPanel)
    setGlobalPanel(null)
  }, [globalPanel, manageSettings, setGlobalPanel])

  useEffect(() => {
    if (!manageSettings) return
    const openDeepLinkedSettings = () => {
      if (window.location.hash.startsWith('#settings')) setDialog('settings')
    }
    openDeepLinkedSettings()
    window.addEventListener('hashchange', openDeepLinkedSettings)
    return () => window.removeEventListener('hashchange', openDeepLinkedSettings)
  }, [manageSettings])

  useEffect(() => {
    const updateOnlineStatus = () => setOnline(navigator.onLine)
    updateOnlineStatus()
    window.addEventListener('online', updateOnlineStatus)
    window.addEventListener('offline', updateOnlineStatus)
    return () => {
      window.removeEventListener('online', updateOnlineStatus)
      window.removeEventListener('offline', updateOnlineStatus)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const editableTarget =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      const targetInClosingDialog =
        dialog === null &&
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
            destinations.findIndex(({ id }) => id === selectedChannelId),
            0
          )
          const direction = event.key === 'ArrowDown' ? 1 : -1
          const next = (current + direction + destinations.length) % destinations.length
          selectChannel(destinations[next]!.id, destinations[next]!.roomId)
        }
      }
      if (event.key === 'Escape' && threadRootMessageId) setThreadRootMessageId(null)
      if (event.key === 'Escape' && selectedArtifactId) setSelectedArtifactId(null)
    }
    // Capture workspace shortcuts before a portalled dialog's focus trap can
    // stop propagation while it restores focus after closing.
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [
    activeSurface,
    controller.channels,
    controller.readStateActions,
    controller.selectedChannel,
    dialog,
    selectedChannelId,
    selectedArtifactId,
    selectChannel,
    setThreadRootMessageId,
    threadRootMessageId,
  ])

  useEffect(() => {
    document.title = controller.activeWorkspace
      ? `${controller.activeWorkspace.name} | Agent HQ`
      : 'Agent HQ'
  }, [controller.activeWorkspace])

  useEffect(() => {
    if (!controller.workspaceId || !controller.channels.length) return
    const query = new URLSearchParams(window.location.search)
    const requestedWorkspace = query.get('workspace')
    if (requestedWorkspace && requestedWorkspace !== controller.workspaceId) return
    const channelId = query.get('channel')
    const taskId = query.get('task')
    if (channelId && controller.channels.some(({ id }) => id === channelId)) {
      const channel = controller.channels.find(({ id }) => id === channelId)!
      selectChannel(channel.id, channel.roomId)
      setThreadRootMessageId(query.get('thread'))
      setSearchTargetMessageId(query.get('message'))
    } else if (taskId && controller.tasks.some(({ id }) => id === taskId)) {
      setSelectedTaskId(taskId)
      setActiveSurface('tasks')
    }
  }, [
    controller.channels,
    controller.tasks,
    controller.workspaceId,
    selectChannel,
    setActiveSurface,
    setSelectedTaskId,
    setThreadRootMessageId,
  ])

  if (controller.bootstrap.isPending || !controller.persistenceReady)
    return (
      <main className="conventional-workspace conventional-workspace--loading">
        <WorkspaceSkeleton />
      </main>
    )
  if (controller.bootstrap.isError)
    return (
      <main className="conventional-workspace conventional-workspace--loading">
        <WorkspaceError
          error={controller.bootstrap.error}
          retry={() => void controller.bootstrap.refetch()}
        />
      </main>
    )
  if (!controller.activeWorkspace || !controller.workspaceId) return null
  const queryError = controller.workspaceQueries.find(({ isError }) => isError)
  const selectedArtifact = controller.artifacts.find(({ id }) => id === selectedArtifactId)
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
      const item = controller.navigation.rooms.find(({ room }) => room.id === result.id)
      if (item?.selectionChannelId) selectChannel(item.selectionChannelId, item.room.id)
      return
    }
    if (result.kind === 'agent') {
      setSelectedArtifactId(null)
      setSelectedAgentId(result.id)
      setActiveSurface('agents')
      return
    }
    if (result.kind === 'message' && result.channelId) {
      selectChannel(result.channelId, result.roomId)
      setThreadRootMessageId(result.threadRootMessageId ?? null)
      setSearchTargetMessageId(result.messageId ?? result.id)
      return
    }
    if (result.kind === 'artifact') {
      setSelectedArtifactId(result.id)
      return
    }
    setSelectedTaskId(result.id)
    setSelectedArtifactId(null)
    setActiveSurface('tasks')
  }
  const signOut = async () => {
    setAccountBusy(true)
    try {
      await services?.account?.onSignOut()
    } finally {
      setAccountBusy(false)
    }
  }

  return (
    <main className="conventional-workspace">
      <a className="conventional-skip-link" href="#workspace-main">
        Skip to workspace content
      </a>
      <WorkspaceSidebar
        agents={controller.agents}
        channelBusy={controller.channelBusy}
        collapsedRoomIds={collapsedRoomIds}
        mobileOpen={mobileSidebarOpen}
        navigation={controller.navigation}
        onArchiveChannel={controller.channelActions.archive}
        onCreateGroup={() => setDialog('create-group')}
        onCreateRoom={() => setDialog('create-room')}
        onRenameChannel={controller.channelActions.rename}
        onOpenAgents={() => {
          setSelectedArtifactId(null)
          setActiveSurface('agents')
        }}
        onOpenTasks={() => {
          setSelectedArtifactId(null)
          setActiveSurface('tasks')
        }}
        onMarkAllRead={() => void controller.readStateActions.markAllRead()}
        onSelectChannel={selectChannel}
        onToggleMobile={setMobileSidebarOpen}
        onToggleRoom={toggleRoomCollapsed}
        onUpdateRoom={controller.roomActions.update}
        roomBusy={controller.roomBusy}
        selectedChannelId={selectedChannelId}
        readState={controller.readState}
        workspaceName={controller.activeWorkspace.name}
      />
      <section id="workspace-main" className="conventional-main" tabIndex={-1}>
        {sessionRotated && !sessionNoticeDismissed ? (
          <section className="conventional-session-notice" role="alert">
            <AlertTriangle aria-hidden="true" />
            <div>
              <h2>Your previous session wasn&apos;t recognized</h2>
              <p>
                You&apos;re in a new temporary workspace, so earlier tasks and conversations
                aren&apos;t visible here. Use the workspace switcher to return to your previous
                workspace if it&apos;s still available.
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
        ) : null}
        {queryError ? (
          <WorkspaceError error={queryError.error} retry={() => void queryError.refetch()} />
        ) : selectedArtifact ? (
          <ArtifactDetail
            artifact={selectedArtifact}
            dismiss={() => setSelectedArtifactId(null)}
            openTask={(taskId) => {
              setSelectedTaskId(taskId)
              setActiveSurface('tasks')
              setSelectedArtifactId(null)
            }}
          />
        ) : activeSurface === 'conversation' ? (
          <ConversationSurface
            agents={controller.agents}
            artifacts={controller.artifacts}
            channel={controller.selectedChannel}
            client={controller.client}
            draft={selectedChannelId ? (drafts[selectedChannelId] ?? '') : ''}
            onDraftChange={(value) => selectedChannelId && setDraft(selectedChannelId, value)}
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
              setSelectedTaskId(taskId)
              setActiveSurface('tasks')
            }}
            privateContent={services?.privateContent}
            onThreadChange={setThreadRootMessageId}
            onThreadDraftChange={(value) =>
              threadRootMessageId && setDraft(`thread:${threadRootMessageId}`, value)
            }
            tasks={controller.tasks}
            searchTargetMessageId={searchTargetMessageId}
            threadDraft={threadRootMessageId ? (drafts[`thread:${threadRootMessageId}`] ?? '') : ''}
            threadRootMessageId={threadRootMessageId}
            transcription={services?.transcription}
            workspaceId={controller.workspaceId}
          />
        ) : activeSurface === 'agents' ? (
          <AgentRoster
            agents={controller.agents}
            busy={controller.createAgentBusy || controller.agentBusy}
            onArchive={controller.agentActions.archive}
            onCreate={controller.createAgent}
            onMessage={async (agentId) => {
              await controller.openAgentConversation(agentId)
              setActiveSurface('conversation')
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
        ) : (
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
                .then(() => setActiveSurface('conversation'))
            }
            onQueue={controller.taskActions.queue}
            onReview={controller.taskActions.review}
            onSelect={setSelectedTaskId}
            onStart={controller.taskActions.start}
            privateContent={services?.privateContent}
            rooms={controller.rooms}
            selectedTaskId={selectedTaskId}
            tasks={controller.tasks}
          />
        )}
      </section>
      <Suspense fallback={null}>
        <CreateRoomDialog
          busy={controller.createRoomBusy}
          onClose={() => setDialog(null)}
          onCreate={controller.createRoom}
          open={dialog === 'create-room'}
          template={controller.activeWorkspace.scene}
        />
        <CreateGroupDialog
          busy={controller.createGroupBusy}
          onClose={() => setDialog(null)}
          onCreate={controller.createGroup}
          open={dialog === 'create-group'}
        />
        <WorkspaceSearchDialog
          agents={controller.agents}
          artifacts={controller.artifacts}
          channels={controller.channels}
          client={controller.client}
          onClose={() => setDialog(null)}
          online={online}
          onSelect={selectSearchResult}
          open={dialog === 'search' || dialog === 'conversation-search'}
          privateContent={services?.privateContent}
          rooms={controller.rooms}
          scopeChannelId={
            dialog === 'conversation-search' ? controller.selectedChannel?.id : undefined
          }
          tasks={controller.tasks}
          workspaceId={controller.workspaceId}
        />
        {manageSettings ? (
          <WorkspaceSettingsDialog
            accountAuthenticated={accountAuthenticated}
            accountLabel={accountLabel}
            agents={controller.agents}
            busy={services?.account?.busy ?? accountBusy}
            onClose={() => setDialog(null)}
            onOpenAgents={() => {
              setSelectedArtifactId(null)
              setActiveSurface('agents')
            }}
            onSignIn={() => services?.account?.onSignIn()}
            onSignOut={() => void signOut()}
            open={dialog === 'settings'}
            services={services}
            workspace={controller.activeWorkspace}
          />
        ) : null}
        <ModalDialog
          open={dialog === 'details'}
          onClose={() => setDialog(null)}
          title="Conversation details"
          description="Canonical Agent HQ identity and scope."
        >
          <div className="conventional-conversation-details">
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
      </Suspense>
      <div className="visually-hidden" aria-live="polite">
        {online ? 'Workspace online' : 'Workspace offline. Drafts remain on this device.'}
      </div>
      {selectedAgentId ? (
        <span className="visually-hidden">Selected Agent {selectedAgentId}</span>
      ) : null}
    </main>
  )
}
