import { describe, expect, test } from 'bun:test'

import { createViewAdapter } from '../../src/adapters'
import { breadcrumbsFor, defaultLeaf } from '../../src/breadcrumbs'
import type { NavLeaf, NavProject, NavTree } from '../../src/model'

const at = (minute: number) => `2026-10-05T10:${String(minute).padStart(2, '0')}:00.000Z`

const checkout: NavLeaf = {
  id: 'general',
  kind: 'checkout',
  projectId: 'launch',
  branchRef: 'main',
  status: 'idle',
  lastActivityAt: at(1),
}
const task: NavLeaf = {
  id: 'copy',
  kind: 'task',
  projectId: 'launch',
  title: 'Write the launch copy',
  status: 'running',
  lastActivityAt: at(5),
}
const worktree: NavLeaf = {
  id: 'wt',
  kind: 'worktree',
  projectId: 'launch',
  branchRef: 'feat/launch-page',
  title: 'Launch page',
  status: 'running',
  lastActivityAt: at(3),
}
const launch: NavProject = {
  id: 'launch',
  name: 'Launch',
  source: 'local_repo',
  sortOrder: 1,
  leaves: [task, worktree, checkout],
}
const notes: NavProject = {
  id: 'notes',
  name: 'Notes',
  source: 'none',
  sortOrder: 0,
  leaves: [{ ...task, id: 'jot', projectId: 'notes', title: 'Jot', lastActivityAt: at(2) }],
}
const empty: NavProject = { id: 'empty', name: 'Empty', source: 'none', sortOrder: 2, leaves: [] }

const tree: NavTree = {
  activeWorkspaceId: 'acme',
  needsYou: 0,
  workspaces: [
    {
      id: 'acme',
      name: 'Acme',
      logo: { kind: 'emoji', value: '🚀' },
      accent: 'violet',
      sortOrder: 0,
      summary: { running: 0, needsYou: 0, unread: 0 },
      projects: [launch, notes, empty],
    },
    {
      id: 'other',
      name: 'Other',
      logo: { kind: 'monogram' },
      accent: null,
      sortOrder: 1,
      summary: { running: 0, needsYou: 0, unread: 0 },
    },
  ],
}

const chat = createViewAdapter('chat')
const virtual = createViewAdapter('virtual')
const dev = createViewAdapter('dev')

const texts = (crumbs: ReturnType<typeof breadcrumbsFor>) => crumbs.map(({ label }) => label.text)

describe('breadcrumbsFor', () => {
  test('Chat: workspace › project › task title, the leaf current', () => {
    const crumbs = breadcrumbsFor(tree, { leafId: 'copy' }, chat)
    expect(texts(crumbs)).toEqual(['Acme', 'Launch', 'Write the launch copy'])
    expect(crumbs.map(({ kind }) => kind)).toEqual(['workspace', 'project', 'leaf'])
    expect(crumbs.map(({ noun }) => noun)).toEqual(['Workspace', 'Project', 'Task'])
    expect(crumbs.map(({ current }) => current)).toEqual([false, false, true])
    expect(crumbs[0]!.workspace).toEqual({ logo: { kind: 'emoji', value: '🚀' }, accent: 'violet' })
    expect(crumbs[2]!.label.mono).toBe(false)
    expect(crumbs[2]!.target).toBeUndefined()
  })

  test('earlier crumbs open the default leaf: first project, then the checkout', () => {
    const crumbs = breadcrumbsFor(tree, { leafId: 'copy' }, chat)
    // Notes sorts first (sortOrder 0); its only leaf is its default.
    expect(crumbs[0]!.target).toEqual({ projectId: 'notes', leafId: 'jot' })
    expect(crumbs[1]!.target).toEqual({ projectId: 'launch', leafId: 'general' })
  })

  test('Virtual: room › desk nouns over the same tree', () => {
    const crumbs = breadcrumbsFor(tree, { leafId: 'wt' }, virtual)
    expect(texts(crumbs)).toEqual(['Acme', 'Launch', 'Launch page'])
    expect(crumbs.map(({ noun }) => noun)).toEqual(['Workspace', 'Room', 'Desk'])
  })

  test('Dev: project › branch in mono, the checkout its own leaf', () => {
    const worktreeCrumbs = breadcrumbsFor(tree, { leafId: 'wt' }, dev)
    expect(texts(worktreeCrumbs)).toEqual(['Acme', 'Launch', 'feat/launch-page'])
    expect(worktreeCrumbs[2]!.label.mono).toBe(true)
    expect(worktreeCrumbs[2]!.noun).toBe('Worktree')

    const checkoutCrumbs = breadcrumbsFor(tree, { leafId: 'general' }, dev)
    expect(texts(checkoutCrumbs)).toEqual(['Acme', 'Launch', 'main'])
    // The project's default leaf is already open: the project crumb is not a no-op link.
    expect(checkoutCrumbs[1]!.target).toBeUndefined()
  })

  test('a Chat or Virtual default leaf does not repeat the project name', () => {
    for (const adapter of [chat, virtual]) {
      const crumbs = breadcrumbsFor(tree, { leafId: 'general' }, adapter)
      expect(texts(crumbs)).toEqual(['Acme', 'Launch'])
      expect(crumbs[1]!.current).toBe(true)
      expect(crumbs[1]!.target).toBeUndefined()
    }
  })

  test('the workspace crumb never targets the leaf already shown', () => {
    const crumbs = breadcrumbsFor(tree, { leafId: 'jot' }, chat)
    expect(texts(crumbs)).toEqual(['Acme', 'Notes', 'Jot'])
    expect(crumbs[0]!.target).toBeUndefined()
    expect(crumbs[1]!.target).toBeUndefined()
  })

  test('a project selection without a leaf ends at the project', () => {
    const crumbs = breadcrumbsFor(tree, { projectId: 'empty' }, dev)
    expect(texts(crumbs)).toEqual(['Acme', 'Empty'])
    expect(crumbs[1]!.current).toBe(true)
    expect(crumbs[0]!.target).toEqual({ projectId: 'notes', leafId: 'jot' })
  })

  test('missing pieces fall back to what is known', () => {
    // Nothing selected, or a leaf outside the tree (a direct conversation).
    for (const selection of [{}, { leafId: 'dm-1' }, { leafId: null, projectId: 'gone' }]) {
      const crumbs = breadcrumbsFor(tree, selection, chat)
      expect(texts(crumbs)).toEqual(['Acme'])
      expect(crumbs[0]!.current).toBe(true)
      expect(crumbs[0]!.target).toBeUndefined()
    }
    // An unknown leaf still resolves its project when the project is known.
    expect(texts(breadcrumbsFor(tree, { leafId: 'gone', projectId: 'launch' }, chat))).toEqual([
      'Acme',
      'Launch',
    ])
    // A workspace without projects yet.
    const bare: NavTree = { ...tree, workspaces: [{ ...tree.workspaces[0]!, projects: undefined }] }
    expect(texts(breadcrumbsFor(bare, { leafId: 'copy' }, chat))).toEqual(['Acme'])
    // No active workspace at all.
    expect(breadcrumbsFor({ ...tree, activeWorkspaceId: 'missing' }, {}, chat)).toEqual([])
  })

  test('the workspace crumb has no target when no project has a leaf', () => {
    const bare: NavTree = {
      ...tree,
      workspaces: [{ ...tree.workspaces[0]!, projects: [empty] }],
    }
    const crumbs = breadcrumbsFor(bare, { projectId: 'empty' }, chat)
    expect(crumbs[0]!.current).toBe(false)
    expect(crumbs[0]!.target).toBeUndefined()
  })

  test('an untitled leaf keeps the adapter fallback label', () => {
    const untitled: NavLeaf = { ...task, id: 'u', title: undefined }
    const crumbs = breadcrumbsFor(
      {
        ...tree,
        workspaces: [{ ...tree.workspaces[0]!, projects: [{ ...launch, leaves: [untitled] }] }],
      },
      { leafId: 'u' },
      chat
    )
    expect(crumbs[2]!.label).toEqual({ text: 'Untitled', mono: false })
  })
})

describe('defaultLeaf', () => {
  test('the checkout first, else the most recent leaf', () => {
    expect(defaultLeaf(launch)?.id).toBe('general')
    expect(defaultLeaf({ leaves: [task, worktree] })?.id).toBe('copy')
    expect(defaultLeaf(empty)).toBeUndefined()
  })
})
