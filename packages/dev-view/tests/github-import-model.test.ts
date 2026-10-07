// The add surface's "From GitHub" import-source model: listing rows re-proven
// client-side, the search filter, and the managed `dev.project.clone` body.
import { describe, expect, test } from 'bun:test'

import {
  filterRepositories,
  managedCloneBodyFor,
  repositoryRows,
  type GitHubImportRow,
} from '../src/sidebar/github-import-model'

const summary = (overrides: Partial<GitHubImportRow> = {}): GitHubImportRow => ({
  nameWithOwner: 'acme/widgets',
  url: 'https://github.com/acme/widgets',
  visibility: 'private',
  updatedAt: '2026-09-01T10:00:00.000Z',
  isFork: false,
  ...overrides,
})

describe('github import model', () => {
  test('rows flatten valid listing items and drop malformed or foreign shapes', () => {
    const rows = repositoryRows([
      summary(),
      summary({ nameWithOwner: 'acme/forked', updatedAt: '2026-08-01T10:00:00.000Z' }),
      // A gh entry the host decoder would already have refused; the client
      // drops rather than renders it.
      summary({ visibility: 'secret' as GitHubImportRow['visibility'] }),
      summary({ isFork: 'no' as unknown as boolean }),
      summary({ updatedAt: 'not-a-timestamp' }),
      { nameWithOwner: 'acme/urlless' },
      42,
      null,
    ])
    expect(rows.map((row) => row.nameWithOwner)).toEqual(['acme/widgets', 'acme/forked'])
  })

  test('rows sort newest-updated first regardless of transport order', () => {
    const rows = repositoryRows([
      summary({ nameWithOwner: 'acme/older', updatedAt: '2026-01-01T00:00:00.000Z' }),
      summary({ nameWithOwner: 'acme/newer', updatedAt: '2026-10-01T00:00:00.000Z' }),
      summary({ nameWithOwner: 'acme/middle', updatedAt: '2026-05-01T00:00:00.000Z' }),
    ])
    expect(rows.map((row) => row.nameWithOwner)).toEqual([
      'acme/newer',
      'acme/middle',
      'acme/older',
    ])
  })

  test('the filter matches owner/repository and the plain name, case-insensitively', () => {
    const rows = repositoryRows([
      summary({ nameWithOwner: 'acme/widgets' }),
      summary({ nameWithOwner: 'acme/forked' }),
      summary({ nameWithOwner: 'other/platform' }),
    ])
    expect(filterRepositories(rows, '').map((row) => row.nameWithOwner)).toEqual([
      'acme/widgets',
      'acme/forked',
      'other/platform',
    ])
    expect(filterRepositories(rows, '  ').length).toBe(3)
    expect(filterRepositories(rows, 'WID').map((row) => row.nameWithOwner)).toEqual([
      'acme/widgets',
    ])
    expect(filterRepositories(rows, 'fork').map((row) => row.nameWithOwner)).toEqual([
      'acme/forked',
    ])
    expect(filterRepositories(rows, 'other/').map((row) => row.nameWithOwner)).toEqual([
      'other/platform',
    ])
    expect(filterRepositories(rows, 'nowhere')).toEqual([])
  })

  test('the managed clone body carries redacted remote parts only', () => {
    const body = managedCloneBodyFor(summary({ nameWithOwner: 'acme/widgets' }), 'p-1')
    expect(body).toEqual({
      projectId: 'p-1',
      mode: 'managed',
      remote: { provider: 'github', host: 'github.com', ownerPath: 'acme', repository: 'widgets' },
    })
    expect(JSON.stringify(body)).not.toContain('https://')
  })

  test('a summary without an owner part is unpickable', () => {
    expect(managedCloneBodyFor(summary({ nameWithOwner: 'widgets' }), 'p-1')).toBeUndefined()
    expect(managedCloneBodyFor(summary({ nameWithOwner: 'acme/' }), 'p-1')).toBeUndefined()
    expect(managedCloneBodyFor(summary({ nameWithOwner: '/widgets' }), 'p-1')).toBeUndefined()
  })
})
