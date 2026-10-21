import { describe, expect, test } from 'bun:test'

import {
  isWorkspaceScopedSection,
  nextSettingsSection,
  settingsSectionForWorkspaceSection,
  settingsSectionFromHash,
  settingsSectionGroups,
  settingsSectionHash,
  settingsSections,
  workspaceScopedSettingsSections,
  workspaceSettingsHash,
  workspaceSettingsSectionFromHash,
  workspaceSettingsSectionLabels,
  workspaceSettingsSections,
} from '../../src/settings-section'

describe('settings deep links and keyboard navigation', () => {
  test('accepts stable section hashes and rejects unknown sections', () => {
    expect(settingsSectionFromHash('#settings/privacy-data')).toBe('privacy-data')
    expect(settingsSectionFromHash('#settings/not-a-section')).toBe('account')
    expect(settingsSectionFromHash('#settings/workspaces')).toBe('workspaces')
    expect(settingsSectionFromHash('#settings/workspace-skills')).toBe('workspace-skills')
  })

  test('the retired workspace-settings links land on the matching Workspaces section', () => {
    expect(settingsSectionFromHash('#workspace-settings/memory')).toBe('workspace-memory')
    expect(settingsSectionFromHash('#workspace-settings')).toBe('workspace-general')
    expect(settingsSectionFromHash('#settings/workspace')).toBe('workspace-general')
    expect(settingsSectionFromHash('#settings/connections')).toBe('workspace-connections')
    expect(settingsSectionHash('workspace-general')).toBe('#settings/workspace-general')
  })

  test('Settings holds the workspace sections between Account and Workflows', () => {
    expect(settingsSections).toEqual([
      'account',
      'appearance',
      'workspaces',
      'workspace-general',
      'workspace-memory',
      'workspace-skills',
      'workspace-connections',
      'agents',
      'input-notifications',
      'privacy-data',
      'integrations',
      'permissions',
    ])
    expect(Object.keys(workspaceScopedSettingsSections)).toEqual([
      'workspace-general',
      'workspace-memory',
      'workspace-skills',
      'workspace-connections',
    ])
    expect(isWorkspaceScopedSection('workspace-memory')).toBe(true)
    expect(isWorkspaceScopedSection('workspaces')).toBe(false)
    expect(settingsSectionForWorkspaceSection('skills')).toBe('workspace-skills')
  })

  test('wraps arrow navigation and honors Home and End', () => {
    expect(nextSettingsSection('account', 'ArrowUp')).toBe('permissions')
    expect(nextSettingsSection('appearance', 'ArrowDown')).toBe('workspaces')
    expect(nextSettingsSection('workspace-connections', 'ArrowDown')).toBe('agents')
    expect(nextSettingsSection('permissions', 'ArrowDown')).toBe('account')
    expect(nextSettingsSection('agents', 'Home')).toBe('account')
    expect(nextSettingsSection('agents', 'End')).toBe('permissions')
  })

  test('groups every section without changing keyboard navigation order', () => {
    expect(settingsSectionGroups.flatMap(({ items }) => items)).toEqual(settingsSections)
    expect(settingsSections).not.toContain('updates')
    expect(settingsSectionGroups.map(({ label }) => label)).toEqual([
      'Account',
      'Workspaces',
      'Workflows',
      'Data & access',
    ])
    for (const group of settingsSectionGroups) expect(group.items.length).toBeGreaterThan(0)
    expect(settingsSectionGroups[0]?.items).toEqual(['account', 'appearance'])
  })
})

describe('workspace settings deep links', () => {
  test('lists General, Memory, Skills and Connections in order', () => {
    expect(workspaceSettingsSections).toEqual(['general', 'memory', 'skills', 'connections'])
    expect(
      workspaceSettingsSections.map((section) => workspaceSettingsSectionLabels[section])
    ).toEqual(['General', 'Memory', 'Skills', 'Connections'])
  })

  test('reads its own hash and falls back to General for unknown sections', () => {
    for (const section of workspaceSettingsSections)
      expect(workspaceSettingsSectionFromHash(workspaceSettingsHash(section))).toBe(section)
    expect(workspaceSettingsHash('skills')).toBe('#workspace-settings/skills')
    expect(workspaceSettingsSectionFromHash('#workspace-settings')).toBe('general')
    expect(workspaceSettingsSectionFromHash('#workspace-settings/not-a-section')).toBe('general')
  })

  test('maps the retired app Settings links onto the matching section', () => {
    expect(workspaceSettingsSectionFromHash('#settings/workspace')).toBe('general')
    expect(workspaceSettingsSectionFromHash('#settings/memory')).toBe('memory')
    expect(workspaceSettingsSectionFromHash('#settings/skills')).toBe('skills')
    expect(workspaceSettingsSectionFromHash('#settings/connections')).toBe('connections')
  })

  test('leaves app Settings and unrelated hashes alone', () => {
    for (const hash of [
      '',
      '#settings',
      '#settings/account',
      '#settings/privacy-data',
      '#settings/constructor',
      '#settings/memory/extra',
      '#workspace-settingsx',
      '#dev-center',
    ])
      expect(workspaceSettingsSectionFromHash(hash)).toBeUndefined()
  })
})
