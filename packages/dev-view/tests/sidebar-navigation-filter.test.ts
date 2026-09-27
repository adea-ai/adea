import { describe, expect, test } from 'bun:test'

import type { DevGroupFixture } from '../src/dev-workspace-entry'
import { filterDevNavigationGroups } from '../src/sidebar/navigation-filter'

const groups: readonly DevGroupFixture[] = [
  {
    id: 'group-product',
    name: 'Product',
    projects: [
      {
        id: 'project-adea',
        name: 'Adea Client',
        repository: 'adea/client',
        branch: 'main',
        sessions: [
          { id: 'session-sidebar', title: 'Sidebar navigation', state: 'active' },
          { id: 'session-chat', title: 'Chat polish', state: 'ready' },
        ],
      },
      {
        id: 'project-docs',
        name: 'Documentation',
        repository: 'adea/docs',
        branch: 'main',
        sessions: [{ id: 'session-spec', title: 'Runtime spec', state: 'completed' }],
      },
    ],
  },
  {
    id: 'group-platform',
    name: 'Platform',
    projects: [
      {
        id: 'project-runtime',
        name: 'Runtime contracts',
        repository: 'adea/runtime',
        branch: 'main',
        sessions: [{ id: 'session-authority', title: 'Authority checks', state: 'failed' }],
      },
    ],
  },
]

describe('Dev sidebar navigation filter', () => {
  test('blank and whitespace-only queries preserve the original projection', () => {
    expect(filterDevNavigationGroups(groups, '')).toBe(groups)
    expect(filterDevNavigationGroups(groups, '   ')).toBe(groups)
  })

  test('a session match keeps only that session and its canonical project/group path', () => {
    const filtered = filterDevNavigationGroups(groups, 'SIDEBAR')

    expect(filtered.map((group) => group.id)).toEqual(['group-product'])
    expect(filtered[0]?.projects.map((project) => project.id)).toEqual(['project-adea'])
    expect(filtered[0]?.projects[0]?.sessions.map((session) => session.id)).toEqual([
      'session-sidebar',
    ])
  })

  test('a project match includes its sessions while excluding unrelated project paths', () => {
    const filtered = filterDevNavigationGroups(groups, ' runtime CONTR')

    expect(filtered.map((group) => group.id)).toEqual(['group-platform'])
    expect(filtered[0]?.projects.map((project) => project.id)).toEqual(['project-runtime'])
    expect(filtered[0]?.projects[0]?.sessions.map((session) => session.id)).toEqual([
      'session-authority',
    ])
  })

  test('a group match reveals its complete hierarchy', () => {
    const filtered = filterDevNavigationGroups(groups, 'product')

    expect(filtered[0]?.id).toBe('group-product')
    expect(filtered[0]?.projects.map((project) => project.id)).toEqual([
      'project-adea',
      'project-docs',
    ])
    expect(
      filtered[0]?.projects.map((project) => project.sessions.map((session) => session.id))
    ).toEqual([['session-sidebar', 'session-chat'], ['session-spec']])
  })

  test('a missing query returns no groups without changing the source projection', () => {
    const before = structuredClone(groups)

    expect(filterDevNavigationGroups(groups, 'unmatched')).toEqual([])
    expect(groups).toEqual(before)
  })
})
