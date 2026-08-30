import { describe, expect, test } from 'bun:test'

import { nextSettingsSection, settingsSectionFromHash } from '../../src/settings-section'

describe('settings deep links and keyboard navigation', () => {
  test('accepts stable section hashes and rejects unknown sections', () => {
    expect(settingsSectionFromHash('#settings/privacy-data')).toBe('privacy-data')
    expect(settingsSectionFromHash('#settings/not-a-section')).toBe('account')
  })

  test('wraps arrow navigation and honors Home and End', () => {
    expect(nextSettingsSection('account', 'ArrowUp')).toBe('integrations')
    expect(nextSettingsSection('integrations', 'ArrowDown')).toBe('account')
    expect(nextSettingsSection('workspace', 'Home')).toBe('account')
    expect(nextSettingsSection('workspace', 'End')).toBe('integrations')
  })
})
