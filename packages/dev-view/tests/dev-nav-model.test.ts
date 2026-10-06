import { describe, expect, test } from 'bun:test'

import {
  DIFF_SUMMARY_BATCH_LIMIT,
  buildDevNavSource,
  devBindingsFromProjection,
  fixtureRuns,
  leafIdForSession,
  sessionForLeaf,
  visibleDiffWorktreeIds,
  type DevNavBinding,
  type DevNavInput,
  type DevNavWorktreeRecord,
} from '../src/sidebar/dev-nav-model'
import { stabilizeNavTree } from '@adea-ai/workspace-nav/model'

const WORKSPACE = 'workspace-active'

const binding = (id: string, sessions: DevNavBinding['sessions'] = []): DevNavBinding => ({
  id,
  name: `binding ${id}`,
  repository: `repo-${id}`,
  repoIds: [`repo-${id}`],
  branch: 'main',
  version: 3,
  sessions,
})

const worktree = (
  id: string,
  projectId: string,
  kind: DevNavWorktreeRecord['kind'],
  fields: Partial<DevNavWorktreeRecord> = {}
): DevNavWorktreeRecord => ({ id, projectId, kind, repoId: `repo-${projectId}`, ...fields })

function input(overrides: Partial<DevNavInput> = {}): DevNavInput {
  return {
    activeWorkspaceId: WORKSPACE,
    workspaces: [
      { id: WORKSPACE, name: 'Adea', logo: { kind: 'monogram' }, accent: null, sortOrder: 0 },
    ],
    bindings: [],
    worktrees: [],
    runs: [],
    ...overrides,
  }
}

const activeProjects = (source: ReturnType<typeof buildDevNavSource>) =>
  source.tree.workspaces.find((workspace) => workspace.id === WORKSPACE)?.projects ?? []

describe('Dev NavTree builder: cloud join', () => {
  test('projects follow the cloud list; bindings join by id and supply leaves', () => {
    const source = buildDevNavSource(
      input({
        cloudProjects: [
          { id: 'p-b', name: 'Beta', sortOrder: 1 },
          { id: 'p-a', name: 'Alpha', sortOrder: 0, sourceKind: 'repository' },
        ],
        bindings: [binding('p-a')],
        worktrees: [worktree('wt-a', 'p-a', 'primary', { headRef: 'main' })],
      })
    )
    const projects = activeProjects(source)
    expect(projects.map((project) => [project.name, project.source, project.sortOrder])).toEqual([
      ['Beta', 'none', 1],
      ['Alpha', 'local_repo', 0],
    ])
    expect(projects.find((project) => project.id === 'p-a')?.leaves).toHaveLength(1)
    // A cloud project with no local binding shows as source none with no leaves.
    expect(projects.find((project) => project.id === 'p-b')?.leaves).toEqual([])
    expect(source.projects.get('p-b')?.binding).toBeUndefined()
    expect(source.projects.get('p-a')?.binding?.id).toBe('p-a')
  })

  test('a binding without a cloud row is hidden and reported', () => {
    const source = buildDevNavSource(
      input({
        cloudProjects: [{ id: 'p-a', name: 'Alpha', sortOrder: 0 }],
        bindings: [binding('p-a'), binding('orphan')],
      })
    )
    expect(activeProjects(source).map((project) => project.id)).toEqual(['p-a'])
    expect(source.hiddenBindingIds).toEqual(['orphan'])
  })

  test('without a cloud list the bindings render in projection order with their names', () => {
    const source = buildDevNavSource(input({ bindings: [binding('second'), binding('first')] }))
    expect(activeProjects(source).map((project) => [project.name, project.sortOrder])).toEqual([
      ['binding second', 0],
      ['binding first', 1],
    ])
    expect(source.hiddenBindingIds).toEqual([])
  })

  test('the projection maps to bindings with host names or the short id', () => {
    const bindings = devBindingsFromProjection(
      {
        projects: [
          {
            id: '0d9e4f1a-1111-4000-8000-000000000001',
            repoIds: ['repo-1'],
            branch: 'main',
            version: 4,
            sessions: [],
          },
          { id: 'abcdef12-2222-4000-8000-000000000002', repoIds: [], branch: '', sessions: [] },
        ],
      },
      new Map([['0d9e4f1a-1111-4000-8000-000000000001', 'Named project']])
    )
    expect(bindings.map((entry) => [entry.name, entry.repository, entry.version])).toEqual([
      ['Named project', 'repo-1', 4],
      ['abcdef12', '', undefined],
    ])
  })
})

describe('Dev NavTree builder: leaves', () => {
  test('the primary record is the checkout leaf labelled with the branch it has checked out', () => {
    const source = buildDevNavSource(
      input({
        bindings: [binding('p')],
        worktrees: [
          worktree('wt-managed', 'p', 'managed', { branchRef: 'feature/x', title: 'Fix x' }),
          worktree('wt-primary', 'p', 'primary', { branchRef: 'main', headRef: 'release/2' }),
          worktree('wt-external', 'p', 'external', { headRef: 'spike' }),
        ],
      })
    )
    const leaves = activeProjects(source)[0]!.leaves
    expect(leaves[0]).toMatchObject({ id: 'wt-primary', kind: 'checkout', branchRef: 'release/2' })
    expect(leaves.slice(1).map((leaf) => [leaf.id, leaf.kind, leaf.branchRef])).toEqual([
      // List order stands in for recency: the later record sorts first.
      ['wt-external', 'worktree', 'spike'],
      ['wt-managed', 'worktree', 'feature/x'],
    ])
    expect(leaves.find((leaf) => leaf.id === 'wt-managed')?.title).toBe('Fix x')
  })

  test('the projection source is used as given: remote-only shows no checkout row', () => {
    const source = buildDevNavSource(
      input({
        cloudProjects: [
          { id: 'remote', name: 'Remote', sortOrder: 0 },
          { id: 'bare', name: 'Bare binding', sortOrder: 1 },
        ],
        bindings: [
          { ...binding('remote'), source: 'remote_only' },
          { ...binding('bare'), source: 'none', repoIds: [] },
        ],
        worktrees: [
          // A stray primary record never becomes a checkout row for a managed clone.
          worktree('wt-remote-primary', 'remote', 'primary', { headRef: 'main' }),
          worktree('wt-remote-1', 'remote', 'managed', { branchRef: 'feature/remote' }),
        ],
      })
    )
    const [remote, bare] = activeProjects(source)
    expect(remote!.source).toBe('remote_only')
    expect(remote!.leaves.map((leaf) => [leaf.id, leaf.kind])).toEqual([
      ['wt-remote-1', 'worktree'],
    ])
    expect(bare!.source).toBe('none')
  })

  test('the projection carries its source onto the binding', () => {
    const [entry] = devBindingsFromProjection({
      projects: [{ id: 'p', repoIds: ['r'], branch: 'main', source: 'remote_only', sessions: [] }],
    })
    expect(entry!.source).toBe('remote_only')
  })

  test('archived records are skipped and records of other projects stay with their project', () => {
    const source = buildDevNavSource(
      input({
        bindings: [binding('p'), binding('q')],
        worktrees: [
          worktree('wt-old', 'p', 'managed', { archived: true, branchRef: 'old' }),
          worktree('wt-q', 'q', 'managed', { branchRef: 'q-work' }),
        ],
      })
    )
    const [p, q] = activeProjects(source)
    expect(p!.leaves).toEqual([])
    expect(q!.leaves.map((leaf) => leaf.id)).toEqual(['wt-q'])
  })

  test('a live session on an unlisted worktree keeps a leaf of its own', () => {
    const source = buildDevNavSource(
      input({
        bindings: [
          binding('p', [
            { id: 's-1', title: 'First', worktreeId: 'wt-unlisted', state: 'ready' },
            { id: 's-2', title: 'Archived', worktreeId: 'wt-gone', state: 'archived' },
          ]),
        ],
      })
    )
    const leaves = activeProjects(source)[0]!.leaves
    expect(leaves.map((leaf) => [leaf.id, leaf.kind, leaf.title])).toEqual([
      ['wt-unlisted', 'worktree', 'First'],
    ])
    expect(source.targets.get('wt-unlisted')?.worktree).toBeUndefined()
  })

  test('status reads the harness runs of the leaf sessions, then the linked task', () => {
    const sessions: DevNavBinding['sessions'] = [
      { id: 's-input', title: 'a', worktreeId: 'wt-input', state: 'active' },
      { id: 's-run', title: 'b', worktreeId: 'wt-run', state: 'active' },
      { id: 's-idle', title: 'c', worktreeId: 'wt-review', state: 'ready' },
    ]
    const source = buildDevNavSource(
      input({
        bindings: [binding('p', sessions)],
        worktrees: [
          worktree('wt-input', 'p', 'managed', { branchRef: 'a' }),
          worktree('wt-run', 'p', 'managed', { branchRef: 'b' }),
          worktree('wt-review', 'p', 'managed', { branchRef: 'c', taskId: 'task-1' }),
          worktree('wt-plain', 'p', 'managed', { branchRef: 'd', taskId: 'task-2' }),
        ],
        runs: [
          { runtimeSessionId: 's-input', state: 'working' },
          { runtimeSessionId: 's-input', state: 'awaiting_approval' },
          { runtimeSessionId: 's-run', state: 'starting' },
          { runtimeSessionId: 's-idle', state: 'completed' },
          { runtimeSessionId: 'other-session', state: 'awaiting_input' },
        ],
        taskStates: new Map([
          ['task-1', 'in_review'],
          ['task-2', 'in_progress'],
        ]),
      })
    )
    const status = Object.fromEntries(
      activeProjects(source)[0]!.leaves.map((leaf) => [leaf.id, leaf.status])
    )
    expect(status).toEqual({
      'wt-input': 'needs_you',
      'wt-run': 'running',
      'wt-review': 'in_review',
      'wt-plain': 'idle',
    })
  })

  test('fixture sessions describe their harness through badges', () => {
    expect(
      fixtureRuns([
        binding('p', [
          { id: 'a', title: 'a', state: 'active', badges: { harness: 'working' } },
          { id: 'b', title: 'b', state: 'active', badges: { harness: 'idle' } },
          { id: 'c', title: 'c', state: 'active', badges: { harness: 'awaiting_input' } },
        ]),
      ])
    ).toEqual([
      { runtimeSessionId: 'a', state: 'working' },
      { runtimeSessionId: 'c', state: 'awaiting_input' },
    ])
  })

  test('diff counts attach to their worktree leaves', () => {
    const source = buildDevNavSource(
      input({
        bindings: [binding('p')],
        worktrees: [worktree('wt', 'p', 'managed', { branchRef: 'x' })],
        diffs: new Map([['wt', { added: 12, removed: 3 }]]),
      })
    )
    expect(activeProjects(source)[0]!.leaves[0]?.diff).toEqual({ added: 12, removed: 3 })
  })
})

describe('Dev NavTree builder: selection', () => {
  const sessions: DevNavBinding['sessions'] = [
    { id: 's-old', title: 'old', worktreeId: 'wt', state: 'ready' },
    { id: 's-new', title: 'new', worktreeId: 'wt', state: 'ready' },
    { id: 's-archived', title: 'gone', worktreeId: 'wt', state: 'archived' },
  ]
  const source = buildDevNavSource(
    input({
      bindings: [binding('p', sessions)],
      worktrees: [
        worktree('wt', 'p', 'managed', { branchRef: 'x' }),
        worktree('wt-empty', 'p', 'managed', { branchRef: 'y' }),
      ],
    })
  )

  test('a session maps to the leaf of its worktree', () => {
    expect(leafIdForSession(source, 's-old')).toBe('wt')
    expect(leafIdForSession(source, 's-archived')).toBeUndefined()
    expect(leafIdForSession(source, undefined)).toBeUndefined()
  })

  test('selecting a leaf keeps the current session on it, else opens the most recent', () => {
    const target = source.targets.get('wt')!
    expect(target.sessions.map((session) => session.id)).toEqual(['s-old', 's-new'])
    expect(sessionForLeaf(target, 's-old')).toBe('s-old')
    expect(sessionForLeaf(target, 'elsewhere')).toBe('s-new')
    expect(sessionForLeaf(source.targets.get('wt-empty')!)).toBeUndefined()
  })
})

describe('Dev NavTree builder: diff batching', () => {
  test('only worktree rows of expanded projects are read, checkout and derived rows never', () => {
    const source = buildDevNavSource(
      input({
        cloudProjects: [
          { id: 'p', name: 'P', sortOrder: 0 },
          { id: 'q', name: 'Q', sortOrder: 1 },
        ],
        bindings: [
          binding('p', [{ id: 's', title: 's', worktreeId: 'wt-derived', state: 'ready' }]),
          binding('q'),
        ],
        worktrees: [
          worktree('wt-p-primary', 'p', 'primary', { headRef: 'main' }),
          worktree('wt-p-1', 'p', 'managed', { branchRef: 'a' }),
          worktree('wt-q-1', 'q', 'managed', { branchRef: 'b' }),
        ],
      })
    )
    expect(visibleDiffWorktreeIds(source, new Set())).toEqual(['wt-p-1', 'wt-q-1'])
    expect(visibleDiffWorktreeIds(source, new Set(['q']))).toEqual(['wt-p-1'])
  })

  test('one batch never names more than fifty worktrees', () => {
    const worktrees = Array.from({ length: 80 }, (_, index) =>
      worktree(`wt-${String(index).padStart(2, '0')}`, 'p', 'managed', { branchRef: `b${index}` })
    )
    const source = buildDevNavSource(input({ bindings: [binding('p')], worktrees }))
    const ids = visibleDiffWorktreeIds(source, new Set())
    expect(DIFF_SUMMARY_BATCH_LIMIT).toBe(50)
    expect(ids).toHaveLength(50)
    expect(new Set(ids).size).toBe(50)
  })
})

describe('Dev NavTree builder: workspaces', () => {
  test('collapsed workspaces read cloud and desktop counts; needs you sums both', () => {
    const source = buildDevNavSource(
      input({
        workspaces: [
          { id: WORKSPACE, name: 'Adea', logo: { kind: 'monogram' }, accent: null, sortOrder: 0 },
          {
            id: 'other',
            name: 'Other',
            logo: { kind: 'emoji', value: '🚀' },
            accent: 'cyan',
            sortOrder: 1,
          },
        ],
        accountSummary: [{ workspaceId: 'other', unreadChannels: 4, mentions: 2 }],
        devSummary: [
          { workspaceId: 'other', running: 3, needsInput: 1 },
          { workspaceId: WORKSPACE, running: 1, needsInput: 2 },
        ],
      })
    )
    const other = source.tree.workspaces.find((workspace) => workspace.id === 'other')!
    expect(other.summary).toEqual({ running: 3, needsYou: 1, unread: 4, mentions: 2 })
    expect(other.projects).toBeUndefined()
    expect(source.tree.needsYou).toBe(5)
  })

  test('the active workspace is added when the member list does not carry it', () => {
    const source = buildDevNavSource(
      input({ workspaces: [], activeWorkspaceName: 'Device workspace' })
    )
    expect(source.tree.workspaces).toHaveLength(1)
    expect(source.tree.workspaces[0]).toMatchObject({
      id: WORKSPACE,
      name: 'Device workspace',
      projects: [],
    })
  })
})

const buildTree = (overrides: Partial<DevNavInput> = {}) =>
  buildDevNavSource(
    input({
      bindings: [binding('p'), binding('q')],
      worktrees: [
        worktree('wt-p', 'p', 'managed', { branchRef: 'a' }),
        worktree('wt-q', 'q', 'managed', { branchRef: 'b' }),
      ],
      ...overrides,
    })
  ).tree

describe('Dev NavTree stabilization', () => {
  test('an equal rebuild keeps the previous tree object', () => {
    const first = buildTree()
    expect(stabilizeNavTree(first, buildTree())).toBe(first)
  })

  test('a counts-only change keeps the active workspace mounted', () => {
    const first = buildTree()
    const next = stabilizeNavTree(
      first,
      buildTree({ devSummary: [{ workspaceId: WORKSPACE, running: 2, needsInput: 1 }] })
    )
    expect(next).not.toBe(first)
    expect(next.needsYou).toBe(1)
    expect(next.workspaces[0]).toBe(first.workspaces[0])
  })

  test('a changed leaf replaces only its own project and leaf', () => {
    const first = buildTree()
    const next = stabilizeNavTree(
      first,
      buildTree({ diffs: new Map([['wt-q', { added: 1, removed: 0 }]]) })
    )
    const [p, q] = next.workspaces[0]!.projects!
    expect(p).toBe(first.workspaces[0]!.projects![0])
    expect(q).not.toBe(first.workspaces[0]!.projects![1])
    expect(q!.leaves[0]!.diff).toEqual({ added: 1, removed: 0 })
  })
})
