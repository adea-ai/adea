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
    expect(settingsSectionFromHash('#settings/memory')).toBe('memory')
  })

  test('places Memory in the Workspace group, after the workspace section', () => {
    expect(settingsSectionGroups.find(({ label }) => label === 'Workspace')?.items).toEqual([
      'appearance',
      'workspace',
      'memory',
    ])
    expect(nextSettingsSection('workspace', 'ArrowDown')).toBe('memory')
    expect(nextSettingsSection('memory', 'ArrowDown')).toBe('agents')
  })

  test('wraps arrow navigation and honors Home and End', () => {
    expect(nextSettingsSection('account', 'ArrowUp')).toBe('permissions')
    expect(nextSettingsSection('integrations', 'ArrowDown')).toBe('connections')
    expect(nextSettingsSection('connections', 'ArrowDown')).toBe('permissions')
    expect(nextSettingsSection('permissions', 'ArrowDown')).toBe('account')
    expect(nextSettingsSection('workspace', 'Home')).toBe('account')
    expect(nextSettingsSection('workspace', 'End')).toBe('permissions')
  })

  test('groups every section without changing keyboard navigation order', () => {
    expect(settingsSectionGroups.flatMap(({ items }) => items)).toEqual(settingsSections)
    expect(settingsSections).not.toContain('updates')
    expect(settingsSectionGroups.map(({ label }) => label)).toEqual([
      'Account',
      'Workspace',
      'Workflows',
      'Data & access',
    ])
  })
})
