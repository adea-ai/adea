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
import { Button } from '@adea-ai/ui/components/ui/button'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@adea-ai/ui/components/ui/dropdown-menu'
import {
  SidebarNav,
  SidebarNavButton,
  SidebarNavContent,
  SidebarNavFooter,
  SidebarNavHeader,
  SidebarNavItem,
  SidebarNavResizeHandle,
  SidebarNavSection,
  SidebarNavTitle,
} from '@adea-ai/ui/components/layout/sidebar-nav'
import { cn } from '@adea-ai/app-ui/lib/utils'

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
  return (
    sidebar?.closest<HTMLElement>('.conventional-workspace, .workspace-shell--contextual') ?? null
  )
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
    <div class="conventional-sidebar__nav-row">
      <SidebarNavItem
        as="button"
        type="button"
        active={props.selected}
        trailing={props.unread}
        class="conventional-sidebar__nav-item"
        onClick={() => props.onSelect()}
        onPointerEnter={() => props.onIntent?.()}
        onFocus={() => props.onIntent?.()}
      >
        {props.icon}
        <span>{props.label}</span>
      </SidebarNavItem>
      <div class="conventional-sidebar__nav-actions">
        <DropdownMenu>
          <DropdownMenuTrigger
            as={ActionButton}
            variant="ghost"
            size="icon-md"
            tooltip={`Conversation options for ${props.label}`}
            aria-label={`Conversation options for ${props.label}`}
          >
            <EllipsisVertical aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            hideArrow
            placement="bottom-end"
            gutter={4}
            class="max-h-(--kb-popper-available-height) overflow-x-hidden overflow-y-auto"
          >
            <DropdownMenuItem onSelect={() => props.onRename(props.channel)}>
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => props.onCopyLink(props.channel)}>
              <Link2 aria-hidden="true" />
              Copy link
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ActionButton
          type="button"
          variant="destructive"
          size="icon-md"
          tooltip={`Delete ${props.label}`}
          aria-label={`Delete ${props.label}`}
          onClick={() => props.onArchive(props.channel)}
        >
          <X aria-hidden="true" />
        </ActionButton>
      </div>
    </div>
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
  onMarkAllRead: () => void | Promise<void>
  onOpenAgents: () => void
  onOpenTasks: () => void
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
  status?: JSX.Element
  workspaceReady?: boolean
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

  const updateSidebarWidth = (nextWidth: number) => {
    const root = workspaceRootFor(sidebar())
    if (!root) return
    const width = clampSidebarWidth(nextWidth)
    applySidebarWidth(root, width)
    setSidebarWidth(width)
  }

  const persistSidebarWidth = (nextWidth: number) => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(nextWidth)))
  }

  const markAllRead = () => {
    setActionError(null)
    void Promise.resolve()
      .then(() => props.onMarkAllRead())
      .catch(() => setActionError('Unread conversations could not be marked as read.'))
  }

  return (
    <>
      <SidebarToggleButton expanded={props.mobileOpen} onToggle={props.onToggleMobile} />
      <Show when={props.mobileOpen}>
        <Button
          type="button"
          class="conventional-sidebar-scrim"
          aria-label="Close workspace navigation"
          onClick={() => props.onToggleMobile(false)}
        />
      </Show>
      <SidebarNav
        as="aside"
        ref={setSidebar}
        class={cn('conventional-sidebar', {
          'conventional-sidebar--open': props.mobileOpen,
        })}
        aria-label="Workspace navigation"
      >
        {/* Focusable separator widget: keyboard-resizable, so it must expose
            its value range (axe aria-required-attr on focusable separators). */}
        <SidebarNavResizeHandle
          value={sidebarWidth()}
          minimum={SIDEBAR_MIN_WIDTH}
          maximum={SIDEBAR_MAX_WIDTH}
          step={16}
          label="Resize workspace navigation"
          class="conventional-sidebar__resize"
          onChange={updateSidebarWidth}
          onCommit={persistSidebarWidth}
        />
        <SidebarNavHeader>
          <SidebarNavTitle as="h1">{props.workspaceName}</SidebarNavTitle>
          <ActionButton
            type="button"
            variant="ghost"
            size="icon-md"
            tooltip="Close workspace navigation"
            aria-label="Close workspace navigation"
            class="conventional-sidebar__close"
            onClick={() => props.onToggleMobile(false)}
          >
            <PanelLeftClose aria-hidden="true" />
          </ActionButton>
        </SidebarNavHeader>

        <SidebarNavContent class="conventional-sidebar__content">
          <div class="conventional-sidebar__quick-actions">
            <SidebarNavButton type="button" onClick={() => props.onOpenTasks()}>
              <ListTodo aria-hidden="true" />
              Tasks
            </SidebarNavButton>
            <SidebarNavButton type="button" onClick={() => props.onOpenAgents()}>
              <Bot aria-hidden="true" />
              Agents
            </SidebarNavButton>
          </div>
          <Show when={actionError()}>
            {(message) => (
              <Alert variant="destructive" class="conventional-sidebar-error">
                <AlertDescription>{message()}</AlertDescription>
              </Alert>
            )}
          </Show>
          <Show when={props.status}>{props.status}</Show>
          <SidebarNavSection
            label="Rooms"
            headingAs="h2"
            role="region"
            aria-label="Rooms"
            action={
              <ActionButton
                type="button"
                variant="ghost"
                size="icon-md"
                tooltip="Create Room"
                aria-label="Create Room"
                disabled={props.workspaceReady === false}
                onClick={() => props.onCreateRoom()}
              >
                <Plus aria-hidden="true" />
              </ActionButton>
            }
          >
            <Show
              when={props.navigation.rooms.length}
              fallback={
                <EmptyDescription class="conventional-sidebar-empty">
                  Create a Room to organize the work.
                </EmptyDescription>
              }
            >
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
                    ...item().visibleChannels.filter(({ id }) => id !== item().primaryChannel?.id),
                  ]
                  const roomUnread = () =>
                    roomChannels().reduce((total, channel) => {
                      const state = readStateByChannel().get(channel.id)
                      return (
                        total + (state?.topLevelUnreadCount ?? 0) + (state?.threadUnreadCount ?? 0)
                      )
                    }, 0)
                  const channelRows = keyedRows(
                    () => item().visibleChannels,
                    (channel) => channel.id,
                    (previous, next) =>
                      previous.version === next.version && previous.updatedAt === next.updatedAt
                  )
                  return (
                    <div class="conventional-sidebar__room">
                      <div class="conventional-sidebar__nav-row">
                        <SidebarNavItem
                          as="button"
                          type="button"
                          active={selected()}
                          trailing={
                            roomUnread() ? (
                              <span
                                class="conventional-unread-badge"
                                aria-label={`${roomUnread()} unread in ${item().room.name}`}
                              >
                                {roomUnread() > 99 ? '99+' : roomUnread()}
                              </span>
                            ) : null
                          }
                          class="conventional-sidebar__nav-item"
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
                          <span>{item().room.name}</span>
                        </SidebarNavItem>
                        <div class="conventional-sidebar__nav-actions">
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              as={ActionButton}
                              variant="ghost"
                              size="icon-md"
                              tooltip={`Room options for ${item().room.name}`}
                              aria-label={`Room options for ${item().room.name}`}
                            >
                              <EllipsisVertical aria-hidden="true" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              hideArrow
                              placement="bottom-end"
                              gutter={4}
                              class="max-h-(--kb-popper-available-height) overflow-x-hidden overflow-y-auto"
                            >
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
                          <Show when={item().visibleChannels.length}>
                            <ActionButton
                              type="button"
                              variant="ghost"
                              size="icon-md"
                              tooltip={`${collapsed() ? 'Expand' : 'Collapse'} ${item().room.name}`}
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
                            </ActionButton>
                          </Show>
                        </div>
                      </div>
                      <Show when={item().visibleChannels.length && !collapsed()}>
                        <div class="conventional-sidebar__nav-nested">
                          <For each={channelRows()}>
                            {(channelEntry) => (
                              <SidebarNavItem
                                as="button"
                                type="button"
                                nested
                                active={channelEntry.item().id === props.selectedChannelId}
                                trailing={unreadBadge(channelEntry.item().id)}
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
                              </SidebarNavItem>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </Show>
          </SidebarNavSection>

          <SidebarNavSection
            label="Conversations"
            headingAs="h2"
            role="region"
            aria-label="Conversations"
            action={
              <ActionButton
                type="button"
                variant="ghost"
                size="icon-md"
                tooltip="Create group conversation"
                aria-label="Create group conversation"
                disabled={props.workspaceReady === false}
                onClick={() => props.onCreateGroup()}
              >
                <Plus aria-hidden="true" />
              </ActionButton>
            }
          >
            <div class="conventional-sidebar__nav-nested">
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
            </div>
            <Show
              when={
                !props.navigation.directAgentChannels.length &&
                !props.navigation.groupChannels.length
              }
            >
              <SidebarNavButton type="button" onClick={() => props.onOpenAgents()}>
                <MessageCircle aria-hidden="true" />
                Start with an Agent
              </SidebarNavButton>
            </Show>
          </SidebarNavSection>
        </SidebarNavContent>
        <SidebarNavFooter class="conventional-sidebar__read-actions">
          <SidebarNavButton
            type="button"
            aria-label="Mark all read"
            disabled={!hasUnread()}
            onClick={markAllRead}
          >
            <MessageCircle aria-hidden="true" />
            Mark all read
            <kbd>⇧⌘A</kbd>
          </SidebarNavButton>
        </SidebarNavFooter>
      </SidebarNav>
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
