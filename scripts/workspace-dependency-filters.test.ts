import { expect, test } from 'bun:test'

import { getWorkspaceDependencyFilters } from './workspace-dependency-filters.mjs'

test('filters only local workspace dependencies from all manifest sections', () => {
  const filters = getWorkspaceDependencyFilters(
    {
      '@adea-ai/app-ui': 'workspace:*',
      '@adea-ai/ui': '0.72.4',
      'solid-js': '^1.9.15',
    },
    {
      '@adea-ai/workspace-ui': 'workspace:*',
      '@adea-ai/ui': '0.72.4',
    }
  )

  expect(filters).toEqual(['--filter=@adea-ai/app-ui', '--filter=@adea-ai/workspace-ui'])
})

test('returns no Turbo filters when a manifest has no workspace dependencies', () => {
  expect(getWorkspaceDependencyFilters({ '@adea-ai/ui': '0.72.4' })).toEqual([])
})
