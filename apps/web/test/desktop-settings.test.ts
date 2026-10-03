import { describe, expect, test } from 'bun:test'
import { defaultWorkspacePreferences } from '@adea-ai/workspace-ui/platform'
import { createDesktopSettingsProvider } from '../src/lib/desktop-platform-services'

describe('desktop workspace preferences boundary', () => {
  test('missing and malformed stored preferences produce usable defaults', async () => {
    for (const value of [null, undefined, false, 'invalid']) {
      const provider = createDesktopSettingsProvider(async () => value)
      expect(await provider.load()).toEqual(defaultWorkspacePreferences)
    }
  })

  test('normalizes persisted fields and strips unsupported values', async () => {
    const provider = createDesktopSettingsProvider(async () => ({
      dictationLocale: ' es-PR ',
      notifyMentions: false,
      notifyTasks: 'yes',
      privateNotificationPreviews: true,
      unknown: 'discard',
    }))
    expect(await provider.load()).toEqual({
      dictationLocale: 'es-PR',
      notifyMentions: false,
      notifyTasks: true,
      privateNotificationPreviews: true,
      version: 1,
    })
  })

  test('returns saved preferences when the shell acknowledges with null or void', async () => {
    for (const acknowledgement of [null, undefined]) {
      const requests: Array<{ command: string; preferences?: unknown }> = []
      const provider = createDesktopSettingsProvider(async (command, args) => {
        requests.push({ command, preferences: args?.preferences })
        return acknowledgement
      })
      const saved = await provider.save({
        dictationLocale: ' es-PR ',
        notifyMentions: false,
        notifyTasks: false,
        privateNotificationPreviews: true,
        version: 1,
      })
      expect(saved).toEqual({
        dictationLocale: 'es-PR',
        notifyMentions: false,
        notifyTasks: false,
        privateNotificationPreviews: true,
        version: 1,
      })
      expect(requests).toEqual([{ command: 'desktop_preferences_save', preferences: saved }])
    }
  })

  test('a failed native write remains a failure rather than claiming a save', async () => {
    const error = new Error('Preferences could not be written')
    const provider = createDesktopSettingsProvider(async () => {
      throw error
    })
    await expect(provider.save(defaultWorkspacePreferences)).rejects.toBe(error)
    await expect(provider.load()).rejects.toBe(error)
  })
})
