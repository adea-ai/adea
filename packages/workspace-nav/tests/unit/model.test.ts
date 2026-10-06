import { describe, expect, test } from 'bun:test'

import {
  activeWorkspace,
  groupTree,
  mergeLeaves,
  projectCollapsedSummary,
  projectSummary,
  sortProjectLeaves,
  sortWorkspaces,
  strongerStatus,
  workspaceChips,
  type NavLeaf,
  type NavProject,
  type NavWorkspace,
} from '../../src/model'

const at = (minute: number) => `2026-10-05T10:${String(minute).padStart(2, '0')}:00.000Z`

function leaf(partial: Partial<NavLeaf> & Pick<NavLeaf, 'id'>): NavLeaf {
  return {
    kind: 'worktree',
    projectId: 'adea',
    status: 'idle',
    lastActivityAt: at(0),
    ...partial,
  }
}

function project(partial: Partial<NavProject> & Pick<NavProject, 'id'>): NavProject {
  return { name: partial.id, source: 'local_repo', sortOrder: 0, leaves: [], ...partial }
}

describe('strongerStatus', () => {
  test('orders needs_you > running > in_review > idle', () => {
    expect(strongerStatus('idle', 'needs_you')).toBe('needs_you')
    expect(strongerStatus('running', 'needs_you')).toBe('needs_you')
    expect(strongerStatus('in_review', 'running')).toBe('running')
    expect(strongerStatus('idle', 'in_review')).toBe('in_review')
    expect(strongerStatus('idle', 'idle')).toBe('idle')
  })
})

describe('mergeLeaves', () => {
  test('a worktree linked to a task becomes one leaf with the task title and worktree branch', () => {
    const leaves = mergeLeaves(
      [
        {
          id: 'wt-1',
          projectId: 'adea',
          kind: 'worktree',
          branchRef: 'sidebar-ux-redesign',
          taskId: 'task-1',
          status: 'idle',
          diff: { added: 412, removed: 88 },
          lastActivityAt: at(1),
        },
      ],
      [
        {
          id: 'task-1',
          projectId: 'adea',
          title: 'Redesign the sidebar',
          status: 'running',
          pullRequest: { number: 1031 },
          lastActivityAt: at(5),
        },
      ]
    )
    expect(leaves).toEqual([
      {
        id: 'wt-1',
        kind: 'worktree',
        projectId: 'adea',
        worktreeId: 'wt-1',
        taskId: 'task-1',
        title: 'Redesign the sidebar',
        branchRef: 'sidebar-ux-redesign',
        status: 'running',
        diff: { added: 412, removed: 88 },
        pullRequest: { number: 1031 },
        lastActivityAt: at(5),
      },
    ])
  })

  test('the merged status takes the more urgent side either way', () => {
    const [merged] = mergeLeaves(
      [
        {
          id: 'wt',
          projectId: 'p',
          kind: 'worktree',
          branchRef: 'b',
          taskId: 't',
          status: 'needs_you',
          lastActivityAt: at(9),
        },
      ],
      [{ id: 't', projectId: 'p', title: 'T', status: 'in_review', lastActivityAt: at(1) }]
    )
    expect(merged?.status).toBe('needs_you')
    expect(merged?.lastActivityAt).toBe(at(9))
  })

  test('unlinked tasks become task leaves and the checkout is always first', () => {
    const leaves = mergeLeaves(
      [
        {
          id: 'wt-old',
          projectId: 'p',
          kind: 'worktree',
          branchRef: 'old',
          status: 'idle',
          lastActivityAt: at(1),
        },
        {
          id: 'checkout',
          projectId: 'p',
          kind: 'checkout',
          branchRef: 'main',
          status: 'idle',
          lastActivityAt: at(0),
        },
        {
          id: 'wt-new',
          projectId: 'p',
          kind: 'worktree',
          branchRef: 'new',
          status: 'idle',
          lastActivityAt: at(8),
        },
      ],
      [
        {
          id: 'task',
          projectId: 'p',
          title: 'Cloud task',
          status: 'running',
          lastActivityAt: at(4),
        },
      ]
    )
    expect(leaves.map((entry) => [entry.id, entry.kind])).toEqual([
      ['checkout', 'checkout'],
      ['wt-new', 'worktree'],
      ['task', 'task'],
      ['wt-old', 'worktree'],
    ])
    expect(leaves[2]).toEqual({
      id: 'task',
      kind: 'task',
      projectId: 'p',
      taskId: 'task',
      title: 'Cloud task',
      status: 'running',
      lastActivityAt: at(4),
    })
  })

  test('a worktree naming a missing task stays a plain worktree', () => {
    const [only] = mergeLeaves(
      [
        {
          id: 'wt',
          projectId: 'p',
          kind: 'worktree',
          branchRef: 'b',
          taskId: 'gone',
          status: 'idle',
          lastActivityAt: at(0),
        },
      ],
      []
    )
    expect(only?.taskId).toBeUndefined()
    expect(only?.title).toBeUndefined()
  })
})

describe('sortProjectLeaves', () => {
  test('keeps the checkout first and breaks activity ties by id', () => {
    const sorted = sortProjectLeaves([
      leaf({ id: 'b', lastActivityAt: at(3) }),
      leaf({ id: 'a', lastActivityAt: at(3) }),
      leaf({ id: 'c', kind: 'checkout', lastActivityAt: at(0) }),
    ])
    expect(sorted.map((entry) => entry.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('summaries', () => {
  const adea = project({
    id: 'adea',
    leaves: [
      leaf({ id: '1', status: 'needs_you' }),
      leaf({ id: '2', status: 'running' }),
      leaf({ id: '3', status: 'running' }),
      leaf({ id: '4', status: 'in_review' }),
      leaf({ id: '5', status: 'idle' }),
    ],
  })

  test('projectSummary counts each status', () => {
    expect(projectSummary(adea)).toEqual({
      total: 5,
      needsYou: 1,
      running: 2,
      inReview: 1,
      idle: 1,
    })
  })

  test('the collapsed summary names the most urgent count only', () => {
    expect(projectCollapsedSummary(adea)).toBe('1 needs you')
    const running = project({ id: 'r', leaves: [leaf({ id: 'x', status: 'running' })] })
    expect(projectCollapsedSummary(running)).toBe('1 running')
    const idle = project({ id: 'i', leaves: [leaf({ id: 'y' })] })
    expect(projectCollapsedSummary(idle)).toBeUndefined()
  })

  test('workspaceChips orders needs-you, running, unread and omits zeros', () => {
    expect(workspaceChips({ summary: { running: 2, needsYou: 1, unread: 0 } })).toEqual([
      { kind: 'needs_you', count: 1, label: '1 needs you' },
      { kind: 'running', count: 2, label: '2 running' },
    ])
    expect(workspaceChips({ summary: { running: 0, needsYou: 0, unread: 3 } })).toEqual([
      { kind: 'unread', count: 3, label: '3 unread' },
    ])
    expect(workspaceChips({ summary: { running: 0, needsYou: 0, unread: 0 } })).toEqual([])
  })

  test('workspaceChips puts mentions ahead of unread and pluralizes them', () => {
    expect(
      workspaceChips({ summary: { running: 0, needsYou: 0, unread: 3, mentions: 1 } })
    ).toEqual([
      { kind: 'mention', count: 1, label: '1 mention' },
      { kind: 'unread', count: 3, label: '3 unread' },
    ])
    expect(
      workspaceChips({ summary: { running: 0, needsYou: 0, unread: 0, mentions: 2 } })
    ).toEqual([{ kind: 'mention', count: 2, label: '2 mentions' }])
  })
})

describe('groupTree', () => {
  const projects: NavProject[] = [
    project({
      id: 'ui',
      name: 'adea-ui',
      sortOrder: 2,
      leaves: [
        leaf({ id: 'ui-wt', projectId: 'ui', status: 'idle', lastActivityAt: at(7) }),
        leaf({
          id: 'ui-co',
          projectId: 'ui',
          kind: 'checkout',
          status: 'running',
          lastActivityAt: at(1),
        }),
      ],
    }),
    project({
      id: 'adea',
      name: 'adea',
      sortOrder: 1,
      leaves: [
        leaf({ id: 'a-co', kind: 'checkout', status: 'idle', lastActivityAt: at(0) }),
        leaf({ id: 'a-run', status: 'running', lastActivityAt: at(5) }),
        leaf({ id: 'a-need', status: 'needs_you', lastActivityAt: at(3) }),
        leaf({ id: 'a-pr', status: 'in_review', lastActivityAt: at(9) }),
      ],
    }),
    project({ id: 'brand', name: 'Brand and launch', source: 'none', sortOrder: 3 }),
  ]

  test('project mode orders projects by sortOrder and leaves checkout first then recent', () => {
    const grouping = groupTree(projects, 'project')
    if (grouping.mode !== 'project') throw new Error('expected project grouping')
    expect(grouping.projects.map((entry) => entry.project.id)).toEqual(['adea', 'ui', 'brand'])
    expect(grouping.projects[0]?.leaves.map((entry) => entry.id)).toEqual([
      'a-co',
      'a-pr',
      'a-run',
      'a-need',
    ])
    expect(grouping.projects[1]?.leaves.map((entry) => entry.id)).toEqual(['ui-co', 'ui-wt'])
    expect(grouping.projects[2]?.leaves).toEqual([])
  })

  test('status mode buckets in precedence order with project names and no empty groups', () => {
    const grouping = groupTree(projects, 'status')
    if (grouping.mode !== 'status') throw new Error('expected status grouping')
    expect(grouping.groups.map((group) => [group.label, group.items.length])).toEqual([
      ['Needs you', 1],
      ['Running', 2],
      ['In review', 1],
      ['Idle', 2],
    ])
    expect(grouping.groups[1]?.items.map((entry) => [entry.leaf.id, entry.projectName])).toEqual([
      ['a-run', 'adea'],
      ['ui-co', 'adea-ui'],
    ])
    const onlyIdle = groupTree([project({ id: 'x', leaves: [leaf({ id: 'z' })] })], 'status')
    if (onlyIdle.mode !== 'status') throw new Error('expected status grouping')
    expect(onlyIdle.groups.map((group) => group.status)).toEqual(['idle'])
  })

  test('recent mode is one flat list, most recent first', () => {
    const grouping = groupTree(projects, 'recent')
    if (grouping.mode !== 'recent') throw new Error('expected recent grouping')
    expect(grouping.items.map((entry) => entry.leaf.id)).toEqual([
      'a-pr',
      'ui-wt',
      'a-run',
      'a-need',
      'ui-co',
      'a-co',
    ])
    expect(grouping.items[1]?.projectName).toBe('adea-ui')
  })
})

const workspace = (id: string, sortOrder: number): NavWorkspace => ({
  id,
  name: id,
  logo: { kind: 'monogram' },
  accent: null,
  sortOrder,
  summary: { running: 0, needsYou: 0, unread: 0 },
})

describe('workspaces', () => {
  test('sort by the caller order and resolve the active workspace', () => {
    const workspaces = [workspace('b', 2), workspace('a', 1)]
    expect(sortWorkspaces(workspaces).map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(activeWorkspace({ activeWorkspaceId: 'b', workspaces, needsYou: 0 })?.id).toBe('b')
    expect(activeWorkspace({ activeWorkspaceId: 'z', workspaces, needsYou: 0 })).toBeUndefined()
  })
})
