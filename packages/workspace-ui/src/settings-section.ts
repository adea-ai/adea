import {
  workspaceSettingsSectionFromHash,
  type WorkspaceSettingsSection,
} from './workspace-settings-section'

/**
 * The Settings dialog's sections. App-wide and account settings come first;
 * the Workspaces group holds the directory of the member's workspaces and the
 * selected workspace's own settings (identity, Memory, Connections),
 * which used to live in a separate dialog. Which settings apply to the
 * account, the workspace, a project or the device is unchanged: only where
 * they are reached moved.
 */
export const settingsSections = [
  'account',
  'appearance',
  'workspaces',
  'workspace-general',
  'workspace-memory',
  'workspace-connections',
  'agents',
  'input-notifications',
  'privacy-data',
  'integrations',
  'permissions',
] as const

export type SettingsSection = (typeof settingsSections)[number]

/** The sections that configure the selected workspace, and the workspace section each opens. */
export const workspaceScopedSettingsSections = {
  'workspace-general': 'general',
  'workspace-memory': 'memory',
  'workspace-connections': 'connections',
} as const satisfies Readonly<Record<string, WorkspaceSettingsSection>>

export type WorkspaceScopedSettingsSection = keyof typeof workspaceScopedSettingsSections

export function isWorkspaceScopedSection(
  section: SettingsSection
): section is WorkspaceScopedSettingsSection {
  return Object.hasOwn(workspaceScopedSettingsSections, section)
}

export const settingsSectionGroups = [
  { label: 'Account', items: ['account', 'appearance'] },
  {
    label: 'Workspaces',
    items: ['workspaces', 'workspace-general', 'workspace-memory', 'workspace-connections'],
  },
  { label: 'Workflows', items: ['agents', 'input-notifications'] },
  { label: 'Data & access', items: ['privacy-data', 'integrations', 'permissions'] },
] as const satisfies ReadonlyArray<{
  label: string
  items: readonly SettingsSection[]
}>

export const settingsSectionLabels: Readonly<Record<SettingsSection, string>> = {
  account: 'Account & app',
  agents: 'Agents',
  appearance: 'Appearance',
  'input-notifications': 'Input & notifications',
  integrations: 'Integrations & capabilities',
  'privacy-data': 'Privacy & data',
  permissions: 'Permissions',
  workspaces: 'Your workspaces',
  'workspace-general': 'General',
  'workspace-memory': 'Memory',
  'workspace-connections': 'Connections',
}

/** The Settings section for a workspace-scoped workspace section. */
export function settingsSectionForWorkspaceSection(
  section: WorkspaceSettingsSection
): WorkspaceScopedSettingsSection {
  return `workspace-${section}`
}

/**
 * The section a hash addresses. `#settings/<section>` is canonical; the retired
 * `#workspace-settings/<section>` links and the older `#settings/workspace|
 * memory|connections` links land on the matching Workspaces section.
 */
export function settingsSectionFromHash(hash: string): SettingsSection {
  const workspaceSection = workspaceSettingsSectionFromHash(hash)
  if (workspaceSection) return settingsSectionForWorkspaceSection(workspaceSection)
  const candidate = hash.replace(/^#settings\/?/, '')
  return settingsSections.includes(candidate as SettingsSection)
    ? (candidate as SettingsSection)
    : 'account'
}

/** The canonical deep link for a Settings section. */
export function settingsSectionHash(section: SettingsSection): string {
  return `#settings/${section}`
}

export function nextSettingsSection(
  section: SettingsSection,
  key: 'ArrowDown' | 'ArrowUp' | 'End' | 'Home'
) {
  if (key === 'Home') return settingsSections[0]
  if (key === 'End') return settingsSections.at(-1)!
  const current = settingsSections.indexOf(section)
  const direction = key === 'ArrowDown' ? 1 : -1
  return settingsSections[
    (current + direction + settingsSections.length) % settingsSections.length
  ]!
}

export {
  isSettingsHash,
  workspaceSettingsHash,
  workspaceSettingsHashPrefix,
  workspaceSettingsSectionFromHash,
  workspaceSettingsSectionLabels,
  workspaceSettingsSections,
  type WorkspaceSettingsSection,
} from './workspace-settings-section'
