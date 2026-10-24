import { describe, expect, test } from 'bun:test'

import { createBrowserSettingsProvider, normalizeWorkspacePreferences } from '../../src/preferences'

describe('workspace preferences boundary', () => {
  test('normalizes untrusted persisted values to the supported M2 shape', () => {
    expect(
      normalizeWorkspacePreferences({
        appIcon: 'violet',
        dictationLocale: ' en-US ',
        notifyMentions: false,
        notifyTasks: 'yes',
        privateNotificationPreviews: true,
        windowSurface: 'frosted',
        secret: 'must-not-survive',
      })
    ).toEqual({
      appIcon: 'violet',
      dictationLocale: 'en-US',
      notifyMentions: false,
      notifyTasks: true,
      privateNotificationPreviews: true,
      windowSurface: 'frosted',
      version: 1,
    })
  })

  test('round trips through the typed provider without runtime credentials', async () => {
    const values = new Map<string, string>()
    const provider = createBrowserSettingsProvider({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
    })
    const saved = await provider.save({
      appIcon: 'black',
      dictationLocale: 'es-PR',
      notifyMentions: true,
      notifyTasks: false,
      privateNotificationPreviews: false,
      windowSurface: 'opaque',
      version: 1,
    })
    expect(await provider.load()).toEqual(saved)
    expect([...values.values()].join('')).not.toContain('credential')
  })

  test('an unknown or missing app icon falls back to the white default', () => {
    for (const appIcon of [undefined, 'green', 'WHITE', 3, null])
      expect(normalizeWorkspacePreferences({ appIcon }).appIcon).toBe('white')
    expect(normalizeWorkspacePreferences(null).appIcon).toBe('white')
  })
})
