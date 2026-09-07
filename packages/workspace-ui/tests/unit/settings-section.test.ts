import { describe, expect, test } from 'bun:test'

import {
  nextSettingsSection,
  settingsSectionFromHash,
  settingsSectionGroups,
  settingsSections,
} from '../../src/settings-section'

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

  test('groups every section without changing keyboard navigation order', () => {
    expect(settingsSectionGroups.flatMap(({ items }) => items)).toEqual(settingsSections)
    expect(settingsSectionGroups.map(({ label }) => label)).toEqual([
      'Account',
      'Workspace',
      'Workflows',
      'Data & access',
    ])
  })
})
