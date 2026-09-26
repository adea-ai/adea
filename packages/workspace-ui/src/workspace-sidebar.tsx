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
import { createMemo, createSignal, For, lazy, onMount, Show, type JSX } from 'solid-js'
import { Button } from '@adea-ai/app-ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@adea-ai/app-ui/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@adea-ai/app-ui/components/ui/tooltip'

import { keyedRows } from './keyed-rows'
import type { WorkspaceNavigation } from './workspace-model'
import { RoomIcon } from './room-icon'
import { SidebarToggleButton } from './sidebar-toggle-button'

// The dialogs stay in their own dynamically imported module. A static import
// here pulled `create-workspace-dialogs` (and the dialog primitives it shares)
// into the workspace shell chunk, which silently defeated the lazy imports in
// `conventional-workspace-shell.tsx`: Rolldown reported the ineffective
// dynamic-import boundary in every build (see docs/decisions/0008).
const EditRoomDialog = lazy(() =>
  import('./create-workspace-dialogs').then((module) => ({ default: module.EditRoomDialog }))
)
const RenameConversationDialog = lazy(() =>
  import('./create-workspace-dialogs').then((module) => ({
    default: module.RenameConversationDialog,
  }))
)

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

/** Field-level channel equality for the keyed navigation rows. */
function sameChannels(
  previous: readonly ChannelSummary[],
  next: readonly ChannelSummary[]
): boolean {
  return (
    previous.length === next.length &&
    previous.every(
      (channel, index) =>
        channel.id === next[index]!.id &&
        channel.version === next[index]!.version &&
        channel.updatedAt === next[index]!.updatedAt
    )
  )
}

function ConversationChannelRow(props: {
  channel: ChannelSummary
  icon: JSX.Element
  label: string
  onArchive: (channel: ChannelSummary) => void
  onCopyLink: (channel: ChannelSummary) => void
  onIntent?: () => void
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
        onPointerEnter={() => props.onIntent?.()}
        onFocus={() => props.onIntent?.()}
      >
        {props.icon}
        <span>{props.label}</span>
        {props.unread}
      </button>
      <span class="conventional-channel-actions">
        <DropdownMenu>
          <DropdownMenuTrigger
            as={Button}
            variant="ghost"
            size="icon"
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
  /** Fires on hover/focus of a channel affordance — prefetch before click. */
  onChannelIntent?: (channelId: string) => void
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
  const [sidebarWidth, setSidebarWidth] = createSignal(SIDEBAR_DEFAULT_WIDTH)
  const [editingRoom, setEditingRoom] = createSignal<RoomSummary | null>(null)
  const [renamingChannel, setRenamingChannel] = createSignal<ChannelSummary | null>(null)
  const [actionError, setActionError] = createSignal<string | null>(null)
  const agentById = createMemo(() => new Map(props.agents.map((agent) => [agent.id, agent])))
  const readStateByChannel = createMemo(
    () => new Map(props.readState.map((state) => [state.channelId, state]))
  )
  // The navigation projection produces fresh wrapper objects on every rooms or
  // channels refetch. Keying on the stable ids keeps each row's DOM (menus,
  // hover, focus) alive and lets the per-row accessor push actual changes.
  const roomRows = keyedRows(
    () => props.navigation.rooms,
    (item) => item.room.id,
    (previous, next) =>
      previous.room.updatedAt === next.room.updatedAt &&
      previous.selectionChannelId === next.selectionChannelId &&
      previous.primaryChannel?.updatedAt === next.primaryChannel?.updatedAt &&
      sameChannels(previous.visibleChannels, next.visibleChannels)
  )
  const directChannelRows = keyedRows(
    () => props.navigation.directAgentChannels,
    (channel) => channel.id,
    (previous, next) => previous.version === next.version && previous.updatedAt === next.updatedAt
  )
  const groupChannelRows = keyedRows(
    () => props.navigation.groupChannels,
    (channel) => channel.id,
    (previous, next) => previous.version === next.version && previous.updatedAt === next.updatedAt
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
    if (!root) return
    applySidebarWidth(root, stored)
    setSidebarWidth(clampSidebarWidth(stored))
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
      setSidebarWidth(width)
    }
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onEnd)
      handle.removeEventListener('pointercancel', onEnd)
      applySidebarWidth(root, width)
      setSidebarWidth(width)
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
    setSidebarWidth(width)
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
        {/* Focusable separator widget: keyboard-resizable, so it must expose
            its value range (axe aria-required-attr on focusable separators). */}
        <div
          class="conventional-sidebar__resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize workspace navigation"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={sidebarWidth()}
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
                <For each={roomRows()}>
                  {(entry) => {
                    const item = () => entry.item()
                    const collapsed = () => props.collapsedRoomIds.includes(item().room.id)
                    const selected = () =>
                      Boolean(item().selectionChannelId) &&
                      (props.selectedChannelId === item().selectionChannelId ||
                        item().visibleChannels.some(({ id }) => id === props.selectedChannelId))
                    const roomChannels = () => [
                      ...(item().primaryChannel ? [item().primaryChannel!] : []),
                      ...item().visibleChannels.filter(
                        ({ id }) => id !== item().primaryChannel?.id
                      ),
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
                    const channelRows = keyedRows(
                      () => item().visibleChannels,
                      (channel) => channel.id,
                      (previous, next) =>
                        previous.version === next.version && previous.updatedAt === next.updatedAt
                    )
                    return (
                      <li>
                        <div class="conventional-room-row">
                          <button
                            type="button"
                            class="conventional-room-select"
                            aria-current={selected() ? 'page' : undefined}
                            onClick={() =>
                              item().selectionChannelId &&
                              props.onSelectChannel(item().selectionChannelId!, item().room.id)
                            }
                            onPointerEnter={() =>
                              item().selectionChannelId &&
                              props.onChannelIntent?.(item().selectionChannelId!)
                            }
                            onFocus={() =>
                              item().selectionChannelId &&
                              props.onChannelIntent?.(item().selectionChannelId!)
                            }
                          >
                            <RoomIcon functionKey={item().room.functionKey} />
                            <span class="conventional-room-name">{item().room.name}</span>
                            <Show when={roomUnread()}>
                              {(unread) => (
                                <span
                                  class="conventional-unread-badge"
                                  aria-label={`${unread()} unread in ${item().room.name}`}
                                >
                                  {unread() > 99 ? '99+' : unread()}
                                </span>
                              )}
                            </Show>
                          </button>
                          <span class="conventional-room-actions">
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                as={Button}
                                variant="ghost"
                                size="icon"
                                aria-label={`Room options for ${item().room.name}`}
                              >
                                <EllipsisVertical aria-hidden="true" />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" side="bottom">
                                <DropdownMenuItem
                                  onSelect={() => {
                                    setActionError(null)
                                    setEditingRoom(item().room)
                                  }}
                                >
                                  <Pencil aria-hidden="true" />
                                  Edit
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </span>
                          <Show when={item().visibleChannels.length}>
                            <button
                              type="button"
                              class="conventional-room-toggle"
                              aria-label={`${collapsed() ? 'Expand' : 'Collapse'} ${item().room.name}`}
                              aria-expanded={!collapsed()}
                              onClick={() => props.onToggleRoom(item().room.id)}
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
                        <Show when={item().visibleChannels.length && !collapsed()}>
                          <ul class="conventional-channel-list">
                            <For each={channelRows()}>
                              {(channelEntry) => (
                                <li>
                                  <button
                                    type="button"
                                    aria-current={
                                      channelEntry.item().id === props.selectedChannelId
                                        ? 'page'
                                        : undefined
                                    }
                                    onClick={() =>
                                      props.onSelectChannel(channelEntry.item().id, item().room.id)
                                    }
                                    onPointerEnter={() =>
                                      props.onChannelIntent?.(channelEntry.item().id)
                                    }
                                    onFocus={() => props.onChannelIntent?.(channelEntry.item().id)}
                                  >
                                    <Hash aria-hidden="true" />
                                    <span>{channelEntry.item().title}</span>
                                    {unreadBadge(channelEntry.item().id)}
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
              <For each={directChannelRows()}>
                {(entry) => (
                  <ConversationChannelRow
                    channel={entry.item()}
                    icon={<Bot aria-hidden="true" />}
                    label={
                      entry.item().agentId
                        ? (agentById().get(entry.item().agentId!)?.name ?? 'Agent')
                        : 'Agent'
                    }
                    onArchive={archiveChannel}
                    onCopyLink={copyChannelLink}
                    onRename={setRenamingChannel}
                    onIntent={() => props.onChannelIntent?.(entry.item().id)}
                    onSelect={() => props.onSelectChannel(entry.item().id)}
                    selected={entry.item().id === props.selectedChannelId}
                    unread={unreadBadge(entry.item().id)}
                  />
                )}
              </For>
              <For each={groupChannelRows()}>
                {(entry) => (
                  <ConversationChannelRow
                    channel={entry.item()}
                    icon={<Users aria-hidden="true" />}
                    label={entry.item().title}
                    onArchive={archiveChannel}
                    onCopyLink={copyChannelLink}
                    onRename={setRenamingChannel}
                    onIntent={() => props.onChannelIntent?.(entry.item().id)}
                    onSelect={() => props.onSelectChannel(entry.item().id)}
                    selected={entry.item().id === props.selectedChannelId}
                    unread={unreadBadge(entry.item().id)}
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
