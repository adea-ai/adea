import type { AgentSummary, WorkspaceSummary } from '@agent-hq/types'
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Hash,
  ListTodo,
  Menu,
  MessageCircle,
  Plus,
  Search,
  Settings,
  Users,
  X,
} from 'lucide-react'

import type { WorkspaceNavigation } from './workspace-model'

type Props = Readonly<{
  activeWorkspace: WorkspaceSummary
  agents: readonly AgentSummary[]
  collapsedRoomIds: readonly string[]
  mobileOpen: boolean
  navigation: WorkspaceNavigation
  onCreateGroup: () => void
  onCreateRoom: () => void
  onOpenAgents: () => void
  onOpenSearch: () => void
  onOpenSettings: () => void
  onOpenTasks: () => void
  onSelectChannel: (channelId: string, roomId?: string) => void
  onToggleMobile: (open: boolean) => void
  onToggleRoom: (roomId: string) => void
  onWorkspaceChange: (workspaceId: string) => void
  selectedChannelId: string | null
  workspaces: readonly WorkspaceSummary[]
}>

export function WorkspaceSidebar(props: Props) {
  const agentById = new Map(props.agents.map((agent) => [agent.id, agent]))
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
        className={`conventional-sidebar${props.mobileOpen ? ' conventional-sidebar--open' : ''}`}
        aria-label="Workspace navigation"
      >
        <div className="conventional-sidebar__workspace">
          <label htmlFor="workspace-switcher">Workspace</label>
          <div>
            <select
              id="workspace-switcher"
              value={props.activeWorkspace.id}
              onChange={(event) => props.onWorkspaceChange(event.target.value)}
            >
              {props.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label="Close workspace navigation"
              className="conventional-sidebar__close"
              onClick={() => props.onToggleMobile(false)}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="conventional-sidebar__quick-actions">
          <button type="button" onClick={props.onOpenSearch}>
            <Search aria-hidden="true" />
            Search
            <kbd>⌘K</kbd>
          </button>
          <button type="button" onClick={props.onOpenTasks}>
            <ListTodo aria-hidden="true" />
            Tasks
          </button>
          <button type="button" onClick={props.onOpenAgents}>
            <Bot aria-hidden="true" />
            Agents
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

        <button
          type="button"
          className="conventional-sidebar__settings"
          onClick={props.onOpenSettings}
        >
          <Settings aria-hidden="true" />
          Settings
        </button>
      </aside>
    </>
  )
}
