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
  MessageCircle,
  PanelLeftClose,
  Pencil,
  Plus,
  Users,
  X,
} from 'lucide-solid'
import { createMemo, createSignal, For, onMount, Show, type JSX } from 'solid-js'
import { Button, buttonVariants } from '@adea-ai/ui/components/ui/button'
import { cn } from '@adea-ai/ui/lib/utils'
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
import { SidebarToggleButton } from './sidebar-toggle-button'

const SIDEBAR_WIDTH_STORAGE_KEY = 'adea:workspace-sidebar-width'
const SIDEBAR_MIN_WIDTH = 208
const SIDEBAR_MAX_WIDTH = 448
const SIDEBAR_DEFAULT_WIDTH = 272

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

function workspaceRootFor(sidebar: HTMLElement | null | undefined): HTMLElement | null {
  return sidebar?.closest<HTMLElement>('.conventional-workspace') ?? null
}

function currentSidebarWidth(root: HTMLElement): number {
  const columns = getComputedStyle(root).gridTemplateColumns.split(' ')
  return Number.parseFloat(columns[0] ?? '') || SIDEBAR_DEFAULT_WIDTH
}

function applySidebarWidth(root: HTMLElement, width: number) {
  root.style.setProperty('--conventional-sidebar-width', `${clampSidebarWidth(width)}px`)
}

function ConversationChannelRow(props: {
  channel: ChannelSummary
  icon: JSX.Element
  label: string
  onArchive: (channel: ChannelSummary) => void
  onCopyLink: (channel: ChannelSummary) => void
  onRename: (channel: ChannelSummary) => void
  onSelect: () => void
  selected: boolean
  unread: JSX.Element
}) {
  return (
    <li class="conventional-channel-row">
      <button
        type="button"
        aria-current={props.selected ? 'page' : undefined}
        onClick={() => props.onSelect()}
      >
        {props.icon}
        <span>{props.label}</span>
        {props.unread}
      </button>
      <span class="conventional-channel-actions">
        <DropdownMenu>
          <DropdownMenuTrigger
            class={cn(buttonVariants({ variant: 'ghost', size: 'icon' }))}
            aria-label={`Conversation options for ${props.label}`}
          >
            <EllipsisVertical aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom">
            <DropdownMenuItem onSelect={() => props.onRename(props.channel)}>
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => props.onCopyLink(props.channel)}>
              <Link2 aria-hidden="true" />
              Copy link
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="button"
          variant="destructive"
          size="icon"
          aria-label={`Delete ${props.label}`}
          onClick={() => props.onArchive(props.channel)}
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
  const [sidebar, setSidebar] = createSignal<HTMLElement>()
  const [editingRoom, setEditingRoom] = createSignal<RoomSummary | null>(null)
  const [renamingChannel, setRenamingChannel] = createSignal<ChannelSummary | null>(null)
  const [actionError, setActionError] = createSignal<string | null>(null)
  const agentById = createMemo(() => new Map(props.agents.map((agent) => [agent.id, agent])))
  const readStateByChannel = createMemo(
    () => new Map(props.readState.map((state) => [state.channelId, state]))
  )
  const hasUnread = () =>
    props.readState.some(
      (state) =>
        (state.topLevelUnreadCount ?? 0) + (state.threadUnreadCount ?? 0) > 0 ||
        Boolean(state.manuallyUnread)
    )
  const unreadBadge = (channelId: string) => {
    const state = readStateByChannel().get(channelId)
    const count = (state?.topLevelUnreadCount ?? 0) + (state?.threadUnreadCount ?? 0)
    return count || state?.manuallyUnread ? (
      <span class="conventional-unread-badge" aria-label={`${count || 1} unread`}>
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
  onMount(() => {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
    if (!Number.isFinite(stored) || stored <= 0) return
    const root = workspaceRootFor(sidebar())
    if (root) applySidebarWidth(root, stored)
  })

  const startResize = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    const root = workspaceRootFor(sidebar())
    const handle = event.currentTarget
    if (!root) return
    const startWidth = currentSidebarWidth(root)
    const startX = event.clientX
    let width = startWidth
    handle.setPointerCapture(event.pointerId)

    // The element is captured in a closure because the pointer target is only
    // valid for the duration of the event.
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
  }

  const resizeByKeyboard = (delta: number) => {
    const root = workspaceRootFor(sidebar())
    if (!root) return
    const width = clampSidebarWidth(currentSidebarWidth(root) + delta)
    applySidebarWidth(root, width)
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width))
  }

  const onResizeKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      resizeByKeyboard(-16)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      resizeByKeyboard(16)
    }
  }

  return (
    <>
      <SidebarToggleButton expanded={props.mobileOpen} onToggle={props.onToggleMobile} />
      <Show when={props.mobileOpen}>
        <button
          type="button"
          class="conventional-sidebar-scrim"
          aria-label="Close workspace navigation"
          onClick={() => props.onToggleMobile(false)}
        />
      </Show>
      <aside
        ref={setSidebar}
        class={`conventional-sidebar${props.mobileOpen ? ' conventional-sidebar--open' : ''}`}
        aria-label="Workspace navigation"
      >
        <div
          class="conventional-sidebar__resize"
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
          class="conventional-sidebar__close"
          onClick={() => props.onToggleMobile(false)}
        >
          <PanelLeftClose aria-hidden="true" />
        </button>

        <div class="conventional-sidebar__title">
          <h1>{props.workspaceName}</h1>
        </div>
        <div class="conventional-sidebar__quick-actions">
          <button type="button" onClick={() => props.onOpenTasks()}>
            <ListTodo aria-hidden="true" />
            Tasks
          </button>
          <button type="button" onClick={() => props.onOpenAgents()}>
            <Bot aria-hidden="true" />
            Agents
          </button>
          <Tooltip>
            <TooltipTrigger
              onClick={() => props.onMarkAllRead()}
              aria-label="Mark all read"
              disabled={!hasUnread()}
            >
              <MessageCircle aria-hidden="true" />
              Mark all read
              <kbd>⇧⌘A</kbd>
            </TooltipTrigger>
            <TooltipContent side="bottom">Mark all read (Mod+Shift+A)</TooltipContent>
          </Tooltip>
        </div>

        <div class="conventional-sidebar__scroll">
          <Show when={actionError()}>
            {(message) => (
              <p role="alert" class="conventional-sidebar-error">
                {message()}
              </p>
            )}
          </Show>
          <section class="conventional-sidebar-section" aria-labelledby="rooms-heading">
            <div class="conventional-sidebar-section__heading">
              <h2 id="rooms-heading">Rooms</h2>
              <button type="button" aria-label="Create Room" onClick={() => props.onCreateRoom()}>
                <Plus aria-hidden="true" />
              </button>
            </div>
            <Show
              when={props.navigation.rooms.length}
              fallback={
                <p class="conventional-sidebar-empty">Create a Room to organize the work.</p>
              }
            >
              <ul class="conventional-room-list">
                <For each={props.navigation.rooms}>
                  {(item) => {
                    const collapsed = () => props.collapsedRoomIds.includes(item.room.id)
                    const selected = () =>
                      Boolean(item.selectionChannelId) &&
                      (props.selectedChannelId === item.selectionChannelId ||
                        item.visibleChannels.some(({ id }) => id === props.selectedChannelId))
                    const roomChannels = () => [
                      ...(item.primaryChannel ? [item.primaryChannel] : []),
                      ...item.visibleChannels.filter(({ id }) => id !== item.primaryChannel?.id),
                    ]
                    const roomUnread = () =>
                      roomChannels().reduce((total, channel) => {
                        const state = readStateByChannel().get(channel.id)
                        return (
                          total +
                          (state?.topLevelUnreadCount ?? 0) +
                          (state?.threadUnreadCount ?? 0)
                        )
                      }, 0)
                    return (
                      <li>
                        <div class="conventional-room-row">
                          <button
                            type="button"
                            class="conventional-room-select"
                            aria-current={selected() ? 'page' : undefined}
                            onClick={() =>
                              item.selectionChannelId &&
                              props.onSelectChannel(item.selectionChannelId, item.room.id)
                            }
                          >
                            <RoomIcon functionKey={item.room.functionKey} />
                            <span class="conventional-room-name">{item.room.name}</span>
                            <Show when={roomUnread()}>
                              {(unread) => (
                                <span
                                  class="conventional-unread-badge"
                                  aria-label={`${unread()} unread in ${item.room.name}`}
                                >
                                  {unread() > 99 ? '99+' : unread()}
                                </span>
                              )}
                            </Show>
                          </button>
                          <span class="conventional-room-actions">
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                class={cn(buttonVariants({ variant: 'ghost', size: 'icon' }))}
                                aria-label={`Room options for ${item.room.name}`}
                              >
                                <EllipsisVertical aria-hidden="true" />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" side="bottom">
                                <DropdownMenuItem
                                  onSelect={() => {
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
                          <Show when={item.visibleChannels.length}>
                            <button
                              type="button"
                              class="conventional-room-toggle"
                              aria-label={`${collapsed() ? 'Expand' : 'Collapse'} ${item.room.name}`}
                              aria-expanded={!collapsed()}
                              onClick={() => props.onToggleRoom(item.room.id)}
                            >
                              <Show
                                when={!collapsed()}
                                fallback={<ChevronRight aria-hidden="true" />}
                              >
                                <ChevronDown aria-hidden="true" />
                              </Show>
                            </button>
                          </Show>
                        </div>
                        <Show when={item.visibleChannels.length && !collapsed()}>
                          <ul class="conventional-channel-list">
                            <For each={item.visibleChannels}>
                              {(channel) => (
                                <li>
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
                              )}
                            </For>
                          </ul>
                        </Show>
                      </li>
                    )
                  }}
                </For>
              </ul>
            </Show>
          </section>

          <section class="conventional-sidebar-section" aria-labelledby="conversations-heading">
            <div class="conventional-sidebar-section__heading">
              <h2 id="conversations-heading">Conversations</h2>
              <button
                type="button"
                aria-label="Create group conversation"
                onClick={() => props.onCreateGroup()}
              >
                <Plus aria-hidden="true" />
              </button>
            </div>
            <ul class="conventional-channel-list conventional-channel-list--standalone">
              <For each={props.navigation.directAgentChannels}>
                {(channel) => (
                  <ConversationChannelRow
                    channel={channel}
                    icon={<Bot aria-hidden="true" />}
                    label={
                      channel.agentId
                        ? (agentById().get(channel.agentId)?.name ?? 'Agent')
                        : 'Agent'
                    }
                    onArchive={archiveChannel}
                    onCopyLink={copyChannelLink}
                    onRename={setRenamingChannel}
                    onSelect={() => props.onSelectChannel(channel.id)}
                    selected={channel.id === props.selectedChannelId}
                    unread={unreadBadge(channel.id)}
                  />
                )}
              </For>
              <For each={props.navigation.groupChannels}>
                {(channel) => (
                  <ConversationChannelRow
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
                )}
              </For>
            </ul>
            <Show
              when={
                !props.navigation.directAgentChannels.length &&
                !props.navigation.groupChannels.length
              }
            >
              <button
                type="button"
                class="conventional-sidebar-empty-action"
                onClick={() => props.onOpenAgents()}
              >
                <MessageCircle aria-hidden="true" />
                Start with an Agent
              </button>
            </Show>
          </section>
        </div>
      </aside>
      <Show when={editingRoom()}>
        {(room) => (
          <EditRoomDialog
            busy={props.roomBusy}
            initialFunctionKey={room().functionKey}
            initialName={room().name}
            onClose={() => setEditingRoom(null)}
            onSave={(input) => props.onUpdateRoom(room().id, input)}
            open
            roomName={room().name}
          />
        )}
      </Show>
      <Show when={renamingChannel()}>
        {(channel) => (
          <RenameConversationDialog
            busy={props.channelBusy}
            initialTitle={channel().title}
            onClose={() => setRenamingChannel(null)}
            onSave={(title) => props.onRenameChannel(channel(), title)}
            open
          />
        )}
      </Show>
    </>
  )
}
