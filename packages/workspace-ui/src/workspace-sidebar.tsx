import type {
  AgentSummary,
  ChannelReadStateSummary,
  ChannelSummary,
  RoomSummary,
} from '@adea-ai/types'
import {
  Bot,
  ChevronDown,
  ChevronRight,
  EllipsisVertical,
  Hash,
  Link2,
  ListTodo,
  Menu,
  MessageCircle,
  Pencil,
  Plus,
  Users,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@adea-ai/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@adea-ai/ui/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@adea-ai/ui/components/ui/tooltip'

import type { WorkspaceNavigation } from './workspace-model'
import { EditRoomDialog, RenameConversationDialog } from './create-workspace-dialogs'
import { RoomIcon } from './room-icon'

const SIDEBAR_WIDTH_STORAGE_KEY = 'adea:workspace-sidebar-width'
const SIDEBAR_MIN_WIDTH = 208
const SIDEBAR_MAX_WIDTH = 448
const SIDEBAR_DEFAULT_WIDTH = 272

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

function workspaceRootFor(sidebar: HTMLElement | null): HTMLElement | null {
  return sidebar?.closest<HTMLElement>('.conventional-workspace') ?? null
}

function currentSidebarWidth(root: HTMLElement): number {
  const columns = getComputedStyle(root).gridTemplateColumns.split(' ')
  return Number.parseFloat(columns[0] ?? '') || SIDEBAR_DEFAULT_WIDTH
}

function applySidebarWidth(root: HTMLElement, width: number) {
  root.style.setProperty('--conventional-sidebar-width', `${clampSidebarWidth(width)}px`)
}

function ConversationChannelRow({
  channel,
  icon,
  label,
  onArchive,
  onCopyLink,
  onRename,
  onSelect,
  selected,
  unread,
}: Readonly<{
  channel: ChannelSummary
  icon: ReactNode
  label: string
  onArchive: (channel: ChannelSummary) => void
  onCopyLink: (channel: ChannelSummary) => void
  onRename: (channel: ChannelSummary) => void
  onSelect: () => void
  selected: boolean
  unread: ReactNode
}>) {
  return (
    <li className="conventional-channel-row">
      <button type="button" aria-current={selected ? 'page' : undefined} onClick={onSelect}>
        {icon}
        <span>{label}</span>
        {unread}
      </button>
      <span className="conventional-channel-actions">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Conversation options for ${label}`}
              />
            }
          >
            <EllipsisVertical aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom">
            <DropdownMenuItem onClick={() => onRename(channel)}>Rename</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onCopyLink(channel)}>
              <Link2 aria-hidden="true" />
              Copy link
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="button"
          variant="destructive"
          size="icon"
          aria-label={`Delete ${label}`}
          onClick={() => onArchive(channel)}
        >
          <X aria-hidden="true" />
        </Button>
      </span>
    </li>
  )
}

type Props = Readonly<{
  agents: readonly AgentSummary[]
  channelBusy: boolean
  collapsedRoomIds: readonly string[]
  mobileOpen: boolean
  navigation: WorkspaceNavigation
  onArchiveChannel: (channel: ChannelSummary) => Promise<void>
  onCreateGroup: () => void
  onCreateRoom: () => void
  onOpenAgents: () => void
  onOpenTasks: () => void
  onMarkAllRead: () => void
  onRenameChannel: (channel: ChannelSummary, title: string) => Promise<void>
  onSelectChannel: (channelId: string, roomId?: string) => void
  onToggleMobile: (open: boolean) => void
  onToggleRoom: (roomId: string) => void
  onUpdateRoom: (
    roomId: string,
    update: Readonly<{ functionKey?: string; name?: string }>
  ) => Promise<void>
  roomBusy: boolean
  selectedChannelId: string | null
  readState: readonly ChannelReadStateSummary[]
  workspaceName: string
}>

export function WorkspaceSidebar(props: Props) {
  const sidebarRef = useRef<HTMLElement>(null)
  const [editingRoom, setEditingRoom] = useState<RoomSummary | null>(null)
  const [renamingChannel, setRenamingChannel] = useState<ChannelSummary | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const agentById = new Map(props.agents.map((agent) => [agent.id, agent]))
  const readStateByChannel = new Map(props.readState.map((state) => [state.channelId, state]))
  const hasUnread = props.readState.some(
    (state) =>
      (state.topLevelUnreadCount ?? 0) + (state.threadUnreadCount ?? 0) > 0 ||
      Boolean(state.manuallyUnread)
  )
  const unreadBadge = (channelId: string) => {
    const state = readStateByChannel.get(channelId)
    const count = (state?.topLevelUnreadCount ?? 0) + (state?.threadUnreadCount ?? 0)
    return count || state?.manuallyUnread ? (
      <span className="conventional-unread-badge" aria-label={`${count || 1} unread`}>
        {count > 99 ? '99+' : count || '•'}
      </span>
    ) : null
  }

  const archiveChannel = (channel: ChannelSummary) => {
    setActionError(null)
    void props
      .onArchiveChannel(channel)
      .catch(() => setActionError('Conversation could not be deleted.'))
  }
  const copyChannelLink = (channel: ChannelSummary) => {
    setActionError(null)
    const url = new URL(window.location.href)
    url.searchParams.set('channel', channel.id)
    void navigator.clipboard
      .writeText(url.toString())
      .catch(() => setActionError('Conversation link could not be copied.'))
  }

  // Restore the persisted sidebar width before first paint of the layout.
  useEffect(() => {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
    if (!Number.isFinite(stored) || stored <= 0) return
    const root = workspaceRootFor(sidebarRef.current)
    if (root) applySidebarWidth(root, stored)
  }, [])

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const root = workspaceRootFor(sidebarRef.current)
    const handle = event.currentTarget
    if (!root) return
    const startWidth = currentSidebarWidth(root)
    const startX = event.clientX
    let width = startWidth
    handle.setPointerCapture(event.pointerId)

    // The element is captured in a closure because React nulls
    // event.currentTarget once the synthetic handler returns.
    const onMove = (moveEvent: PointerEvent) => {
      width = clampSidebarWidth(startWidth + (moveEvent.clientX - startX))
      applySidebarWidth(root, width)
    }
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onEnd)
      handle.removeEventListener('pointercancel', onEnd)
      applySidebarWidth(root, width)
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width))
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onEnd)
    handle.addEventListener('pointercancel', onEnd)
  }, [])

  const resizeByKeyboard = useCallback((delta: number) => {
    const root = workspaceRootFor(sidebarRef.current)
    if (!root) return
    const width = clampSidebarWidth(currentSidebarWidth(root) + delta)
    applySidebarWidth(root, width)
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width))
  }, [])

  const onResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        resizeByKeyboard(-16)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        resizeByKeyboard(16)
      }
    },
    [resizeByKeyboard]
  )
  return (
    <>
      <button
        type="button"
        className="conventional-mobile-menu"
        aria-label="Open workspace navigation"
        aria-expanded={props.mobileOpen}
        onClick={() => props.onToggleMobile(true)}
      >
        <Menu aria-hidden="true" />
      </button>
      {props.mobileOpen ? (
        <button
          type="button"
          className="conventional-sidebar-scrim"
          aria-label="Close workspace navigation"
          onClick={() => props.onToggleMobile(false)}
        />
      ) : null}
      <aside
        ref={sidebarRef}
        className={`conventional-sidebar${props.mobileOpen ? ' conventional-sidebar--open' : ''}`}
        aria-label="Workspace navigation"
      >
        <div
          className="conventional-sidebar__resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize workspace navigation"
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={onResizeKeyDown}
        />
        <button
          type="button"
          aria-label="Close workspace navigation"
          className="conventional-sidebar__close"
          onClick={() => props.onToggleMobile(false)}
        >
          <X aria-hidden="true" />
        </button>

        <div className="conventional-sidebar__title">
          <h1>{props.workspaceName}</h1>
        </div>
        <div className="conventional-sidebar__quick-actions">
          <button type="button" onClick={props.onOpenTasks}>
            <ListTodo aria-hidden="true" />
            Tasks
          </button>
          <button type="button" onClick={props.onOpenAgents}>
            <Bot aria-hidden="true" />
            Agents
          </button>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={props.onMarkAllRead}
                  aria-label="Mark all read"
                  disabled={!hasUnread}
                />
              }
            >
              <MessageCircle aria-hidden="true" />
              Mark all read
              <kbd>⇧⌘A</kbd>
            </TooltipTrigger>
            <TooltipContent side="bottom">Mark all read (Mod+Shift+A)</TooltipContent>
          </Tooltip>
        </div>

        <div className="conventional-sidebar__scroll">
          {actionError ? (
            <p role="alert" className="conventional-sidebar-error">
              {actionError}
            </p>
          ) : null}
          <section className="conventional-sidebar-section" aria-labelledby="rooms-heading">
            <div className="conventional-sidebar-section__heading">
              <h2 id="rooms-heading">Rooms</h2>
              <button type="button" aria-label="Create Room" onClick={props.onCreateRoom}>
                <Plus aria-hidden="true" />
              </button>
            </div>
            {props.navigation.rooms.length ? (
              <ul className="conventional-room-list">
                {props.navigation.rooms.map((item) => {
                  const collapsed = props.collapsedRoomIds.includes(item.room.id)
                  const selected =
                    Boolean(item.selectionChannelId) &&
                    (props.selectedChannelId === item.selectionChannelId ||
                      item.visibleChannels.some(({ id }) => id === props.selectedChannelId))
                  const roomChannels = [
                    ...(item.primaryChannel ? [item.primaryChannel] : []),
                    ...item.visibleChannels.filter(({ id }) => id !== item.primaryChannel?.id),
                  ]
                  const roomUnread = roomChannels.reduce((total, channel) => {
                    const state = readStateByChannel.get(channel.id)
                    return (
                      total + (state?.topLevelUnreadCount ?? 0) + (state?.threadUnreadCount ?? 0)
                    )
                  }, 0)
                  return (
                    <li key={item.room.id}>
                      <div className="conventional-room-row">
                        <button
                          type="button"
                          className="conventional-room-select"
                          aria-current={selected ? 'page' : undefined}
                          onClick={() =>
                            item.selectionChannelId &&
                            props.onSelectChannel(item.selectionChannelId, item.room.id)
                          }
                        >
                          <RoomIcon functionKey={item.room.functionKey} />
                          <span className="conventional-room-name">{item.room.name}</span>
                          {roomUnread ? (
                            <span
                              className="conventional-unread-badge"
                              aria-label={`${roomUnread} unread in ${item.room.name}`}
                            >
                              {roomUnread > 99 ? '99+' : roomUnread}
                            </span>
                          ) : null}
                        </button>
                        <span className="conventional-room-actions">
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Room options for ${item.room.name}`}
                                />
                              }
                            >
                              <EllipsisVertical aria-hidden="true" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" side="bottom">
                              <DropdownMenuItem
                                onClick={() => {
                                  setActionError(null)
                                  setEditingRoom(item.room)
                                }}
                              >
                                <Pencil aria-hidden="true" />
                                Edit
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </span>
                        {item.visibleChannels.length ? (
                          <button
                            type="button"
                            className="conventional-room-toggle"
                            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${item.room.name}`}
                            aria-expanded={!collapsed}
                            onClick={() => props.onToggleRoom(item.room.id)}
                          >
                            {collapsed ? (
                              <ChevronRight aria-hidden="true" />
                            ) : (
                              <ChevronDown aria-hidden="true" />
                            )}
                          </button>
                        ) : null}
                      </div>
                      {item.visibleChannels.length && !collapsed ? (
                        <ul className="conventional-channel-list">
                          {item.visibleChannels.map((channel) => (
                            <li key={channel.id}>
                              <button
                                type="button"
                                aria-current={
                                  channel.id === props.selectedChannelId ? 'page' : undefined
                                }
                                onClick={() => props.onSelectChannel(channel.id, item.room.id)}
                              >
                                <Hash aria-hidden="true" />
                                <span>{channel.title}</span>
                                {unreadBadge(channel.id)}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="conventional-sidebar-empty">Create a Room to organize the work.</p>
            )}
          </section>

          <section className="conventional-sidebar-section" aria-labelledby="conversations-heading">
            <div className="conventional-sidebar-section__heading">
              <h2 id="conversations-heading">Conversations</h2>
              <button
                type="button"
                aria-label="Create group conversation"
                onClick={props.onCreateGroup}
              >
                <Plus aria-hidden="true" />
              </button>
            </div>
            <ul className="conventional-channel-list conventional-channel-list--standalone">
              {props.navigation.directAgentChannels.map((channel) => (
                <ConversationChannelRow
                  key={channel.id}
                  channel={channel}
                  icon={<Bot aria-hidden="true" />}
                  label={
                    channel.agentId ? (agentById.get(channel.agentId)?.name ?? 'Agent') : 'Agent'
                  }
                  onArchive={archiveChannel}
                  onCopyLink={copyChannelLink}
                  onRename={setRenamingChannel}
                  onSelect={() => props.onSelectChannel(channel.id)}
                  selected={channel.id === props.selectedChannelId}
                  unread={unreadBadge(channel.id)}
                />
              ))}
              {props.navigation.groupChannels.map((channel) => (
                <ConversationChannelRow
                  key={channel.id}
                  channel={channel}
                  icon={<Users aria-hidden="true" />}
                  label={channel.title}
                  onArchive={archiveChannel}
                  onCopyLink={copyChannelLink}
                  onRename={setRenamingChannel}
                  onSelect={() => props.onSelectChannel(channel.id)}
                  selected={channel.id === props.selectedChannelId}
                  unread={unreadBadge(channel.id)}
                />
              ))}
            </ul>
            {!props.navigation.directAgentChannels.length &&
            !props.navigation.groupChannels.length ? (
              <button
                type="button"
                className="conventional-sidebar-empty-action"
                onClick={props.onOpenAgents}
              >
                <MessageCircle aria-hidden="true" />
                Start with an Agent
              </button>
            ) : null}
          </section>
        </div>
      </aside>
      {editingRoom ? (
        <EditRoomDialog
          busy={props.roomBusy}
          initialFunctionKey={editingRoom.functionKey}
          initialName={editingRoom.name}
          onClose={() => setEditingRoom(null)}
          onSave={(input) => props.onUpdateRoom(editingRoom.id, input)}
          open
          roomName={editingRoom.name}
        />
      ) : null}
      {renamingChannel ? (
        <RenameConversationDialog
          busy={props.channelBusy}
          initialTitle={renamingChannel.title}
          onClose={() => setRenamingChannel(null)}
          onSave={(title) => props.onRenameChannel(renamingChannel, title)}
          open
        />
      ) : null}
    </>
  )
}
