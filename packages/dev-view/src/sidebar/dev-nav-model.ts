/*
 * The Dev projection into the shared Workspace › Project › Leaf tree
 * (ADR 0011). Pure data: no Solid, no DOM, no fetching. The Dev sidebar
 * feeds it what the cloud and the desktop runtime already report and renders
 * the result with the shared `WorkspaceNav`.
 *
 * - Projects come from the cloud project list (names and order). Each is
 *   joined by project id with its local repository binding from the register
 *   projection. A cloud project with no binding is a `none` source project; a
 *   binding with no cloud row is hidden and reported in `hiddenBindingIds`.
 *   Without a cloud list (fixtures, harnesses) the bindings render in
 *   projection order with their host-supplied names.
 * - A project's source is the projection's `source` (`local_repo`,
 *   `remote_only`, `none`); a remote-only project (managed bare clone) shows
 *   the cloud icon and never a checkout row.
 * - Leaves come from the worktree records (`dev.worktree.list`): the
 *   `primary` record is the checkout leaf labelled with the branch it has
 *   checked out; `managed` and `external` records are worktree leaves. A
 *   session bound to a worktree the list did not report still gets a leaf, so
 *   a failed or refused list never hides a live session.
 * - Leaf status is observed on the harness runs of the leaf's sessions
 *   (`leafActivity`); an idle leaf linked to a cloud task in review is
 *   `in_review`. Diff counts come from `dev.worktree.diffSummary`.
 * - Collapsed workspaces read the cloud account summary and the desktop
 *   `dev.summary.workspaces` counts; "Needs you" sums mentions and
 *   input-needing runs across every workspace.
 */
import type { TaskLifecycleState, WorkspaceAccentId, WorkspaceLogo } from '@adea-ai/types'
import type { HarnessRun, WorktreeKind } from '@adea-ai/types/dev-runtime'
import {
  sortProjectLeaves,
  type LeafStatus,
  type NavLeaf,
  type NavProject,
  type NavTree,
  type NavWorkspace,
} from '@adea-ai/workspace-nav/model'

import {
  devProjectDisplayName,
  type DevProjectNames,
  type DevProjectSource,
  type DevWorkspaceProjection,
} from '../platform'
import { leafActivity } from '../resources/leaf-activity'
import type { DevSessionBadgeState } from './badges'

/** The most worktree ids one `dev.worktree.diffSummary` call may name. */
export const DIFF_SUMMARY_BATCH_LIMIT = 50

export type DevNavWorkspaceInput = Readonly<{
  id: string
  name: string
  logo: WorkspaceLogo
  accent: WorkspaceAccentId | null
  sortOrder: number
}>

/** The cloud project facts the Dev sidebar shows: identity, name and order. */
export type DevNavCloudProject = Readonly<{
  id: string
  name: string
  sortOrder: number
  iconKey?: string
  sourceKind?: 'none' | 'repository'
}>

/** The `Worktree` fields the sidebar reads; fixtures supply the same shape. */
export type DevNavWorktreeRecord = Readonly<{
  id: string
  projectId: string
  kind: WorktreeKind
  repoId?: string
  branchRef?: string
  headRef?: string
  title?: string
  taskId?: string
  archived?: boolean
  generation?: number
  version?: number
  canonicalRoot?: string
  rootIdentity?: Readonly<{ device?: string; inode?: string; mtimeNs: string; size: string }>
}>

export type DevNavSession = Readonly<{
  id: string
  title: string
  worktreeId?: string
  terminalId?: string
  state:
    | 'preparing'
    | 'ready'
    | 'active'
    | 'disconnected'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'archived'
  generation?: number
  /** Fixture-only presentation state; production reads harness runs instead. */
  badges?: DevSessionBadgeState
}>

/** One local repository binding (or fixture project) with its sessions. */
export type DevNavBinding = Readonly<{
  id: string
  name: string
  repository: string
  /** The binding's default base ref, or empty when none is set. */
  branch: string
  version?: number
  repoIds?: readonly string[]
  /**
   * The projection's code source for this binding (`local_repo`,
   * `remote_only` for a managed bare clone with worktrees only, or `none`).
   * Absent only for fixtures, which are local checkouts.
   */
  source?: DevProjectSource
  sessions: readonly DevNavSession[]
  /** Fixture worktree records; production lists them from the runtime. */
  worktrees?: readonly DevNavWorktreeRecord[]
}>

export type DevNavRun = Pick<HarnessRun, 'runtimeSessionId' | 'state'>

export type DevNavAccountSummary = Readonly<{
  workspaceId: string
  unreadChannels: number
  mentions: number
}>

export type DevNavDevSummary = Readonly<{
  workspaceId: string
  running: number
  needsInput: number
}>

export type DevNavInput = Readonly<{
  activeWorkspaceId: string
  /** Every workspace the member belongs to; the active one is added when missing. */
  workspaces: readonly DevNavWorkspaceInput[]
  /** The active workspace's name when the list does not carry it. */
  activeWorkspaceName?: string
  /** The cloud project list; undefined renders the bindings unjoined. */
  cloudProjects?: readonly DevNavCloudProject[]
  bindings: readonly DevNavBinding[]
  worktrees: readonly DevNavWorktreeRecord[]
  runs: readonly DevNavRun[]
  diffs?: ReadonlyMap<string, Readonly<{ added: number; removed: number }>>
  /** Cloud task lifecycle by task id, for linked worktrees in review. */
  taskStates?: ReadonlyMap<string, TaskLifecycleState>
  accountSummary?: readonly DevNavAccountSummary[]
  devSummary?: readonly DevNavDevSummary[]
}>

/** What selecting a leaf opens: its worktree and the live sessions bound to it. */
export type DevNavLeafTarget = Readonly<{
  leafId: string
  projectId: string
  worktree?: DevNavWorktreeRecord
  /** Non-archived sessions on the leaf's worktree, in projection order. */
  sessions: readonly DevNavSession[]
}>

export type DevNavProjectEntry = Readonly<{
  cloud?: DevNavCloudProject
  binding?: DevNavBinding
}>

export type DevNavSource = Readonly<{
  tree: NavTree
  targets: ReadonlyMap<string, DevNavLeafTarget>
  projects: ReadonlyMap<string, DevNavProjectEntry>
  /** Bindings with no cloud project row: hidden from the tree. */
  hiddenBindingIds: readonly string[]
}>

// The register carries no timestamps for worktrees, so list order stands in
// for recency: a later record sorts first among a project's worktrees.
const EPOCH = Date.UTC(2000, 0, 1)
function orderTimestamp(index: number): string {
  return new Date(EPOCH + index * 1000).toISOString()
}

const fixtureRunState: Readonly<
  Record<NonNullable<DevSessionBadgeState['harness']>, HarnessRun['state'] | undefined>
> = {
  working: 'working',
  awaiting_input: 'awaiting_input',
  awaiting_approval: 'awaiting_approval',
  idle: undefined,
}

/** Fixture sessions describe their harness through badges; read them as runs. */
export function fixtureRuns(bindings: readonly DevNavBinding[]): DevNavRun[] {
  const runs: DevNavRun[] = []
  for (const binding of bindings)
    for (const session of binding.sessions) {
      const state = session.badges?.harness ? fixtureRunState[session.badges.harness] : undefined
      if (state) runs.push({ runtimeSessionId: session.id, state })
    }
  return runs
}

function leafStatus(
  runs: readonly DevNavRun[],
  sessions: readonly DevNavSession[],
  taskId: string | undefined,
  taskStates: DevNavInput['taskStates']
): LeafStatus {
  const activity = leafActivity(runs, sessions)
  if (activity !== 'idle') return activity
  if (taskId && taskStates?.get(taskId) === 'in_review') return 'in_review'
  return 'idle'
}

function bindingLeaves(
  binding: DevNavBinding,
  projectId: string,
  records: readonly DevNavWorktreeRecord[],
  input: DevNavInput,
  targets: Map<string, DevNavLeafTarget>
): NavLeaf[] {
  const liveSessions = binding.sessions.filter((session) => session.state !== 'archived')
  const sessionsOn = (worktreeId: string) =>
    liveSessions.filter((session) => session.worktreeId === worktreeId)
  const leaves: NavLeaf[] = []
  const covered = new Set<string>()

  // A remote-only project is a managed bare clone: worktrees only, never a
  // checkout row, whatever the list reports.
  const remoteOnly = binding.source === 'remote_only'
  records.forEach((record, index) => {
    if (record.archived) return
    if (remoteOnly && record.kind === 'primary') return
    covered.add(record.id)
    const sessions = sessionsOn(record.id)
    const checkout = record.kind === 'primary'
    // The checkout is labelled with what it actually has checked out.
    const branchRef = checkout
      ? (record.headRef ?? record.branchRef)
      : (record.branchRef ?? record.headRef)
    const diff = input.diffs?.get(record.id)
    targets.set(record.id, { leafId: record.id, projectId, worktree: record, sessions })
    leaves.push({
      id: record.id,
      kind: checkout ? 'checkout' : 'worktree',
      projectId,
      worktreeId: record.id,
      ...(record.taskId ? { taskId: record.taskId } : {}),
      ...(record.title ? { title: record.title } : {}),
      ...(branchRef ? { branchRef } : {}),
      status: leafStatus(input.runs, sessions, record.taskId, input.taskStates),
      ...(diff ? { diff: { added: diff.added, removed: diff.removed } } : {}),
      lastActivityAt: orderTimestamp(index),
    })
  })

  // A live session on a worktree the list did not report (a refused or
  // failed read, or a record not yet listed) keeps a leaf of its own.
  const orphanWorktrees = new Map<string, DevNavSession[]>()
  for (const session of liveSessions) {
    if (!session.worktreeId || covered.has(session.worktreeId)) continue
    const list = orphanWorktrees.get(session.worktreeId) ?? []
    list.push(session)
    orphanWorktrees.set(session.worktreeId, list)
  }
  let index = records.length
  for (const [worktreeId, sessions] of orphanWorktrees) {
    targets.set(worktreeId, { leafId: worktreeId, projectId, sessions })
    leaves.push({
      id: worktreeId,
      kind: 'worktree',
      projectId,
      worktreeId,
      title: sessions.at(-1)?.title ?? 'Session',
      status: leafStatus(input.runs, sessions, undefined, input.taskStates),
      lastActivityAt: orderTimestamp(index++),
    })
  }

  return sortProjectLeaves(leaves)
}

/** Build the Dev sidebar tree and its leaf lookups. */
export function buildDevNavSource(input: DevNavInput): DevNavSource {
  const targets = new Map<string, DevNavLeafTarget>()
  const entries = new Map<string, DevNavProjectEntry>()
  const recordsByProject = new Map<string, DevNavWorktreeRecord[]>()
  const fixtureRecords = input.bindings.flatMap((binding) => binding.worktrees ?? [])
  for (const record of [...input.worktrees, ...fixtureRecords]) {
    const list = recordsByProject.get(record.projectId) ?? []
    if (!list.some((existing) => existing.id === record.id)) list.push(record)
    recordsByProject.set(record.projectId, list)
  }
  const bindingsById = new Map(input.bindings.map((binding) => [binding.id, binding]))
  const hiddenBindingIds: string[] = []

  const projectFor = (
    id: string,
    name: string,
    sortOrder: number,
    binding: DevNavBinding | undefined,
    cloud: DevNavCloudProject | undefined
  ): NavProject => {
    entries.set(id, { ...(cloud ? { cloud } : {}), ...(binding ? { binding } : {}) })
    return {
      id,
      name,
      ...(cloud?.iconKey ? { iconKey: cloud.iconKey } : {}),
      source: binding ? (binding.source ?? 'local_repo') : 'none',
      sortOrder,
      leaves: binding
        ? bindingLeaves(binding, id, recordsByProject.get(id) ?? [], input, targets)
        : [],
    }
  }

  let projects: NavProject[]
  if (input.cloudProjects) {
    const cloudIds = new Set(input.cloudProjects.map((project) => project.id))
    for (const binding of input.bindings)
      if (!cloudIds.has(binding.id)) hiddenBindingIds.push(binding.id)
    projects = input.cloudProjects.map((cloud) =>
      projectFor(cloud.id, cloud.name, cloud.sortOrder, bindingsById.get(cloud.id), cloud)
    )
  } else {
    projects = input.bindings.map((binding, index) =>
      projectFor(binding.id, binding.name, index, binding, undefined)
    )
  }

  const accountById = new Map(
    (input.accountSummary ?? []).map((summary) => [summary.workspaceId, summary])
  )
  const devById = new Map((input.devSummary ?? []).map((summary) => [summary.workspaceId, summary]))
  const memberWorkspaces = input.workspaces.some(({ id }) => id === input.activeWorkspaceId)
    ? input.workspaces
    : [
        ...input.workspaces,
        {
          id: input.activeWorkspaceId,
          name: input.activeWorkspaceName ?? 'Workspace',
          logo: { kind: 'monogram' } as const,
          accent: null,
          sortOrder: input.workspaces.length,
        },
      ]

  let needsYou = 0
  const workspaces: NavWorkspace[] = memberWorkspaces.map((workspace) => {
    const account = accountById.get(workspace.id)
    const dev = devById.get(workspace.id)
    const mentions = account?.mentions ?? 0
    const needsInput = dev?.needsInput ?? 0
    needsYou += mentions + needsInput
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
      ...(workspace.id === input.activeWorkspaceId ? { projects } : {}),
    }
  })

  return {
    tree: { activeWorkspaceId: input.activeWorkspaceId, workspaces, needsYou },
    targets,
    projects: entries,
    hiddenBindingIds,
  }
}

/** The leaf that shows a session: the leaf of the session's worktree. */
export function leafIdForSession(
  source: Pick<DevNavSource, 'targets'>,
  sessionId: string | undefined
): string | undefined {
  if (!sessionId) return undefined
  for (const target of source.targets.values())
    if (target.sessions.some((session) => session.id === sessionId)) return target.leafId
  return undefined
}

/**
 * The session selecting a leaf opens: the current selection when it already
 * lives on the leaf, otherwise the leaf's most recent live session (the last
 * one the register lists). Undefined when the leaf has none yet.
 */
export function sessionForLeaf(
  target: Pick<DevNavLeafTarget, 'sessions'>,
  currentSessionId?: string
): string | undefined {
  if (currentSessionId && target.sessions.some((session) => session.id === currentSessionId))
    return currentSessionId
  return target.sessions.at(-1)?.id
}

/**
 * The worktree ids whose diff counts are on screen: worktree leaves of
 * expanded projects in the active workspace, in tree order, at most one
 * `dev.worktree.diffSummary` batch. Checkout rows show no diff counts, and a
 * leaf derived from a session (no listed record) has nothing to read.
 */
export function visibleDiffWorktreeIds(
  source: Pick<DevNavSource, 'tree' | 'targets'>,
  collapsedProjectIds: ReadonlySet<string>,
  limit = DIFF_SUMMARY_BATCH_LIMIT
): string[] {
  const tree = source.tree
  const active = tree.workspaces.find((workspace) => workspace.id === tree.activeWorkspaceId)
  const ids: string[] = []
  const projects = (active?.projects ?? []).toSorted(
    (left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name)
  )
  for (const project of projects) {
    if (collapsedProjectIds.has(project.id)) continue
    for (const leaf of project.leaves) {
      // Only listed records have a diff to read; a session-derived leaf has none.
      if (leaf.kind !== 'worktree' || !leaf.worktreeId) continue
      if (!source.targets.get(leaf.id)?.worktree) continue
      ids.push(leaf.worktreeId)
      if (ids.length >= limit) return ids
    }
  }
  return ids
}

/**
 * The register's flat projection as sidebar bindings, in projection order.
 * The label is the host-supplied cloud project name, or the short project id.
 */
export function devBindingsFromProjection(
  projection: DevWorkspaceProjection,
  names?: DevProjectNames
): DevNavBinding[] {
  return projection.projects.map((project) => ({
    id: project.id,
    name: devProjectDisplayName(project.id, names),
    repository: project.repoIds[0] ?? '',
    repoIds: project.repoIds,
    branch: project.branch,
    ...(project.source === undefined ? {} : { source: project.source }),
    ...(project.version === undefined ? {} : { version: project.version }),
    sessions: project.sessions,
  }))
}
