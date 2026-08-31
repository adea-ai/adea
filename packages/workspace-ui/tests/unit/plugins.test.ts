import { describe, expect, test } from 'bun:test'

import { createBrowserPluginsProvider, filterWorkspacePlugins } from '../../src/plugins'

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
      'google-calendar',
    ])
    expect(filterWorkspacePlugins(plugins, 'marketplace', 'skill').map(({ id }) => id)).toEqual([
      'room-summaries',
    ])
  })

  test('rejects unknown plugin ids instead of persisting arbitrary values', async () => {
    const provider = createBrowserPluginsProvider(memoryStorage())
    expect(provider.setInstalled('missing', true)).rejects.toThrow('Unknown plugin')
  })
})
