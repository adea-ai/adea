import { describe, expect, test } from 'bun:test'

import { createViewAdapter } from '../../src/adapters'
import type { NavLeaf, NavProject } from '../../src/model'

const repo: NavProject = {
  id: 'adea',
  name: 'adea',
  source: 'local_repo',
  sortOrder: 0,
  leaves: [],
}
const notes: NavProject = { ...repo, id: 'brand', name: 'Brand and launch', source: 'none' }
const remote: NavProject = { ...repo, id: 'api', name: 'pink-binder-api', source: 'remote_only' }

const worktree: NavLeaf = {
  id: 'wt',
  kind: 'worktree',
  projectId: 'adea',
  branchRef: 'sidebar-ux-redesign',
  title: 'Redesign the sidebar',
  status: 'running',
  lastActivityAt: '2026-10-05T10:00:00.000Z',
}
const checkout: NavLeaf = { ...worktree, id: 'co', kind: 'checkout', branchRef: 'main' }
const branchOnly: NavLeaf = { ...worktree, id: 'b', title: undefined }
const titleOnly: NavLeaf = { ...worktree, id: 't', kind: 'task', branchRef: undefined }

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id)

describe('dev adapter', () => {
  const dev = createViewAdapter('dev')

  test('nouns, icons and labels', () => {
    expect(dev.nouns).toEqual({ project: 'Project', leaf: 'worktree' })
    expect(dev.showCheckoutRow).toBe(true)
    expect([dev.projectIcon(repo), dev.projectIcon(notes), dev.projectIcon(remote)]).toEqual([
      'git-folder',
      'folder',
      'cloud',
    ])
    expect(dev.leafLabel(worktree)).toEqual({ text: 'sidebar-ux-redesign', mono: true })
    expect(dev.leafSecondary(worktree)).toBe('Redesign the sidebar')
    expect(dev.leafLabel(titleOnly)).toEqual({ text: 'Redesign the sidebar', mono: false })
    expect(dev.leafSecondary(titleOnly)).toBeUndefined()
  })

  test('create labels follow the repository binding', () => {
    expect(dev.createLeafLabel(repo)).toBe('New worktree')
    expect(dev.createLeafLabel(remote)).toBe('New worktree')
    expect(dev.createLeafLabel(notes)).toBe('New session')
    expect(dev.createProjectLabel).toBe('New project')
  })

  test('menus', () => {
    expect(dev.projectMenu(repo)).toEqual([
      { id: 'rename', label: 'Rename' },
      { id: 'settings', label: 'Project settings' },
      { id: 'share', label: 'Share' },
      { id: 'archive', label: 'Archive' },
      { id: 'delete', label: 'Delete', destructive: true, separatorBefore: true },
    ])
    expect(ids(dev.leafMenu(worktree))).toEqual([
      'rename',
      'copy-link',
      'share',
      'open-in-finder',
      'archive',
      'delete',
    ])
    expect(ids(dev.leafMenu(checkout))).toEqual(['copy-path', 'open-in-finder', 'share'])
  })

  test('the checkout never offers archive or delete; branch switching is behind a flag', () => {
    const flagged = createViewAdapter('dev', { branchSwitching: true })
    expect(ids(flagged.leafMenu(checkout))).toEqual([
      'switch-branch',
      'copy-path',
      'open-in-finder',
      'share',
    ])
    for (const adapter of [createViewAdapter('dev'), flagged]) {
      expect(ids(adapter.leafMenu(checkout))).not.toContain('delete')
      expect(ids(adapter.leafMenu(checkout))).not.toContain('archive')
    }
  })
})

describe('chat and virtual adapters', () => {
  const chat = createViewAdapter('chat')
  const virtual = createViewAdapter('virtual')

  test('nouns and icons', () => {
    expect(chat.nouns).toEqual({ project: 'Project', leaf: 'task' })
    expect(virtual.nouns).toEqual({ project: 'Room', leaf: 'desk' })
    expect(chat.projectIcon(repo)).toBe('hash')
    expect(virtual.projectIcon(repo)).toBe('door')
    expect(chat.showCheckoutRow).toBe(false)
    expect(virtual.showCheckoutRow).toBe(false)
  })

  test('labels prefer the task title and fall back to the branch', () => {
    expect(chat.leafLabel(worktree)).toEqual({ text: 'Redesign the sidebar', mono: false })
    expect(chat.leafSecondary(worktree)).toBe('sidebar-ux-redesign')
    expect(chat.leafLabel(branchOnly)).toEqual({ text: 'sidebar-ux-redesign', mono: true })
    // The checkout is the project's default task or desk, named after the project.
    expect(virtual.leafLabel(checkout, repo)).toEqual({ text: 'adea', mono: false })
  })

  test('create labels and menus', () => {
    expect(chat.createLeafLabel(repo)).toBe('New task')
    expect(virtual.createLeafLabel(repo)).toBe('New desk')
    expect(chat.createProjectLabel).toBe('New project')
    expect(virtual.createProjectLabel).toBe('New room')
    expect(virtual.projectMenu(repo)[1]).toEqual({ id: 'settings', label: 'Room settings' })
    expect(ids(chat.leafMenu(worktree))).toEqual([
      'rename',
      'copy-link',
      'share',
      'archive',
      'delete',
    ])
    expect(ids(virtual.leafMenu(checkout))).toEqual(['share'])
  })

  test('Virtual rooms use their own name, with the project as a hint', () => {
    const room: NavProject = { ...repo, roomName: 'Engineering' }
    expect(virtual.projectLabel(room)).toEqual({ text: 'Engineering', hint: 'adea' })
    expect(virtual.projectLabel(repo)).toEqual({ text: 'adea' })
    // A room named like its project needs no hint.
    expect(virtual.projectLabel({ ...repo, roomName: 'adea' })).toEqual({ text: 'adea' })
    // Chat ignores room names.
    expect(chat.projectLabel(room)).toEqual({ text: 'adea' })
    // The default desk is named after the room.
    expect(virtual.leafLabel(checkout, room)).toEqual({ text: 'Engineering', mono: false })
  })

  test('leaf nouns and meta are per view', () => {
    expect(chat.leafNoun(worktree)).toBe('Task')
    expect(virtual.leafNoun(checkout)).toBe('Desk')
    expect(chat.leafMeta).toBe('activity')
    expect(virtual.leafMeta).toBe('agents')
  })
})

describe('dev leaf nouns and meta', () => {
  const dev = createViewAdapter('dev')

  test('worktrees and checkouts are worktrees; a cloud task stays a task', () => {
    expect(dev.leafNoun(worktree)).toBe('Worktree')
    expect(dev.leafNoun(checkout)).toBe('Worktree')
    expect(dev.leafNoun(titleOnly)).toBe('Task')
    expect(dev.leafMeta).toBe('changes')
    expect(dev.projectLabel({ ...repo, roomName: 'Engineering' })).toEqual({ text: 'adea' })
  })
})
