import { describe, expect, test } from 'bun:test'

import {
  createBrowserPluginsProvider,
  defaultPluginFilter,
  filterWorkspacePlugins,
  getPopularWorkspacePlugins,
  groupWorkspacePlugins,
  popularWorkspacePluginIds,
  workspacePluginCategoryOrder,
} from '../../src/plugins'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
}

describe('workspace plugin catalog', () => {
  test('persists added plugins and exposes them through Yours', async () => {
    const storage = memoryStorage()
    const provider = createBrowserPluginsProvider(storage)
    const initial = await provider.list()
    expect(filterWorkspacePlugins(initial, 'yours', '')).toEqual([])

    const installed = await provider.setInstalled('github', true)
    expect(filterWorkspacePlugins(installed, 'yours', '').map(({ id }) => id)).toEqual(['github'])
    expect(
      (await createBrowserPluginsProvider(storage).list()).find(({ id }) => id === 'github')
    ).toMatchObject({ installed: true })

    const removed = await provider.setInstalled('github', false)
    expect(filterWorkspacePlugins(removed, 'yours', '')).toEqual([])
  })

  test('searches across plugin names, descriptions, publishers, and kinds', async () => {
    const plugins = await createBrowserPluginsProvider(memoryStorage()).list()
    expect(filterWorkspacePlugins(plugins, 'marketplace', 'schedule').map(({ id }) => id)).toEqual([
      'outlook-calendar',
    ])
    expect(filterWorkspacePlugins(plugins, 'marketplace', 'skill').map(({ id }) => id)).toContain(
      'room-summaries'
    )
  })

  test('imports the pinned Codex official marketplace and keeps Agent HQ first-party plugins', async () => {
    const plugins = await createBrowserPluginsProvider(memoryStorage()).list()
    const official = plugins.filter(({ source }) => source === 'codex-official')

    expect(official.length).toBeGreaterThanOrEqual(64)
    expect(plugins).toHaveLength(official.length + 1)
    expect(official.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        'codex-security',
        'data-analytics',
        'figma',
        'github',
        'notion',
        'slack',
        'stripe',
        'vercel',
        'zoom',
      ])
    )
    expect(official.every(({ sourceRevision }) => sourceRevision?.length === 40)).toBe(true)
    expect(plugins.find(({ id }) => id === 'room-summaries')).toMatchObject({
      source: 'agent-hq',
    })
  })

  test('supports type and ownership filter axes', async () => {
    const plugins = await createBrowserPluginsProvider(memoryStorage()).list()

    const skills = filterWorkspacePlugins(plugins, 'marketplace', '', {
      ...defaultPluginFilter,
      type: 'skills',
    })
    expect(skills.length).toBeGreaterThan(0)
    expect(skills.every(({ kind }) => kind === 'skill')).toBe(true)
    expect(skills.map(({ id }) => id)).toContain('room-summaries')
    expect(
      filterWorkspacePlugins(plugins, 'marketplace', '', {
        ...defaultPluginFilter,
        ownership: 'team',
      })
    ).toEqual([])
  })

  test('groups the catalog in Codex marketplace category order and omits empty groups', async () => {
    const plugins = await createBrowserPluginsProvider(memoryStorage()).list()
    const groups = groupWorkspacePlugins(plugins)

    expect(groups.map(({ category }) => category)).toEqual(workspacePluginCategoryOrder)
    expect(groups.every(({ plugins: items }) => items.length > 0)).toBe(true)
    expect(groups.flatMap(({ plugins: items }) => items)).toHaveLength(plugins.length)
    expect(workspacePluginCategoryOrder).toContain('Security')
  })

  test('keeps the Codex popular providers in explicit discovery order', async () => {
    const plugins = await createBrowserPluginsProvider(memoryStorage()).list()

    expect(getPopularWorkspacePlugins(plugins).map(({ id }) => id)).toEqual(
      popularWorkspacePluginIds
    )
    expect(popularWorkspacePluginIds).toEqual([
      'gmail',
      'github',
      'google-drive',
      'google-calendar',
      'notion',
      'slack',
    ])
  })

  test('rejects unknown plugin ids instead of persisting arbitrary values', async () => {
    const provider = createBrowserPluginsProvider(memoryStorage())
    expect(provider.setInstalled('missing', true)).rejects.toThrow('Unknown plugin')
  })
})
