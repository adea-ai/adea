/**
 * The app Settings dialog's sections. Workspace-scoped settings (the
 * workspace's identity, Memory, Skills and Connections) live in the
 * per-workspace settings dialog instead — see `workspaceSettingsSections`.
 */
export const settingsSections = [
  'account',
  'appearance',
  'agents',
  'input-notifications',
  'privacy-data',
  'integrations',
  'permissions',
] as const

export type SettingsSection = (typeof settingsSections)[number]

export const settingsSectionGroups = [
  { label: 'Account', items: ['account', 'appearance'] },
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
}

export function settingsSectionFromHash(hash: string): SettingsSection {
  const candidate = hash.replace(/^#settings\/?/, '')
  return settingsSections.includes(candidate as SettingsSection)
    ? (candidate as SettingsSection)
    : 'account'
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
  workspaceSettingsHash,
  workspaceSettingsHashPrefix,
  workspaceSettingsSectionFromHash,
  workspaceSettingsSectionLabels,
  workspaceSettingsSections,
  type WorkspaceSettingsSection,
} from './workspace-settings-section'
