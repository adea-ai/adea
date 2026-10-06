import { describe, expect, test } from 'bun:test'
import { sidebarGroupModes } from '@adea-ai/types'

import {
  navGroupModes,
  nextWorkspaceNeedingYou,
  stabilizeNavTree,
  type NavLeaf,
  type NavProject,
  type NavTree,
  type NavWorkspace,
} from '../../src/model'

const ACTIVE = 'workspace-active'

const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 10, 0) + minute * 60_000).toISOString()

function leaf(id: string, projectId: string, overrides: Partial<NavLeaf> = {}): NavLeaf {
  return {
    id,
    kind: 'worktree',
    projectId,
    worktreeId: id,
    branchRef: `branch/${id}`,
    status: 'idle',
    lastActivityAt: at(0),
    ...overrides,
  }
}

function project(id: string, leaves: readonly NavLeaf[]): NavProject {
  return { id, name: `Project ${id}`, source: 'local_repo', sortOrder: 0, leaves }
}

function workspace(id: string, overrides: Partial<NavWorkspace> = {}): NavWorkspace {
  return {
    id,
    name: `Workspace ${id}`,
    logo: { kind: 'monogram' } as NavWorkspace['logo'],
    accent: null,
    sortOrder: 0,
    summary: { running: 0, needsYou: 0, unread: 0 },
    ...overrides,
  }
}

type BuildOptions = Readonly<{
  activeSummary?: NavWorkspace['summary']
  otherSummary?: NavWorkspace['summary']
  leafOverrides?: Readonly<Record<string, Partial<NavLeaf>>>
  leavesPerProject?: number
  needsYou?: number
}>

/** A fresh tree every call, as a rebuild from fetched data produces. */
function buildTree(options: BuildOptions = {}): NavTree {
  const perProject = options.leavesPerProject ?? 3
  const projects = ['p', 'q'].map((projectId) =>
    project(
      projectId,
      Array.from({ length: perProject }, (_, index) => {
        const id = `${projectId}-${index}`
        return leaf(id, projectId, {
          lastActivityAt: at(index),
          diff: { added: index, removed: 0 },
          ...options.leafOverrides?.[id],
        })
      })
    )
  )
  return {
    activeWorkspaceId: ACTIVE,
    needsYou: options.needsYou ?? 0,
    workspaces: [
      workspace(ACTIVE, {
        projects,
        ...(options.activeSummary ? { summary: options.activeSummary } : {}),
      }),
      workspace('workspace-other', {
        sortOrder: 1,
        ...(options.otherSummary ? { summary: options.otherSummary } : {}),
      }),
    ],
  }
}

const projectsOf = (tree: NavTree) => tree.workspaces[0]!.projects!

describe('stabilizeNavTree', () => {
  test('the first build passes through', () => {
    const tree = buildTree()
    expect(stabilizeNavTree(undefined, tree)).toBe(tree)
  })

  test('an equal rebuild returns the previous tree object', () => {
    const first = buildTree()
    expect(stabilizeNavTree(first, buildTree())).toBe(first)
  })

  test('unchanged workspaces, projects and leaves keep their identity', () => {
    const first = buildTree()
    const next = stabilizeNavTree(
      first,
      buildTree({ leafOverrides: { 'q-1': { status: 'running' } } })
    )
    expect(next).not.toBe(first)
    // The collapsed workspace row did not change.
    expect(next.workspaces[1]).toBe(first.workspaces[1])
    const [p, q] = projectsOf(next)
    // The untouched project is the same object; the touched one is replaced.
    expect(p).toBe(projectsOf(first)[0])
    expect(q).not.toBe(projectsOf(first)[1])
    // Inside the touched project only the changed leaf is new.
    expect(q!.leaves[0]).toBe(projectsOf(first)[1]!.leaves[0])
    expect(q!.leaves[1]).not.toBe(projectsOf(first)[1]!.leaves[1])
    expect(q!.leaves[1]!.status).toBe('running')
    expect(q!.leaves[2]).toBe(projectsOf(first)[1]!.leaves[2])
  })

  test('a counts-only change keeps the expanded workspace object', () => {
    const first = buildTree()
    const next = stabilizeNavTree(
      first,
      buildTree({ activeSummary: { running: 3, needsYou: 1, unread: 4 }, needsYou: 1 })
    )
    expect(next).not.toBe(first)
    expect(next.needsYou).toBe(1)
    expect(next.workspaces[0]).toBe(first.workspaces[0])
    expect(next.workspaces[1]).toBe(first.workspaces[1])
  })

  test('a counts change on a collapsed workspace replaces only that row', () => {
    const first = buildTree()
    const next = stabilizeNavTree(
      first,
      buildTree({ otherSummary: { running: 0, needsYou: 0, unread: 2 } })
    )
    expect(next.workspaces[0]).toBe(first.workspaces[0])
    expect(next.workspaces[1]).not.toBe(first.workspaces[1])
    expect(next.workspaces[1]!.summary.unread).toBe(2)
  })

  test('an absent optional field equals one spread in as undefined', () => {
    const first = buildTree()
    const rebuilt = buildTree({ leafOverrides: { 'p-0': { title: undefined } } })
    expect(stabilizeNavTree(first, rebuilt)).toBe(first)
  })

  test('a reorder is a change, while rows keep their identity', () => {
    const first = buildTree()
    const reordered: NavTree = { ...buildTree(), workspaces: buildTree().workspaces.toReversed() }
    const next = stabilizeNavTree(first, reordered)
    expect(next).not.toBe(first)
    expect(next.workspaces[0]).toBe(first.workspaces[1])
    expect(next.workspaces[1]).toBe(first.workspaces[0])
  })

  test('the 2,000-row scale tree stabilizes in well under a frame budget', () => {
    // The same shape as the Dev sidebar's cert-scale fixture: 2,000 leaves
    // across the active workspace's two projects.
    const first = buildTree({ leavesPerProject: 1_000 })
    const rebuilt = buildTree({ leavesPerProject: 1_000 })
    const changed = buildTree({
      leavesPerProject: 1_000,
      leafOverrides: { 'q-999': { status: 'needs_you' } },
    })
    // Warm the JIT so the measurement is the steady-state 30s poll.
    for (let round = 0; round < 3; round += 1) stabilizeNavTree(first, rebuilt)
    const started = performance.now()
    const equal = stabilizeNavTree(first, rebuilt)
    const partial = stabilizeNavTree(first, changed)
    const elapsed = performance.now() - started
    expect(equal).toBe(first)
    expect(projectsOf(partial)[0]).toBe(projectsOf(first)[0])
    expect(projectsOf(partial)[1]!.leaves[998]).toBe(projectsOf(first)[1]!.leaves[998])
    expect(projectsOf(partial)[1]!.leaves[999]).not.toBe(projectsOf(first)[1]!.leaves[999])
    // Generous for slow CI runners; a regression to per-render serialization
    // of the whole tree or quadratic matching lands far above it.
    expect(elapsed).toBeLessThan(100)
  })
})

describe('group modes and the Needs you fallback', () => {
  test('the grouping menu follows the one shared mode list', () => {
    expect(navGroupModes.map((entry) => entry.mode)).toEqual([...sidebarGroupModes])
  })

  test('nextWorkspaceNeedingYou skips the active workspace and follows sort order', () => {
    const workspaces = [
      workspace(ACTIVE, { summary: { running: 0, needsYou: 2, unread: 0 } }),
      workspace('b', { sortOrder: 2, summary: { running: 0, needsYou: 1, unread: 0 } }),
      workspace('a', {
        sortOrder: 1,
        summary: { running: 0, needsYou: 0, unread: 0, mentions: 1 },
      }),
      workspace('quiet', { sortOrder: 0 }),
    ]
    expect(nextWorkspaceNeedingYou(workspaces, ACTIVE)?.id).toBe('a')
    expect(nextWorkspaceNeedingYou(workspaces.slice(0, 1), ACTIVE)).toBeUndefined()
  })
})
