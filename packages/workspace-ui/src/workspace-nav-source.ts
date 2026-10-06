import type {
  AccountSummary,
  ChannelReadStateSummary,
  ChannelSummary,
  ProjectSummary,
  TaskLifecycleState,
  TaskSummary,
  WorkspaceSummary,
} from '@adea-ai/types'
import type { NavMenuItem, ViewAdapter } from '@adea-ai/workspace-nav/adapters'
import {
  sortProjectLeaves,
  type LeafStatus,
  type NavLeaf,
  type NavProject,
  type NavTree,
  type NavWorkspace,
} from '@adea-ai/workspace-nav/model'

import type { ProjectNavigationItem, WorkspaceNavigation } from './workspace-model'

/**
 * The Chat and Virtual projection of the cloud workspace into the shared
 * Workspace › Project › Leaf tree (ADR 0011). Pure data: the sidebar component
 * feeds it query results and renders the result with `WorkspaceNav`.
 *
 * - Workspaces come in the member's own order with their name, logo and
 *   accent. Only the active workspace carries projects.
 * - A project's primary channel is its default leaf (`checkout` kind), which
 *   the Chat and Virtual adapters label with the project's name.
 * - The project's other channels and its open tasks are `task` leaves. A task
 *   linked to one of those channels is one leaf with the task's title.
 * - Leaf status is honest about what the cloud knows: a task in progress is
 *   running, a task in review is in review, everything else is idle. Unread
 *   conversation activity is a count on the leaf, not a status.
 * - Collapsed workspaces read the cloud account summary (unread channels and
 *   mentions). The desktop Dev summary arrives through `devSummary` once that
 *   source ships; until then running and needs-input counts are zero.
 */

/**
 * The desktop cross-workspace Dev summary (`dev.summary.workspaces`, ADR 0011).
 * It is not available in the web lane; hosts that have it pass it in.
 */
export type DevWorkspaceSummary = Readonly<{
  workspaceId: string
  running: number
  needsInput: number
}>

/** What selecting a leaf opens: a channel (optionally carrying its task) or a channel-less task. */
export type NavLeafTarget =
  | Readonly<{ kind: 'channel'; channel: ChannelSummary; task?: TaskSummary }>
  | Readonly<{ kind: 'task'; task: TaskSummary }>

export type WorkspaceNavSourceInput = Readonly<{
  activeWorkspaceId: string
  /** Every workspace the member belongs to; the active one is added when missing. */
  workspaces: readonly WorkspaceSummary[]
  activeWorkspace?: WorkspaceSummary
  navigation: WorkspaceNavigation
  tasks: readonly TaskSummary[]
  readState: readonly ChannelReadStateSummary[]
  accountSummary?: AccountSummary
  devSummary?: readonly DevWorkspaceSummary[]
}>

export type WorkspaceNavSource = Readonly<{
  tree: NavTree
  /** Leaf id → what it opens. */
  targets: ReadonlyMap<string, NavLeafTarget>
  /** Project id → the cloud project, for the row menus. */
  projects: ReadonlyMap<string, ProjectSummary>
}>

/** Tasks that have finished leave the sidebar; Kanban still lists them. */
const CLOSED_TASK_STATES: ReadonlySet<TaskLifecycleState> = new Set([
  'completed',
  'cancelled',
  'archived',
])

/** The leaf status a cloud task lifecycle maps to. */
export function taskLeafStatus(state: TaskLifecycleState): LeafStatus {
  if (state === 'in_progress') return 'running'
  if (state === 'in_review') return 'in_review'
  return 'idle'
}

function unreadFor(
  channelId: string,
  readState: ReadonlyMap<string, ChannelReadStateSummary>
): NavLeaf['unread'] {
  const state = readState.get(channelId)
  if (!state) return undefined
  const count = (state.topLevelUnreadCount ?? 0) + (state.threadUnreadCount ?? 0)
  if (count === 0 && !state.manuallyUnread) return undefined
  return { count, marked: Boolean(state.manuallyUnread) }
}

function laterOf(left: string, right: string): string {
  return Date.parse(right) > Date.parse(left) ? right : left
}

function projectLeaves(
  item: ProjectNavigationItem,
  openTasks: readonly TaskSummary[],
  readState: ReadonlyMap<string, ChannelReadStateSummary>,
  targets: Map<string, NavLeafTarget>
): NavLeaf[] {
  const project = item.project
  const checkoutChannel =
    item.primaryChannel ??
    item.visibleChannels.find(({ id }) => id === item.selectionChannelId) ??
    undefined
  const otherChannels = item.visibleChannels.filter(({ id }) => id !== checkoutChannel?.id)
  const tasksById = new Map(openTasks.map((task) => [task.id, task]))
  const taskForChannel = (channel: ChannelSummary) =>
    (channel.taskId ? tasksById.get(channel.taskId) : undefined) ??
    openTasks.find((task) => task.conversation.channelId === channel.id)
  const linkedTaskIds = new Set<string>()
  const leaves: NavLeaf[] = []

  if (checkoutChannel) {
    targets.set(checkoutChannel.id, { kind: 'channel', channel: checkoutChannel })
    const unread = unreadFor(checkoutChannel.id, readState)
    leaves.push({
      id: checkoutChannel.id,
      kind: 'checkout',
      projectId: project.id,
      status: 'idle',
      ...(unread ? { unread } : {}),
      lastActivityAt: checkoutChannel.updatedAt,
    })
  }

  for (const channel of otherChannels) {
    const task = taskForChannel(channel)
    if (task) linkedTaskIds.add(task.id)
    targets.set(channel.id, { kind: 'channel', channel, ...(task ? { task } : {}) })
    const unread = unreadFor(channel.id, readState)
    leaves.push({
      id: channel.id,
      kind: 'task',
      projectId: project.id,
      ...(task ? { taskId: task.id } : {}),
      title: task?.title ?? channel.title,
      status: task ? taskLeafStatus(task.lifecycleState) : 'idle',
      ...(unread ? { unread } : {}),
      lastActivityAt: task ? laterOf(channel.updatedAt, task.updatedAt) : channel.updatedAt,
    })
  }

  for (const task of openTasks) {
    if (task.projectId !== project.id || linkedTaskIds.has(task.id)) continue
    targets.set(task.id, { kind: 'task', task })
    leaves.push({
      id: task.id,
      kind: 'task',
      projectId: project.id,
      taskId: task.id,
      title: task.title,
      status: taskLeafStatus(task.lifecycleState),
      lastActivityAt: task.updatedAt,
    })
  }

  return sortProjectLeaves(leaves)
}

/** Build the sidebar tree and its leaf lookups from the cloud workspace data. */
export function buildWorkspaceNavSource(input: WorkspaceNavSourceInput): WorkspaceNavSource {
  const readState = new Map(input.readState.map((state) => [state.channelId, state]))
  const openTasks = input.tasks.filter(
    ({ lifecycleState }) => !CLOSED_TASK_STATES.has(lifecycleState)
  )
  const targets = new Map<string, NavLeafTarget>()
  const projectsById = new Map<string, ProjectSummary>()

  const projects: NavProject[] = input.navigation.projects.map((item) => {
    projectsById.set(item.project.id, item.project)
    return {
      id: item.project.id,
      name: item.project.name,
      iconKey: item.project.iconKey,
      source: item.project.sourceKind === 'repository' ? 'local_repo' : 'none',
      sortOrder: item.project.sortOrder,
      leaves: projectLeaves(item, openTasks, readState, targets),
    }
  })

  const accountById = new Map(
    (input.accountSummary?.workspaces ?? []).map((summary) => [summary.workspaceId, summary])
  )
  const devById = new Map((input.devSummary ?? []).map((summary) => [summary.workspaceId, summary]))

  const memberWorkspaces =
    input.activeWorkspace && !input.workspaces.some(({ id }) => id === input.activeWorkspace!.id)
      ? [...input.workspaces, input.activeWorkspace]
      : input.workspaces

  let needsYou = 0
  const workspaces: NavWorkspace[] = memberWorkspaces.map((workspace) => {
    const account = accountById.get(workspace.id)
    const dev = devById.get(workspace.id)
    const mentions = account?.mentions ?? 0
    const needsInput = dev?.needsInput ?? 0
    needsYou += mentions + needsInput
    const active = workspace.id === input.activeWorkspaceId
    return {
      id: workspace.id,
      name: workspace.name,
      logo: workspace.logo,
      accent: workspace.accent,
      sortOrder: workspace.sortOrder,
      summary: {
        running: dev?.running ?? 0,
        needsYou: needsInput,
        unread: account?.unreadChannels ?? 0,
        mentions,
      },
      ...(active ? { projects } : {}),
    }
  })

  return {
    tree: { activeWorkspaceId: input.activeWorkspaceId, workspaces, needsYou },
    targets,
    projects: projectsById,
  }
}

/**
 * The project row menu for Chat and Virtual: the adapter's items, with Share
 * offered only when the host can share (the dialog ships separately).
 */
export function cloudProjectMenu(
  adapter: ViewAdapter,
  project: NavProject,
  options: Readonly<{ share: boolean }>
): readonly NavMenuItem[] {
  return adapter.projectMenu(project).filter((item) => item.id !== 'share' || options.share)
}

/**
 * The leaf row menu for Chat and Virtual. Only actions the cloud supports are
 * offered: the default (primary channel) leaf can only copy its link; other
 * leaves rename, copy a link and archive. There is no task or channel hard
 * delete and no leaf sharing yet, so neither is shown.
 */
export function cloudLeafMenu(leaf: NavLeaf): readonly NavMenuItem[] {
  if (leaf.kind === 'checkout') return [{ id: 'copy-link', label: 'Copy link' }]
  return [
    { id: 'rename', label: 'Rename' },
    { id: 'copy-link', label: 'Copy link' },
    { id: 'archive', label: 'Archive', separatorBefore: true },
  ]
}
