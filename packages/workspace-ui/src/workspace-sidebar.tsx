import type {
  AgentSummary,
  ChannelReadStateSummary,
  ChannelSummary,
  ProjectSummary,
} from '@adea-ai/types'
import {
  Bot,
  ChevronDown,
  ChevronRight,
  EllipsisVertical,
  Hash,
  Link2,
  MessageCircle,
  Pencil,
  Plus,
  Share2,
  Users,
  X,
} from 'lucide-solid'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from 'solid-js'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import {
  ContextualSidebar,
  type ContextualSidebarRenderContext,
} from '@adea-ai/ui/components/layout/contextual-sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@adea-ai/ui/components/ui/dropdown-menu'
import {
  SidebarNavButton,
  SidebarNavItem,
  SidebarNavLabel,
  SidebarNavRow,
  SidebarNavSection,
} from '@adea-ai/ui/components/layout/sidebar-nav'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { KbdChord } from '@adea-ai/ui/components/ui/kbd'
import { wideViewportAtLoad } from '@adea-ai/state'

import { keyedRows } from './keyed-rows'
import type { WorkspaceNavigation } from './workspace-model'
import { ProjectIcon } from './project-icon'
import { createProjectShare, ProjectShareHost, type ProjectShareContext } from './project-share'
import { SidebarToggleButton } from './sidebar-toggle-button'

// The dialogs stay in their own dynamically imported module. A static import
// here pulled `create-workspace-dialogs` (and the dialog primitives it shares)
// into the workspace shell chunk, which silently defeated the lazy imports in
// `conventional-workspace-shell.tsx`: Rolldown reported the ineffective
// dynamic-import boundary in every build (see docs/decisions/0008).
const EditProjectDialog = lazy(() =>
  import('./create-workspace-dialogs').then((module) => ({ default: module.EditProjectDialog }))
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
    // The toolbar and each contextual sidebar inherit one width from the shell.
    sidebar?.closest<HTMLElement>('.workspace-frame') ??
    sidebar?.closest<HTMLElement>('.workspace-shell--contextual, .conventional-workspace') ??
    null
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
  /** Row menus mount inside the mobile sheet so they stay in its a11y tree. */
  portalMount?: HTMLElement
  /**
   * The modal sheet omits row tooltips: a focus tooltip inside the sheet
   * registers a top-most dismissable layer that swallows the next Escape and
   * leaves the navigation stuck open. Accessible names carry the actions.
   */
  tooltips?: boolean
  /** The compact sheet drops the comfortable rung so row labels keep room. */
  touchTarget?: 'comfortable'
}) {
  const optionsTooltip = () =>
    props.tooltips === false ? undefined : `Conversation options for ${props.label}`
  const deleteTooltip = () => (props.tooltips === false ? undefined : `Delete ${props.label}`)
  return (
    <SidebarNavRow
      actions={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger
              as={ActionButton}
              variant="ghost"
              size="icon-md"
              touchTarget={props.touchTarget}
              tooltip={optionsTooltip()}
              aria-label={`Conversation options for ${props.label}`}
            >
              <EllipsisVertical aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              hideArrow
              placement="bottom-end"
              gutter={4}
              portalMount={props.portalMount}
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
            touchTarget={props.touchTarget}
            tooltip={deleteTooltip()}
            aria-label={`Delete ${props.label}`}
            onClick={() => props.onArchive(props.channel)}
          >
            <X aria-hidden="true" />
          </ActionButton>
        </>
      }
    >
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
        <SidebarNavLabel>{props.label}</SidebarNavLabel>
      </SidebarNavItem>
    </SidebarNavRow>
  )
}

type Props = Readonly<{
  agents: readonly AgentSummary[]
  /**
   * The footer's archived-items affordance (the Dev archived-sessions shelf
   * pattern). Views without an archived surface omit it, and the footer
   * disappears with it.
   */
  archiveAction?: JSX.Element
  channelBusy: boolean
  collapsedProjectIds: readonly string[]
  mobileOpen: boolean
  navigation: WorkspaceNavigation
  restoreFocusRef?: () => HTMLElement | undefined
  onArchiveChannel: (channel: ChannelSummary) => Promise<void>
  onCreateGroup: () => void
  onCreateProject: () => void
  onMarkAllRead: () => void | Promise<void>
  onOpenAgents: () => void
  /** Fires on hover/focus of a channel affordance — prefetch before click. */
  onChannelIntent?: (channelId: string) => void
  onRenameChannel: (channel: ChannelSummary, title: string) => Promise<void>
  onSelectChannel: (channelId: string, projectId?: string) => void
  onToggleMobile: (open: boolean) => void
  onToggleProject: (projectId: string) => void
  onUpdateProject: (
    projectId: string,
    update: Readonly<{ iconKey?: string; name?: string }>
  ) => Promise<void>
  projectBusy: boolean
  selectedChannelId: string | null
  readState: readonly ChannelReadStateSummary[]
  /** Where the project Share dialog reads and writes; omitted hosts hide Share. */
  share?: ProjectShareContext
  status?: JSX.Element
  workspaceReady?: boolean
  workspaceName: string
}>

const persistSidebarWidth = (nextWidth: number) => {
  window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(nextWidth)))
}

export function WorkspaceSidebar(props: Props) {
  const [sidebar, setSidebar] = createSignal<HTMLElement>()
  const [sidebarWidth, setSidebarWidth] = createSignal(SIDEBAR_DEFAULT_WIDTH)
  const [isNarrowViewport, setIsNarrowViewport] = createSignal(false)
  const [editingProject, setEditingProject] = createSignal<ProjectSummary | null>(null)
  const [renamingChannel, setRenamingChannel] = createSignal<ChannelSummary | null>(null)
  const [actionError, setActionError] = createSignal<string | null>(null)
  const projectShare = createProjectShare()
  // The inline panel is unmounted below 48rem, so the host root only becomes
  // observable once the desktop aside mounts (or after a narrow-to-wide
  // reparent). Deriving it keeps resize and restore working across that swap;
  // the first paint at a narrow viewport mounts and immediately detaches the
  // inline aside before the media query resolves, so only a connected node
  // names the root.
  const [rootTick, setRootTick] = createSignal(0)
  const workspaceRoot = createMemo(() => {
    const element = sidebar()
    void rootTick()
    return element?.isConnected ? workspaceRootFor(element) : null
  })
  const agentById = createMemo(() => new Map(props.agents.map((agent) => [agent.id, agent])))
  const readStateByChannel = createMemo(
    () => new Map(props.readState.map((state) => [state.channelId, state]))
  )
  // The navigation projection produces fresh wrapper objects on every projects or
  // channels refetch. Keying on the stable ids keeps each row's DOM (menus,
  // hover, focus) alive and lets the per-row accessor push actual changes.
  const projectRows = keyedRows(
    () => props.navigation.projects,
    (item) => item.project.id,
    (previous, next) =>
      previous.project.updatedAt === next.project.updatedAt &&
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
    // aria-hidden: the row button's accessible name stays the channel name;
    // unread counts are surfaced by the row's own unread state.
    return count || state?.manuallyUnread ? (
      <span class="conventional-unread-badge" aria-hidden="true">
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

  // Restore the persisted sidebar width as soon as the layout root exists —
  // including after a mobile-to-desktop reparent, when the inline panel mounts
  // for the first time.
  createEffect(() => {
    const root = workspaceRoot()
    if (!root) return
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
    if (!Number.isFinite(stored) || stored <= 0) return
    applySidebarWidth(root, stored)
    setSidebarWidth(clampSidebarWidth(stored))
  })

  onMount(() => {
    const media = window.matchMedia('(max-width: 48rem)')
    const updateViewport = () => setIsNarrowViewport(media.matches)
    setIsNarrowViewport(media.matches)
    media.addEventListener('change', updateViewport)
    onCleanup(() => media.removeEventListener('change', updateViewport))
  })

  const updateSidebarWidth = (nextWidth: number) => {
    const root = workspaceRoot()
    if (!root) return
    const width = clampSidebarWidth(nextWidth)
    applySidebarWidth(root, width)
    setSidebarWidth(width)
  }

  const markAllRead = () => {
    setActionError(null)
    void Promise.resolve()
      .then(() => props.onMarkAllRead())
      .catch(() => setActionError('Unread conversations could not be marked as read.'))
  }

  const renderSidebarContent = (context: ContextualSidebarRenderContext) => {
    // Modal dialogs hide everything outside their content from the
    // accessibility tree, so row menus use the shared sheet's connected mount.
    const menuMount = () => (context.mobile ? context.portalMount() : undefined)
    // The sheet gives row actions a third of the width the inline panel has;
    // dropping the comfortable rung there keeps the labels legible.
    const rowTouchTarget = context.mobile ? undefined : ('comfortable' as const)
    // The sheet also drops action tooltips: their focus layer swallows the
    // Escape that should dismiss the sheet itself.
    const rowTooltips = !context.mobile
    const selectChannel = (channelId: string, projectId?: string) => {
      props.onSelectChannel(channelId, projectId)
      if (context.mobile) props.onToggleMobile(false)
    }

    return (
      <>
        <div class="conventional-sidebar__quick-actions">
          <SidebarNavButton type="button" onClick={() => props.onOpenAgents()}>
            <Bot aria-hidden="true" />
            Agents
          </SidebarNavButton>
          <SidebarNavButton
            type="button"
            aria-label="Mark all read"
            aria-keyshortcuts="Meta+Shift+A"
            disabled={!hasUnread()}
            onClick={markAllRead}
          >
            <MessageCircle aria-hidden="true" />
            Mark all read
            <KbdChord keys="⇧⌘A" size="compact" class="ml-auto" />
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
          label="Projects"
          headingAs="h2"
          role="region"
          aria-label="Projects"
          action={
            <ActionButton
              type="button"
              variant="ghost"
              size="icon-md"
              touchTarget="comfortable"
              tooltip={rowTooltips ? 'Create a project' : undefined}
              aria-label="Create Project"
              disabled={props.workspaceReady === false}
              onClick={() => props.onCreateProject()}
            >
              <Plus aria-hidden="true" />
            </ActionButton>
          }
        >
          <Show
            when={props.navigation.projects.length}
            fallback={
              <EmptyDescription class="conventional-sidebar-empty">
                Create a Project to organize the work.
              </EmptyDescription>
            }
          >
            <For each={projectRows()}>
              {(entry) => {
                const item = () => entry.item()
                const collapsed = () => props.collapsedProjectIds.includes(item().project.id)
                const selected = () =>
                  Boolean(item().selectionChannelId) &&
                  (props.selectedChannelId === item().selectionChannelId ||
                    item().visibleChannels.some(({ id }) => id === props.selectedChannelId))
                const projectChannels = () => [
                  ...(item().primaryChannel ? [item().primaryChannel!] : []),
                  ...item().visibleChannels.filter(({ id }) => id !== item().primaryChannel?.id),
                ]
                const projectUnread = () =>
                  projectChannels().reduce((total, channel) => {
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
                  <div class="conventional-sidebar__project">
                    <SidebarNavRow
                      actions={
                        <>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              as={ActionButton}
                              variant="ghost"
                              size="icon-md"
                              touchTarget={rowTouchTarget}
                              tooltip={
                                rowTooltips
                                  ? `Project options for ${item().project.name}`
                                  : undefined
                              }
                              aria-label={`Project options for ${item().project.name}`}
                            >
                              <EllipsisVertical aria-hidden="true" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              hideArrow
                              placement="bottom-end"
                              gutter={4}
                              portalMount={menuMount()}
                              class="max-h-(--kb-popper-available-height) overflow-x-hidden overflow-y-auto"
                            >
                              <DropdownMenuItem
                                onSelect={() => {
                                  setActionError(null)
                                  setEditingProject(item().project)
                                }}
                              >
                                <Pencil aria-hidden="true" />
                                Edit
                              </DropdownMenuItem>
                              <Show when={props.share}>
                                <DropdownMenuItem
                                  onSelect={() => {
                                    setActionError(null)
                                    projectShare.open(item().project)
                                  }}
                                >
                                  <Share2 aria-hidden="true" />
                                  Share
                                </DropdownMenuItem>
                              </Show>
                            </DropdownMenuContent>
                          </DropdownMenu>
                          <Show when={item().visibleChannels.length}>
                            <ActionButton
                              type="button"
                              variant="ghost"
                              size="icon-md"
                              touchTarget={rowTouchTarget}
                              tooltip={
                                rowTooltips
                                  ? `${collapsed() ? 'Expand' : 'Collapse'} ${item().project.name}`
                                  : undefined
                              }
                              aria-label={`${collapsed() ? 'Expand' : 'Collapse'} ${item().project.name}`}
                              aria-expanded={!collapsed()}
                              onClick={() => props.onToggleProject(item().project.id)}
                            >
                              <Show
                                when={!collapsed()}
                                fallback={<ChevronRight aria-hidden="true" />}
                              >
                                <ChevronDown aria-hidden="true" />
                              </Show>
                            </ActionButton>
                          </Show>
                        </>
                      }
                    >
                      <SidebarNavItem
                        as="button"
                        type="button"
                        active={selected()}
                        // aria-hidden: keep the row button's accessible
                        // name exactly the project name.
                        trailing={
                          projectUnread() ? (
                            <span class="conventional-unread-badge" aria-hidden="true">
                              {projectUnread() > 99 ? '99+' : projectUnread()}
                            </span>
                          ) : null
                        }
                        class="conventional-sidebar__nav-item"
                        onClick={() =>
                          item().selectionChannelId &&
                          selectChannel(item().selectionChannelId!, item().project.id)
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
                        <ProjectIcon iconKey={item().project.iconKey} />
                        <SidebarNavLabel>{item().project.name}</SidebarNavLabel>
                      </SidebarNavItem>
                    </SidebarNavRow>
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
                                selectChannel(channelEntry.item().id, item().project.id)
                              }
                              onPointerEnter={() => props.onChannelIntent?.(channelEntry.item().id)}
                              onFocus={() => props.onChannelIntent?.(channelEntry.item().id)}
                            >
                              <Hash aria-hidden="true" />
                              <SidebarNavLabel>{channelEntry.item().title}</SidebarNavLabel>
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
              touchTarget="comfortable"
              tooltip={rowTooltips ? 'Create a group conversation' : undefined}
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
                  onSelect={() => selectChannel(entry.item().id)}
                  selected={entry.item().id === props.selectedChannelId}
                  unread={unreadBadge(entry.item().id)}
                  portalMount={menuMount()}
                  tooltips={rowTooltips}
                  touchTarget={rowTouchTarget}
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
                  onSelect={() => selectChannel(entry.item().id)}
                  selected={entry.item().id === props.selectedChannelId}
                  unread={unreadBadge(entry.item().id)}
                  portalMount={menuMount()}
                  tooltips={rowTooltips}
                  touchTarget={rowTouchTarget}
                />
              )}
            </For>
          </div>
          <Show
            when={
              !props.navigation.directAgentChannels.length && !props.navigation.groupChannels.length
            }
          >
            <SidebarNavButton type="button" onClick={() => props.onOpenAgents()}>
              <MessageCircle aria-hidden="true" />
              Start with an Agent
            </SidebarNavButton>
          </Show>
        </SidebarNavSection>
      </>
    )
  }

  return (
    <>
      <Show when={isNarrowViewport()}>
        <SidebarToggleButton
          expanded={props.mobileOpen}
          onOpen={() => props.onToggleMobile(true)}
        />
      </Show>
      <ContextualSidebar
        label="Workspace navigation"
        title={props.workspaceName}
        headingAs="h1"
        open={props.mobileOpen}
        onOpenChange={props.onToggleMobile}
        width={sidebarWidth()}
        minimum={SIDEBAR_MIN_WIDTH}
        maximum={SIDEBAR_MAX_WIDTH}
        step={16}
        wideViewportAtLoad={wideViewportAtLoad}
        resizeLabel="Resize workspace navigation"
        restoreFocusRef={props.restoreFocusRef}
        onSidebarElement={(element, mobile) => {
          if (mobile) return
          setSidebar(element)
          if (element) queueMicrotask(() => setRootTick((tick) => tick + 1))
        }}
        sidebarClass={cn('conventional-sidebar conventional-sidebar--inline', {
          'conventional-sidebar--open': props.mobileOpen,
        })}
        sheetClass="conventional-sidebar-sheet"
        contentClass="conventional-sidebar__content"
        footerClass="conventional-sidebar__footer-action"
        content={renderSidebarContent}
        footer={props.archiveAction ? () => props.archiveAction : undefined}
        onWidthChange={updateSidebarWidth}
        onWidthCommit={persistSidebarWidth}
      />
      <Show when={editingProject()}>
        {(project) => (
          <EditProjectDialog
            busy={props.projectBusy}
            initialIconKey={project().iconKey}
            initialName={project().name}
            onClose={() => setEditingProject(null)}
            onSave={(input) => props.onUpdateProject(project().id, input)}
            open
            projectName={project().name}
          />
        )}
      </Show>
      <Show when={props.share}>
        {(context) => <ProjectShareHost context={context()} share={projectShare} />}
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
