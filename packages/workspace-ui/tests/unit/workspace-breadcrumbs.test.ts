import { describe, expect, test } from 'bun:test'

import { devBreadcrumbs } from '../../src/workspace-breadcrumbs'

const workspace = {
  id: 'acme',
  name: 'Acme',
  logo: { kind: 'monogram' as const },
  accent: null,
}

describe('devBreadcrumbs', () => {
  test('workspace › project › branch in mono, all a readout', () => {
    const crumbs = devBreadcrumbs(workspace, {
      projectId: 'adea',
      projectName: 'adea',
      branch: 'feat/topbar-breadcrumbs',
    })
    expect(crumbs.map(({ label }) => label)).toEqual([
      { text: 'Acme', mono: false },
      { text: 'adea', mono: false },
      { text: 'feat/topbar-breadcrumbs', mono: true },
    ])
    expect(crumbs.map(({ noun }) => noun)).toEqual(['Workspace', 'Project', 'Worktree'])
    expect(crumbs.map(({ current }) => current)).toEqual([false, false, true])
    // The only leaf is the one shown, so no crumb links to it.
    expect(crumbs.every(({ target }) => target === undefined)).toBe(true)
  })

  test('shows what is known: no branch, then no selection', () => {
    const projectOnly = devBreadcrumbs(workspace, { projectId: 'notes', projectName: 'Notes' })
    expect(projectOnly.map(({ label }) => label.text)).toEqual(['Acme', 'Notes'])
    expect(projectOnly[1]!.current).toBe(true)

    const none = devBreadcrumbs(workspace, undefined)
    expect(none.map(({ label }) => label.text)).toEqual(['Acme'])
    expect(none[0]!.current).toBe(true)
  })
})
