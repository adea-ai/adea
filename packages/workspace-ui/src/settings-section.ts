export const settingsSections = [
  'account',
  'appearance',
  'workspace',
  'agents',
  'input-notifications',
  'privacy-data',
  'integrations',
] as const

export type SettingsSection = (typeof settingsSections)[number]

export const settingsSectionGroups = [
  { label: 'Account', items: ['account'] },
  { label: 'Workspace', items: ['appearance', 'workspace'] },
  { label: 'Workflows', items: ['agents', 'input-notifications'] },
  { label: 'Data & access', items: ['privacy-data', 'integrations'] },
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
  workspace: 'Workspace',
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
