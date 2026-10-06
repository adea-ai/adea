import { describe, expect, test } from 'bun:test'

import type {
  ChannelReadStateSummary,
  ChannelSummary,
  ProjectSummary,
  TaskSummary,
  WorkspaceSummary,
} from '@adea-ai/types'
import { createViewAdapter } from '@adea-ai/workspace-nav/adapters'

import { projectWorkspaceNavigation } from '../../src/workspace-model'
import {
  buildWorkspaceNavSource,
  cloudLeafMenu,
  cloudProjectMenu,
  taskLeafStatus,
} from '../../src/workspace-nav-source'

const at = (minute: number) => `2026-10-05T10:${String(minute).padStart(2, '0')}:00.000Z`

const workspace = (id: string, sortOrder: number, name = id): WorkspaceSummary => ({
  accent: id === 'work' ? 'violet' : null,
  id,
  logo: { kind: 'monogram' },
  name,
  scene: 'work',
  sortOrder,
  updatedAt: at(0),
  version: 1,
})

const project = (id: string, sortOrder: number): ProjectSummary => ({
  createdAt: at(0),
  iconKey: 'hash',
  id,
  lifecycleState: 'active',
  name: id === 'web' ? 'Web' : 'Ops',
  sortOrder,
  sourceKind: id === 'web' ? 'repository' : 'none',
  updatedAt: at(0),
  workspaceId: 'work',
})

const channel = (id: string, options: Partial<ChannelSummary> = {}): ChannelSummary => ({
  createdAt: at(0),
  id,
  isPrimaryProjectChannel: false,
  kind: 'project',
  lifecycleState: 'active',
  participants: [],
  sortOrder: 0,
  title: id,
  updatedAt: at(1),
  version: 1,
  visibility: 'workspace',
  workspaceId: 'work',
  ...options,
})

const task = (id: string, options: Partial<TaskSummary> = {}): TaskSummary => ({
  artifactRefs: [],
  conversation: {},
  createdAt: at(0),
  creator: { kind: 'user', userId: 'user-1' } as TaskSummary['creator'],
  dependencyIds: [],
  id,
  kind: 'feature',
  lifecycleState: 'created',
  priority: 'normal',
  projectId: 'web',
  title: `Task ${id}`,
  updatedAt: at(2),
  version: 1,
  workspaceId: 'work',
  ...options,
})

const readState = (
  channelId: string,
  topLevelUnreadCount: number,
  manuallyUnread = false
): ChannelReadStateSummary => ({
  channelId,
  lastReadSequence: 0,
  latestTopLevelSequence: topLevelUnreadCount,
  manuallyUnread,
  threadUnreadCount: 0,
  threads: [],
  topLevelUnreadCount,
  unread: topLevelUnreadCount > 0 || manuallyUnread,
  workspaceId: 'work',
})

const navigation = projectWorkspaceNavigation(
  [project('ops', 2), project('web', 1)],
  [
    channel('web-main', { isPrimaryProjectChannel: true, projectId: 'web' }),
    channel('web-design', { projectId: 'web', sortOrder: 1, updatedAt: at(5) }),
    channel('web-bug', { projectId: 'web', sortOrder: 2, taskId: 'linked', updatedAt: at(3) }),
    channel('ops-main', { isPrimaryProjectChannel: true, projectId: 'ops' }),
    channel('dm', { kind: 'direct_agent', agentId: 'agent-1' }),
  ]
)

const source = () =>
  buildWorkspaceNavSource({
    activeWorkspaceId: 'work',
    workspaces: [workspace('home', 1, 'Home'), workspace('work', 0, 'Work')],
    navigation,
    tasks: [
      task('linked', { lifecycleState: 'in_review', title: 'Fix the login bug', updatedAt: at(9) }),
      task('open', { lifecycleState: 'in_progress', title: 'Ship the sidebar' }),
      task('done', { lifecycleState: 'completed' }),
      task('elsewhere', { projectId: 'ops', lifecycleState: 'queued' }),
    ],
    readState: [readState('web-design', 4), readState('web-main', 0, true)],
    accountSummary: {
      workspaces: [
        { workspaceId: 'home', unreadChannels: 3, mentions: 1 },
        { workspaceId: 'work', unreadChannels: 2, mentions: 2 },
      ],
    },
  })

describe('buildWorkspaceNavSource', () => {
  test('only the active workspace carries projects, in the member order', () => {
    const { tree } = source()
    expect(tree.activeWorkspaceId).toBe('work')
    const home = tree.workspaces.find(({ id }) => id === 'home')!
    const work = tree.workspaces.find(({ id }) => id === 'work')!
    expect(home.projects).toBeUndefined()
    expect(work.projects?.map(({ id }) => id)).toEqual(['web', 'ops'])
    expect(work.accent).toBe('violet')
    expect(work.projects?.[0]?.source).toBe('local_repo')
  })

  test('collapsed workspaces read unread channels and mentions from the account summary', () => {
    const home = source().tree.workspaces.find(({ id }) => id === 'home')!
    expect(home.summary).toEqual({ running: 0, needsYou: 0, unread: 3, mentions: 1 })
  })

  test('"Needs you" totals mentions across every workspace', () => {
    expect(source().tree.needsYou).toBe(3)
  })

  test('the dev summary seam adds running and input-needing counts', () => {
    const { tree } = buildWorkspaceNavSource({
      activeWorkspaceId: 'work',
      workspaces: [workspace('home', 1), workspace('work', 0)],
      navigation,
      tasks: [],
      readState: [],
      devSummary: [{ workspaceId: 'home', running: 2, needsInput: 1 }],
    })
    expect(tree.workspaces.find(({ id }) => id === 'home')!.summary).toEqual({
      running: 2,
      needsYou: 1,
      unread: 0,
      mentions: 0,
    })
    expect(tree.needsYou).toBe(1)
  })

  test('the primary channel is the default leaf, then channels and tasks most recent first', () => {
    const web = source().tree.workspaces.find(({ id }) => id === 'work')!.projects![0]!
    expect(web.leaves.map(({ id, kind }) => `${kind}:${id}`)).toEqual([
      'checkout:web-main',
      'task:web-bug',
      'task:web-design',
      'task:open',
    ])
  })

  test('a task linked to a channel is one leaf with the task title and status', () => {
    const { tree, targets } = source()
    const leaf = tree.workspaces[1]!.projects![0]!.leaves.find(({ id }) => id === 'web-bug')!
    expect(leaf).toMatchObject({
      taskId: 'linked',
      title: 'Fix the login bug',
      status: 'in_review',
    })
    expect(leaf.lastActivityAt).toBe(at(9))
    const target = targets.get('web-bug')
    expect(target?.kind).toBe('channel')
    expect(target?.kind === 'channel' && target.task?.id).toBe('linked')
  })

  test('closed tasks leave the tree and channel-less tasks open as tasks', () => {
    const { tree, targets } = source()
    const leafIds = tree.workspaces[1]!.projects!.flatMap(({ leaves }) =>
      leaves.map(({ id }) => id)
    )
    expect(leafIds).not.toContain('done')
    expect(leafIds).toContain('elsewhere')
    expect(targets.get('open')).toMatchObject({ kind: 'task' })
  })

  test('unread activity is a count on the leaf, never a status', () => {
    const web = source().tree.workspaces[1]!.projects![0]!
    const design = web.leaves.find(({ id }) => id === 'web-design')!
    expect(design.unread).toEqual({ count: 4, marked: false })
    expect(design.status).toBe('idle')
    expect(web.leaves.find(({ id }) => id === 'web-main')!.unread).toEqual({
      count: 0,
      marked: true,
    })
  })

  test('the active workspace is listed even when the member list lacks it', () => {
    const { tree } = buildWorkspaceNavSource({
      activeWorkspaceId: 'temp',
      activeWorkspace: workspace('temp', 9, 'Temporary'),
      workspaces: [],
      navigation,
      tasks: [],
      readState: [],
    })
    expect(tree.workspaces.map(({ id }) => id)).toEqual(['temp'])
    expect(tree.needsYou).toBe(0)
  })
})

describe('cloud menus and status', () => {
  test('task lifecycles map to running, in review or idle', () => {
    expect(taskLeafStatus('in_progress')).toBe('running')
    expect(taskLeafStatus('in_review')).toBe('in_review')
    expect(taskLeafStatus('queued')).toBe('idle')
    expect(taskLeafStatus('created')).toBe('idle')
  })

  test('the default leaf only copies its link; other leaves rename, copy and archive', () => {
    const [web] = source().tree.workspaces[1]!.projects!
    expect(cloudLeafMenu(web!.leaves[0]!).map(({ id }) => id)).toEqual(['copy-link'])
    expect(cloudLeafMenu(web!.leaves[1]!).map(({ id }) => id)).toEqual([
      'rename',
      'copy-link',
      'archive',
    ])
  })

  test('Share is offered only when the host can share', () => {
    const adapter = createViewAdapter('chat')
    const [web] = source().tree.workspaces[1]!.projects!
    expect(cloudProjectMenu(adapter, web!, { share: false }).map(({ id }) => id)).toEqual([
      'rename',
      'settings',
      'archive',
      'delete',
    ])
    expect(cloudProjectMenu(adapter, web!, { share: true }).map(({ id }) => id)).toContain('share')
  })
})
