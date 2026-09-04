import type { AgentSummary, ChannelReadStateSummary } from '@agent-hq/types'
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Hash,
  ListTodo,
  Menu,
  MessageCircle,
  Plus,
  Users,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'

import type { WorkspaceNavigation } from './workspace-model'

const SIDEBAR_WIDTH_STORAGE_KEY = 'agent-hq:workspace-sidebar-width'
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

type Props = Readonly<{
  agents: readonly AgentSummary[]
  collapsedRoomIds: readonly string[]
  mobileOpen: boolean
  navigation: WorkspaceNavigation
  onCreateGroup: () => void
  onCreateRoom: () => void
  onOpenAgents: () => void
  onOpenTasks: () => void
  onMarkAllRead: () => void
  onSelectChannel: (channelId: string, roomId?: string) => void
  onToggleMobile: (open: boolean) => void
  onToggleRoom: (roomId: string) => void
  selectedChannelId: string | null
  readState: readonly ChannelReadStateSummary[]
}>

export function WorkspaceSidebar(props: Props) {
  const sidebarRef = useRef<HTMLElement>(null)
  const agentById = new Map(props.agents.map((agent) => [agent.id, agent]))
  const readStateByChannel = new Map(props.readState.map((state) => [state.channelId, state]))
  const unreadBadge = (channelId: string) => {
    const state = readStateByChannel.get(channelId)
    const count = (state?.topLevelUnreadCount ?? 0) + (state?.threadUnreadCount ?? 0)
    return count || state?.manuallyUnread ? (
      <span className="conventional-unread-badge" aria-label={`${count || 1} unread`}>
        {count > 99 ? '99+' : count || '•'}
      </span>
    ) : null
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

        <div className="conventional-sidebar__quick-actions">
          <button type="button" onClick={props.onOpenTasks}>
            <ListTodo aria-hidden="true" />
            Tasks
          </button>
          <button type="button" onClick={props.onOpenAgents}>
            <Bot aria-hidden="true" />
            Agents
          </button>
          <button type="button" onClick={props.onMarkAllRead} title="Mark all read (Mod+Shift+A)">
            <MessageCircle aria-hidden="true" />
            Mark all read
            <kbd>⇧⌘A</kbd>
          </button>
        </div>

        <div className="conventional-sidebar__scroll">
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
                        ) : (
                          <span className="conventional-room-toggle" aria-hidden="true" />
                        )}
                        <button
                          type="button"
                          className="conventional-room-select"
                          aria-current={selected ? 'page' : undefined}
                          onClick={() =>
                            item.selectionChannelId &&
                            props.onSelectChannel(item.selectionChannelId, item.room.id)
                          }
                        >
                          <span>{item.room.name}</span>
                          {!item.visibleChannels.length ? <span>Room</span> : null}
                          {roomUnread ? (
                            <span
                              className="conventional-unread-badge"
                              aria-label={`${roomUnread} unread in ${item.room.name}`}
                            >
                              {roomUnread > 99 ? '99+' : roomUnread}
                            </span>
                          ) : null}
                        </button>
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
                <li key={channel.id}>
                  <button
                    type="button"
                    aria-current={channel.id === props.selectedChannelId ? 'page' : undefined}
                    onClick={() => props.onSelectChannel(channel.id)}
                  >
                    <Bot aria-hidden="true" />
                    <span>
                      {channel.agentId
                        ? (agentById.get(channel.agentId)?.name ?? 'Agent')
                        : 'Agent'}
                    </span>
                    {unreadBadge(channel.id)}
                  </button>
                </li>
              ))}
              {props.navigation.groupChannels.map((channel) => (
                <li key={channel.id}>
                  <button
                    type="button"
                    aria-current={channel.id === props.selectedChannelId ? 'page' : undefined}
                    onClick={() => props.onSelectChannel(channel.id)}
                  >
                    <Users aria-hidden="true" />
                    <span>{channel.title}</span>
                    {unreadBadge(channel.id)}
                  </button>
                </li>
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
    </>
  )
}
