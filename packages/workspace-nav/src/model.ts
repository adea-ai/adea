import type { WorkspaceAccentId, WorkspaceLogo } from '@adea-ai/types'

/**
 * The view-neutral Workspace › Project › Leaf hierarchy (ADR 0011). Everything
 * in this module is pure data: no Solid, no DOM, no fetching. Hosts project
 * their cloud and desktop sources into these shapes and the components render
 * them unchanged in the Dev, Chat and Virtual views.
 */

/** What a leaf needs from the user, in precedence order (first wins). */
export type LeafStatus = 'needs_you' | 'running' | 'in_review' | 'idle'

export const leafStatusOrder: readonly LeafStatus[] = ['needs_you', 'running', 'in_review', 'idle']

/** The words a status is announced and labelled with; colour is never the only signal. */
export const leafStatusLabel: Readonly<Record<LeafStatus, string>> = {
  needs_you: 'Needs you',
  running: 'Running',
  in_review: 'In review',
  idle: 'Idle',
}

export type LeafKind = 'checkout' | 'worktree' | 'task'

export type NavLeaf = Readonly<{
  /** Stable identity: the worktree id for checkout/worktree leaves, else the task id. */
  id: string
  kind: LeafKind
  projectId: string
  worktreeId?: string
  taskId?: string
  /** Task title (or worktree title) when one exists. */
  title?: string
  /** The branch as actually checked out. */
  branchRef?: string
  status: LeafStatus
  diff?: Readonly<{ added: number; removed: number }>
  pullRequest?: Readonly<{ number: number }>
  /**
   * Unread conversation activity on the leaf (Chat and Virtual): a count, or
   * a manual unread mark with no count. Absent or zero shows nothing.
   */
  unread?: Readonly<{ count: number; marked: boolean }>
  /** ISO-8601 timestamp of the latest activity. */
  lastActivityAt: string
}>

export type ProjectSource = 'none' | 'local_repo' | 'remote_only'

export type NavProject = Readonly<{
  id: string
  name: string
  iconKey?: string
  source: ProjectSource
  sortOrder: number
  leaves: readonly NavLeaf[]
}>

export type NavWorkspaceSummary = Readonly<{
  running: number
  needsYou: number
  unread: number
  /** Live mentions of the user (the cloud account summary); absent counts as zero. */
  mentions?: number
}>

export type NavWorkspace = Readonly<{
  id: string
  name: string
  logo: WorkspaceLogo
  accent: WorkspaceAccentId | null
  sortOrder: number
  summary: NavWorkspaceSummary
  /** Present for the active workspace only; collapsed workspaces read counts. */
  projects?: readonly NavProject[]
}>

export type NavTree = Readonly<{
  activeWorkspaceId: string
  workspaces: readonly NavWorkspace[]
  /**
   * What needs the user, summed across every workspace: input-needing runs in
   * Dev, mentions in Chat and Virtual. The "Needs you" strip hides at zero.
   */
  needsYou: number
}>

/** A worktree record, including the primary checkout (`kind: 'checkout'`). */
export type NavWorktreeInput = Readonly<{
  id: string
  projectId: string
  kind: 'checkout' | 'worktree'
  branchRef: string
  title?: string
  taskId?: string
  status: LeafStatus
  diff?: Readonly<{ added: number; removed: number }>
  pullRequest?: Readonly<{ number: number }>
  lastActivityAt: string
}>

/** A cloud task; it becomes its own leaf unless a worktree is linked to it. */
export type NavTaskInput = Readonly<{
  id: string
  projectId: string
  title: string
  status: LeafStatus
  pullRequest?: Readonly<{ number: number }>
  lastActivityAt: string
}>

const statusRank: Readonly<Record<LeafStatus, number>> = {
  needs_you: 0,
  running: 1,
  in_review: 2,
  idle: 3,
}

/** The more urgent of two statuses: needs_you > running > in_review > idle. */
export function strongerStatus(left: LeafStatus, right: LeafStatus): LeafStatus {
  return statusRank[left] <= statusRank[right] ? left : right
}

function laterTimestamp(left: string, right: string): string {
  return Date.parse(right) > Date.parse(left) ? right : left
}

function activityTime(leaf: NavLeaf): number {
  const time = Date.parse(leaf.lastActivityAt)
  return Number.isFinite(time) ? time : 0
}

/** Most recent first; ties fall back to id so the order is deterministic. */
export function compareByRecentActivity(left: NavLeaf, right: NavLeaf): number {
  return activityTime(right) - activityTime(left) || left.id.localeCompare(right.id)
}

/** Checkout first, then everything else most recent first. */
export function sortProjectLeaves(leaves: readonly NavLeaf[]): NavLeaf[] {
  return leaves.toSorted((left, right) => {
    if (left.kind === 'checkout' && right.kind !== 'checkout') return -1
    if (right.kind === 'checkout' && left.kind !== 'checkout') return 1
    return compareByRecentActivity(left, right)
  })
}

/**
 * Merge worktree records and tasks into leaves. A worktree that carries a
 * `taskId` and the task it names become one leaf: the title comes from the
 * task, the branch from the worktree, the status is the more urgent of the
 * two and the activity time the later. The checkout leaf is always first.
 */
export function mergeLeaves(
  worktrees: readonly NavWorktreeInput[],
  tasks: readonly NavTaskInput[]
): NavLeaf[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  const mergedTaskIds = new Set<string>()
  const leaves: NavLeaf[] = []

  for (const worktree of worktrees) {
    const task = worktree.taskId === undefined ? undefined : tasksById.get(worktree.taskId)
    if (task) mergedTaskIds.add(task.id)
    const pullRequest = worktree.pullRequest ?? task?.pullRequest
    const title = task?.title ?? worktree.title
    leaves.push({
      id: worktree.id,
      kind: worktree.kind,
      projectId: worktree.projectId,
      worktreeId: worktree.id,
      ...(task ? { taskId: task.id } : {}),
      ...(title === undefined ? {} : { title }),
      branchRef: worktree.branchRef,
      status: task ? strongerStatus(worktree.status, task.status) : worktree.status,
      ...(worktree.diff ? { diff: worktree.diff } : {}),
      ...(pullRequest ? { pullRequest } : {}),
      lastActivityAt: task
        ? laterTimestamp(worktree.lastActivityAt, task.lastActivityAt)
        : worktree.lastActivityAt,
    })
  }

  for (const task of tasks) {
    if (mergedTaskIds.has(task.id)) continue
    leaves.push({
      id: task.id,
      kind: 'task',
      projectId: task.projectId,
      taskId: task.id,
      title: task.title,
      status: task.status,
      ...(task.pullRequest ? { pullRequest: task.pullRequest } : {}),
      lastActivityAt: task.lastActivityAt,
    })
  }

  return sortProjectLeaves(leaves)
}

export type ProjectSummary = Readonly<{
  total: number
  needsYou: number
  running: number
  inReview: number
  idle: number
}>

export function projectSummary(project: Pick<NavProject, 'leaves'>): ProjectSummary {
  let needsYou = 0
  let running = 0
  let inReview = 0
  let idle = 0
  for (const leaf of project.leaves) {
    if (leaf.status === 'needs_you') needsYou += 1
    else if (leaf.status === 'running') running += 1
    else if (leaf.status === 'in_review') inReview += 1
    else idle += 1
  }
  return { total: project.leaves.length, needsYou, running, inReview, idle }
}

/** The one-line summary a collapsed project shows: the most urgent count only. */
export function projectCollapsedSummary(project: Pick<NavProject, 'leaves'>): string | undefined {
  const summary = projectSummary(project)
  if (summary.needsYou > 0) return `${summary.needsYou} needs you`
  if (summary.running > 0) return `${summary.running} running`
  return undefined
}

export type WorkspaceChipKind = 'needs_you' | 'running' | 'mention' | 'unread'

export type WorkspaceChip = Readonly<{ kind: WorkspaceChipKind; count: number; label: string }>

/**
 * Status chips for a collapsed workspace row, most urgent first: needs you,
 * running, mentions, unread. Zero counts are omitted.
 */
export function workspaceChips(workspace: Pick<NavWorkspace, 'summary'>): WorkspaceChip[] {
  const { needsYou, running, unread } = workspace.summary
  const mentions = workspace.summary.mentions ?? 0
  const chips: WorkspaceChip[] = []
  if (needsYou > 0)
    chips.push({ kind: 'needs_you', count: needsYou, label: `${needsYou} needs you` })
  if (running > 0) chips.push({ kind: 'running', count: running, label: `${running} running` })
  if (mentions > 0)
    chips.push({
      kind: 'mention',
      count: mentions,
      label: `${mentions} ${mentions === 1 ? 'mention' : 'mentions'}`,
    })
  if (unread > 0) chips.push({ kind: 'unread', count: unread, label: `${unread} unread` })
  return chips
}

/** Workspaces in the caller's own order. */
export function sortWorkspaces(workspaces: readonly NavWorkspace[]): NavWorkspace[] {
  return workspaces.toSorted(
    (left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name)
  )
}

export type NavGroupMode = 'project' | 'status' | 'recent'

export const navGroupModes: readonly Readonly<{
  mode: NavGroupMode
  label: string
  description: string
}>[] = [
  { mode: 'project', label: 'Project', description: 'Each project with its worktrees and tasks.' },
  { mode: 'status', label: 'Status', description: 'What needs you first, then running work.' },
  { mode: 'recent', label: 'Recent', description: 'Everything, most recent activity first.' },
]

/** A leaf outside its project's tree carries the project's name with it. */
export type NavLeafEntry = Readonly<{ leaf: NavLeaf; projectId: string; projectName: string }>

export type NavProjectGroup = Readonly<{ project: NavProject; leaves: readonly NavLeaf[] }>

export type NavStatusGroup = Readonly<{
  status: LeafStatus
  label: string
  items: readonly NavLeafEntry[]
}>

export type NavGrouping =
  | Readonly<{ mode: 'project'; projects: readonly NavProjectGroup[] }>
  | Readonly<{ mode: 'status'; groups: readonly NavStatusGroup[] }>
  | Readonly<{ mode: 'recent'; items: readonly NavLeafEntry[] }>

function sortProjects(projects: readonly NavProject[]): NavProject[] {
  return projects.toSorted(
    (left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name)
  )
}

function entries(projects: readonly NavProject[]): NavLeafEntry[] {
  return sortProjects(projects).flatMap((project) =>
    project.leaves.map((leaf) => ({ leaf, projectId: project.id, projectName: project.name }))
  )
}

function byRecent(left: NavLeafEntry, right: NavLeafEntry): number {
  return compareByRecentActivity(left.leaf, right.leaf)
}

/**
 * Group the active workspace's projects for one of the three sidebar modes:
 * `project` keeps the hierarchy (projects by sort order, checkout first then
 * most recent), `status` buckets every leaf by status in precedence order with
 * empty buckets omitted, and `recent` is one flat list, most recent first.
 */
export function groupTree(projects: readonly NavProject[], mode: NavGroupMode): NavGrouping {
  if (mode === 'project') {
    return {
      mode,
      projects: sortProjects(projects).map((project) => ({
        project,
        leaves: sortProjectLeaves(project.leaves),
      })),
    }
  }
  const all = entries(projects)
  if (mode === 'recent') return { mode, items: all.toSorted(byRecent) }
  return {
    mode,
    groups: leafStatusOrder
      .map((status) => ({
        status,
        label: leafStatusLabel[status],
        items: all.filter((entry) => entry.leaf.status === status).toSorted(byRecent),
      }))
      .filter((group) => group.items.length > 0),
  }
}

/** The active workspace, or undefined when the id names none of them. */
export function activeWorkspace(tree: NavTree): NavWorkspace | undefined {
  return tree.workspaces.find((workspace) => workspace.id === tree.activeWorkspaceId)
}
