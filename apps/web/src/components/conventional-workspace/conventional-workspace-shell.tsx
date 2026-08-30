'use client'

import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '@agent-hq/state'
import { Boxes, UserRound } from 'lucide-react'

import { AgentRoster } from './agent-roster'
import { ArtifactDetail } from './artifact-detail'
import { ConversationSurface } from './conversation-surface'
import { CreateGroupDialog, CreateRoomDialog } from './create-workspace-dialogs'
import { ModalDialog } from './modal-dialog'
import { TaskBoard } from './task-board'
import { useWorkspaceController } from './use-workspace-controller'
import { WorkspaceSidebar } from './workspace-sidebar'
import { WorkspaceError, WorkspaceSkeleton } from './workspace-states'
import {
  WorkspaceSearchDialog,
  WorkspaceSettingsDialog,
  type SearchResult,
} from './workspace-utility-dialogs'

type DialogId =
  'conversation-search' | 'create-group' | 'create-room' | 'details' | 'search' | 'settings' | null

export function ConventionalWorkspaceShell() {
  const controller = useWorkspaceController()
  const [dialog, setDialog] = useState<DialogId>(null)
  const [accountBusy, setAccountBusy] = useState(false)
  const [online, setOnline] = useState(true)
  const [searchTargetMessageId, setSearchTargetMessageId] = useState<string | null>(null)
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const activeSurface = useWorkspaceStore((state) => state.activeSurface)
  const collapsedRoomIds = useWorkspaceStore((state) => state.collapsedRoomIds)
  const drafts = useWorkspaceStore((state) => state.drafts)
  const mobileSidebarOpen = useWorkspaceStore((state) => state.mobileSidebarOpen)
  const selectedAgentId = useWorkspaceStore((state) => state.selectedAgentId)
  const selectedChannelId = useWorkspaceStore((state) => state.selectedChannelId)
  const selectedTaskId = useWorkspaceStore((state) => state.selectedTaskId)
  const threadRootMessageId = useWorkspaceStore((state) => state.threadRootMessageId)
  const setActiveSurface = useWorkspaceStore((state) => state.setActiveSurface)
  const setDraft = useWorkspaceStore((state) => state.setDraft)
  const setMobileSidebarOpen = useWorkspaceStore((state) => state.setMobileSidebarOpen)
  const setSelectedAgentId = useWorkspaceStore((state) => state.setSelectedAgentId)
  const setSelectedTaskId = useWorkspaceStore((state) => state.setSelectedTaskId)
  const setThreadRootMessageId = useWorkspaceStore((state) => state.setThreadRootMessageId)
  const toggleRoomCollapsed = useWorkspaceStore((state) => state.toggleRoomCollapsed)
  const principal = controller.bootstrap.data?.principal
  const accountAuthenticated = Boolean(principal && !principal.temporary)
  const accountLabel = accountAuthenticated ? (principal?.displayName ?? 'Account') : 'Sign in'
  const selectChannel = (channelId: string, roomId?: string) => {
    setSelectedArtifactId(null)
    setSearchTargetMessageId(null)
    controller.selectChannel(channelId, roomId)
    setActiveSurface('conversation')
    setMobileSidebarOpen(false)
  }

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
      const editable =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setDialog('search')
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'f' &&
        activeSurface === 'conversation' &&
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
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    activeSurface,
    controller.channels,
    controller.readStateActions,
    controller.selectedChannel,
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
      const { createNeonClientAdapter } = await import('@agent-hq/auth/client')
      await createNeonClientAdapter().signOut()
      window.location.assign('/')
    } finally {
      setAccountBusy(false)
    }
  }

  return (
    <main className="conventional-workspace">
      <a className="conventional-skip-link" href="#workspace-main">
        Skip to workspace content
      </a>
      <div className="conventional-topbar">
        <a href="/" className="conventional-brand" aria-label="Agent HQ home">
          <span>AH</span>
          <strong>Agent HQ</strong>
        </a>
        <div className="conventional-topbar__context">
          <Boxes aria-hidden="true" />
          <span>{controller.activeWorkspace.name}</span>
        </div>
        <button
          type="button"
          className="conventional-account-button"
          onClick={() => setDialog('settings')}
          aria-label={`Open user settings for ${accountLabel}`}
        >
          <UserRound aria-hidden="true" />
          <span>{accountLabel}</span>
        </button>
      </div>
      <WorkspaceSidebar
        activeWorkspace={controller.activeWorkspace}
        agents={controller.agents}
        collapsedRoomIds={collapsedRoomIds}
        mobileOpen={mobileSidebarOpen}
        navigation={controller.navigation}
        onCreateGroup={() => setDialog('create-group')}
        onCreateRoom={() => setDialog('create-room')}
        onOpenAgents={() => {
          setSelectedArtifactId(null)
          setActiveSurface('agents')
        }}
        onOpenSearch={() => setDialog('search')}
        onOpenSettings={() => setDialog('settings')}
        onOpenTasks={() => {
          setSelectedArtifactId(null)
          setActiveSurface('tasks')
        }}
        onMarkAllRead={() => void controller.readStateActions.markAllRead()}
        onSelectChannel={selectChannel}
        onToggleMobile={setMobileSidebarOpen}
        onToggleRoom={toggleRoomCollapsed}
        onWorkspaceChange={controller.selectWorkspace}
        selectedChannelId={selectedChannelId}
        readState={controller.readState}
        workspaces={controller.bootstrap.data?.workspaces ?? []}
      />
      <section id="workspace-main" className="conventional-main" tabIndex={-1}>
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
            onThreadChange={setThreadRootMessageId}
            onThreadDraftChange={(value) =>
              threadRootMessageId && setDraft(`thread:${threadRootMessageId}`, value)
            }
            tasks={controller.tasks}
            searchTargetMessageId={searchTargetMessageId}
            threadDraft={threadRootMessageId ? (drafts[`thread:${threadRootMessageId}`] ?? '') : ''}
            threadRootMessageId={threadRootMessageId}
            workspaceId={controller.workspaceId}
          />
        ) : activeSurface === 'agents' ? (
          <AgentRoster
            agents={controller.agents}
            busy={controller.createAgentBusy}
            onCreate={controller.createAgent}
            onMessage={async (agentId) => {
              await controller.openAgentConversation(agentId)
              setActiveSurface('conversation')
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
            onCreate={controller.taskActions.create}
            onDependencies={controller.taskActions.dependencies}
            onMoveRoom={controller.taskActions.moveRoom}
            onOpenConversation={(task) =>
              void controller.taskActions
                .openConversation(task)
                .then(() => setActiveSurface('conversation'))
            }
            onQueue={controller.taskActions.queue}
            onSelect={setSelectedTaskId}
            rooms={controller.rooms}
            selectedTaskId={selectedTaskId}
            tasks={controller.tasks}
          />
        )}
      </section>
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
        rooms={controller.rooms}
        scopeChannelId={
          dialog === 'conversation-search' ? controller.selectedChannel?.id : undefined
        }
        tasks={controller.tasks}
        workspaceId={controller.workspaceId}
      />
      <WorkspaceSettingsDialog
        accountAuthenticated={accountAuthenticated}
        accountLabel={accountLabel}
        busy={accountBusy}
        onClose={() => setDialog(null)}
        onSignIn={() => window.location.assign('/auth/sign-in?returnTo=%2F')}
        onSignOut={() => void signOut()}
        open={dialog === 'settings'}
      />
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
      <div className="visually-hidden" aria-live="polite">
        {online ? 'Workspace online' : 'Workspace offline. Drafts remain on this device.'}
      </div>
      {selectedAgentId ? (
        <span className="visually-hidden">Selected Agent {selectedAgentId}</span>
      ) : null}
    </main>
  )
}
