import type { AgentHqApiClient } from '@adea-ai/api-client'
import {
  settledData,
  useAccountSummaryQuery,
  useArchiveProjectMutation,
  useCreateWorkspaceMutation,
  useDeleteProjectMutation,
} from '@adea-ai/data'
import type {
  AgentSummary,
  ChannelReadStateSummary,
  ChannelSummary,
  ProjectSummary,
  TaskSummary,
  WorkspaceSummary,
} from '@adea-ai/types'
import { Bot, EllipsisVertical, Link2, MessageCircle, Plus, Users, X } from 'lucide-solid'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  onCleanup,
  onMount,
  Show,
  Suspense,
  type JSX,
} from 'solid-js'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
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
import { useWorkspaceState, wideViewportAtLoad, workspaceStore } from '@adea-ai/state'
import {
  createViewAdapter,
  type NavMenuItemId,
  type ViewAdapter,
} from '@adea-ai/workspace-nav/adapters'
import { sortWorkspaces, type NavLeaf, type NavProject } from '@adea-ai/workspace-nav/model'
import { WorkspaceNav } from '@adea-ai/workspace-nav/workspace-nav'

import { keyedRows } from './keyed-rows'
import { createProjectShare, ProjectShareHost, type ProjectShareContext } from './project-share'
import { createClientRequestId } from './request-id'
import { SidebarToggleButton } from './sidebar-toggle-button'
import type { WorkspaceNavigation } from './workspace-model'
import {
  buildWorkspaceNavSource,
  cloudLeafMenu,
  cloudProjectMenu,
  type DevWorkspaceSummary,
  type NavLeafTarget,
} from './workspace-nav-source'

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
const ConfirmActionDialog = lazy(() =>
  import('./create-workspace-dialogs').then((module) => ({
    default: module.ConfirmActionDialog,
  }))
)

/**
 * What the host that owns workspace switching (the integrated frame) hands
 * the sidebar. Without it the sidebar switches through the workspace store
 * and lists the bootstrap workspaces.
 */
export type WorkspaceNavHost = Readonly<{
  /** Every workspace the member belongs to, in their own order. */
  workspaces: readonly WorkspaceSummary[]
  /** Switch to a workspace: the host authorizes, resets context and routes the scene. */
  onSwitchWorkspace: (workspace: WorkspaceSummary) => void | Promise<unknown>
  /** Open Settings at its Workspace section; the header action hides without it. */
  onOpenWorkspaceSettings?: () => void
  /** The desktop cross-workspace Dev summary, when the host has one (ADR 0011). */
  devSummary?: readonly DevWorkspaceSummary[]
}>

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
  /** Chat or Virtual: the adapter's nouns (projects/tasks or rooms/desks). */
  view: 'chat' | 'virtual'
  client: AgentHqApiClient
  activeWorkspace: WorkspaceSummary | undefined
  host: WorkspaceNavHost
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
  readState: readonly ChannelReadStateSummary[]
  restoreFocusRef?: () => HTMLElement | undefined
  selectedChannelId: string | null
  tasks: readonly TaskSummary[]
  taskBusy: boolean
  onArchiveChannel: (channel: ChannelSummary) => Promise<void>
  onArchiveTask: (task: TaskSummary) => Promise<void>
  /** Fires on hover/focus of a channel affordance — prefetch before click. */
  onChannelIntent?: (channelId: string) => void
  onCreateGroup: () => void
  onCreateProject: () => void
  onMarkAllRead: () => void | Promise<void>
  onOpenAgents: () => void
  /** Open a task that has no conversation of its own (the task board). */
  onOpenTask: (task: TaskSummary) => void
  onRenameChannel: (channel: ChannelSummary, title: string) => Promise<void>
  onRenameTask: (task: TaskSummary, title: string) => Promise<void>
  onSelectChannel: (channelId: string, projectId?: string) => void
  onToggleMobile: (open: boolean) => void
  onToggleProject: (projectId: string) => void
  onUpdateProject: (
    projectId: string,
    update: Readonly<{ iconKey?: string; name?: string }>
  ) => Promise<void>
  projectBusy: boolean
  /**
   * Where the project Share dialog reads and writes (#1050); without it the
   * project menu offers no Share.
   */
  share?: ProjectShareContext
  status?: JSX.Element
  workspaceReady?: boolean
}>

type RenameTarget =
  | Readonly<{ kind: 'channel'; channel: ChannelSummary }>
  | Readonly<{ kind: 'task'; task: TaskSummary }>

type ConfirmTarget =
  | Readonly<{ kind: 'archive-project' | 'delete-project'; project: ProjectSummary }>
  | Readonly<{ kind: 'archive-leaf'; target: NavLeafTarget; label: string }>

const persistSidebarWidth = (nextWidth: number) => {
  window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(nextWidth)))
}

/** The task a leaf target carries, if any: rename and archive act on it first. */
function targetTask(target: NavLeafTarget): TaskSummary | undefined {
  return target.kind === 'task' ? target.task : target.task
}

/**
 * WorkspaceNavSidebar.
 *
 * The Chat and Virtual contextual sidebar (ADR 0011): the shared
 * `WorkspaceNav` accordion inside the resizable `ContextualSidebar` shell.
 * The active workspace is expanded with its projects, channels and tasks;
 * other workspaces are one row each with unread and mention chips, and
 * clicking one switches through the host. Conversations (direct and group)
 * stay global below the accordion.
 */
export function WorkspaceNavSidebar(props: Props) {
  const [sidebar, setSidebar] = createSignal<HTMLElement>()
  const [sidebarWidth, setSidebarWidth] = createSignal(SIDEBAR_DEFAULT_WIDTH)
  const [isNarrowViewport, setIsNarrowViewport] = createSignal(false)
  const [editingProject, setEditingProject] = createSignal<ProjectSummary | null>(null)
  const [renaming, setRenaming] = createSignal<RenameTarget | null>(null)
  const [confirming, setConfirming] = createSignal<ConfirmTarget | null>(null)
  const [actionError, setActionError] = createSignal<string | null>(null)
  const projectShare = createProjectShare()
  const [creatingWorkspace, setCreatingWorkspace] = createSignal(false)
  const [workspaceDraftError, setWorkspaceDraftError] = createSignal<string>()
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

  const workspaceId = () => props.activeWorkspace?.id ?? ''
  const accountSummary = useAccountSummaryQuery(props.client)
  const createWorkspace = useCreateWorkspaceMutation(props.client)
  const archiveProject = useArchiveProjectMutation(props.client, workspaceId)
  const deleteProject = useDeleteProjectMutation(props.client, workspaceId)

  const source = createMemo(() =>
    buildWorkspaceNavSource({
      activeWorkspaceId: workspaceId(),
      activeWorkspace: props.activeWorkspace,
      workspaces: props.host.workspaces,
      navigation: props.navigation,
      tasks: props.tasks,
      readState: props.readState,
      accountSummary: settledData(accountSummary),
      devSummary: props.host.devSummary,
    })
  )
  const baseAdapter = createMemo(() => createViewAdapter(props.view))
  const adapter = createMemo<ViewAdapter>(() => ({
    ...baseAdapter(),
    projectMenu: (project) =>
      cloudProjectMenu(baseAdapter(), project, { share: Boolean(props.share) }),
    leafMenu: cloudLeafMenu,
  }))
  const groupBy = useWorkspaceState((state) => state.sidebarGroupBy[workspaceId()] ?? 'project')
  const collapsedProjects = createMemo(() => new Set(props.collapsedProjectIds))

  const agentById = createMemo(() => new Map(props.agents.map((agent) => [agent.id, agent])))
  const readStateByChannel = createMemo(
    () => new Map(props.readState.map((state) => [state.channelId, state]))
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

  const copyLink = (params: Readonly<Record<string, string>>, failure: string) => {
    setActionError(null)
    const url = new URL(window.location.href)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    void navigator.clipboard.writeText(url.toString()).catch(() => setActionError(failure))
  }
  const copyChannelLink = (channel: ChannelSummary) =>
    copyLink({ channel: channel.id }, 'Conversation link could not be copied.')
  const archiveChannel = (channel: ChannelSummary) => {
    setActionError(null)
    void props
      .onArchiveChannel(channel)
      .catch(() => setActionError('Conversation could not be deleted.'))
  }

  const switchWorkspace = (nextWorkspaceId: string) => {
    const workspace = props.host.workspaces.find(({ id }) => id === nextWorkspaceId)
    if (workspace) void props.host.onSwitchWorkspace(workspace)
  }

  const createNamedWorkspace = (name: string) => {
    setWorkspaceDraftError(undefined)
    // A fresh idempotency key per attempt: a retry after a failure is a new
    // request, while a network replay of this one stays a single create.
    createWorkspace
      .mutateAsync({ idempotencyKey: createClientRequestId(), name, scene: 'home' })
      .then((result) => {
        setCreatingWorkspace(false)
        return props.host.onSwitchWorkspace(result.workspace)
      })
      .catch(() => setWorkspaceDraftError('Workspace could not be created. Try again.'))
  }

  // "Needs you" counts mentions across workspaces. Activating it takes the
  // user to the first other workspace with mentions; when only this one has
  // them, the Recent grouping brings the latest activity to the top.
  const openNeedsYou = () => {
    const next = sortWorkspaces(source().tree.workspaces).find(
      (workspace) =>
        workspace.id !== workspaceId() &&
        (workspace.summary.mentions ?? 0) + workspace.summary.needsYou > 0
    )
    if (next) switchWorkspace(next.id)
    else if (workspaceId()) workspaceStore.getState().setSidebarGroupBy(workspaceId(), 'recent')
  }

  const projectAction = (id: NavMenuItemId, project: NavProject) => {
    const summary = source().projects.get(project.id)
    if (!summary) return
    setActionError(null)
    if (id === 'rename' || id === 'settings') setEditingProject(summary)
    else if (id === 'share') projectShare.open(summary)
    else if (id === 'archive') setConfirming({ kind: 'archive-project', project: summary })
    else if (id === 'delete') setConfirming({ kind: 'delete-project', project: summary })
  }

  const leafAction = (id: NavMenuItemId, leaf: NavLeaf, project: NavProject) => {
    const target = source().targets.get(leaf.id)
    if (!target) return
    setActionError(null)
    const task = targetTask(target)
    if (id === 'rename') {
      if (task) setRenaming({ kind: 'task', task })
      else if (target.kind === 'channel') setRenaming({ kind: 'channel', channel: target.channel })
    } else if (id === 'copy-link') {
      if (target.kind === 'channel') copyChannelLink(target.channel)
      else copyLink({ task: target.task.id }, 'Task link could not be copied.')
    } else if (id === 'archive') {
      const label = adapter().leafLabel(leaf, project).text
      setConfirming({ kind: 'archive-leaf', target, label })
    }
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
    const closeSheet = () => {
      if (context.mobile) props.onToggleMobile(false)
    }
    const selectChannel = (channelId: string, projectId?: string) => {
      props.onSelectChannel(channelId, projectId)
      closeSheet()
    }
    const selectLeaf = (leaf: NavLeaf, project: NavProject) => {
      const target = source().targets.get(leaf.id)
      if (!target) return
      if (target.kind === 'channel') selectChannel(target.channel.id, project.id)
      else if (target.task.conversation.channelId)
        selectChannel(target.task.conversation.channelId, project.id)
      else {
        props.onOpenTask(target.task)
        closeSheet()
      }
    }
    const leafIntent = (leaf: NavLeaf) => {
      const target = source().targets.get(leaf.id)
      const channelId =
        target?.kind === 'channel' ? target.channel.id : target?.task.conversation.channelId
      if (channelId) props.onChannelIntent?.(channelId)
    }

    return (
      <WorkspaceNav
        label="Workspaces"
        tree={source().tree}
        adapter={adapter()}
        groupBy={groupBy()}
        onGroupByChange={(mode) => {
          if (workspaceId()) workspaceStore.getState().setSidebarGroupBy(workspaceId(), mode)
        }}
        selectedLeafId={props.selectedChannelId}
        onSelectLeaf={selectLeaf}
        onLeafIntent={leafIntent}
        onSelectWorkspace={switchWorkspace}
        onCreateWorkspace={createNamedWorkspace}
        creatingWorkspace={creatingWorkspace()}
        onCreatingWorkspaceChange={(creating) => {
          setCreatingWorkspace(creating)
          if (!creating) setWorkspaceDraftError(undefined)
        }}
        workspaceDraftError={workspaceDraftError()}
        workspaceDraftPending={createWorkspace.isPending}
        onCreateProject={props.workspaceReady === false ? undefined : () => props.onCreateProject()}
        onOpenWorkspaceSettings={
          props.host.onOpenWorkspaceSettings
            ? () => {
                props.host.onOpenWorkspaceSettings?.()
                closeSheet()
              }
            : undefined
        }
        onProjectMenuAction={projectAction}
        onLeafMenuAction={leafAction}
        collapsedProjectIds={collapsedProjects()}
        onProjectExpandedChange={(projectId, expanded) => {
          if (expanded === collapsedProjects().has(projectId)) props.onToggleProject(projectId)
        }}
        onNeedsYou={openNeedsYou}
        portalMount={menuMount()}
        tooltips={rowTooltips}
        quickActions={
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
          </>
        }
        conversations={
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
                    onRename={(channel) => setRenaming({ kind: 'channel', channel })}
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
                    onRename={(channel) => setRenaming({ kind: 'channel', channel })}
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
        }
      />
    )
  }

  const confirmCopy = (target: ConfirmTarget) => {
    const nouns = adapter().nouns
    if (target.kind !== 'archive-leaf') return projectConfirmCopy(target, nouns.project)
    const task = targetTask(target.target)
    return {
      title: `Archive ${target.label}?`,
      description: task
        ? 'The task leaves the sidebar and the board. Archived tasks cannot be moved back.'
        : 'The conversation leaves the sidebar.',
      confirmLabel: 'Archive',
      destructive: true,
      failure: task ? 'Task could not be archived.' : 'Conversation could not be archived.',
      run: () =>
        task
          ? props.onArchiveTask(task)
          : target.target.kind === 'channel'
            ? props.onArchiveChannel(target.target.channel)
            : Promise.resolve(),
    }
  }

  const projectConfirmCopy = (
    target: Extract<ConfirmTarget, { project: ProjectSummary }>,
    noun: string
  ) => {
    const nouns = { project: noun }
    // Delete is a soft delete: the project leaves every listing for good.
    if (target.kind === 'delete-project')
      return {
        title: `Delete ${target.project.name}?`,
        description: `The ${nouns.project.toLowerCase()} and its conversations leave every list. This cannot be undone.`,
        confirmLabel: `Delete ${nouns.project.toLowerCase()}`,
        destructive: true,
        failure: `${nouns.project} could not be deleted.`,
        run: () => deleteProject.mutateAsync(target.project.id).then(() => undefined),
      }
    return {
      title: `Archive ${target.project.name}?`,
      description: `The ${nouns.project.toLowerCase()} leaves the sidebar. Its history is kept.`,
      confirmLabel: `Archive ${nouns.project.toLowerCase()}`,
      destructive: false,
      failure: `${nouns.project} could not be archived.`,
      run: () => archiveProject.mutateAsync(target.project.id).then(() => undefined),
    }
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
        title={props.activeWorkspace?.name ?? 'Workspace'}
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
      <Show when={props.share}>
        {(context) => <ProjectShareHost context={context()} share={projectShare} />}
      </Show>
      <Suspense fallback={null}>
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
        <Show when={renaming()}>
          {(target) => {
            const current = target()
            return (
              <RenameConversationDialog
                busy={current.kind === 'task' ? props.taskBusy : props.channelBusy}
                initialTitle={current.kind === 'task' ? current.task.title : current.channel.title}
                noun={current.kind === 'task' ? 'task' : 'conversation'}
                onClose={() => setRenaming(null)}
                onSave={(title) =>
                  current.kind === 'task'
                    ? props.onRenameTask(current.task, title)
                    : props.onRenameChannel(current.channel, title)
                }
                open
              />
            )
          }}
        </Show>
        <Show when={confirming()}>
          {(target) => {
            const copy = confirmCopy(target())
            return (
              <ConfirmActionDialog
                busy={
                  archiveProject.isPending ||
                  deleteProject.isPending ||
                  props.taskBusy ||
                  props.channelBusy
                }
                title={copy.title}
                description={copy.description}
                confirmLabel={copy.confirmLabel}
                destructive={copy.destructive}
                failure={copy.failure}
                onClose={() => setConfirming(null)}
                onConfirm={copy.run}
              />
            )
          }}
        </Show>
      </Suspense>
    </>
  )
}
