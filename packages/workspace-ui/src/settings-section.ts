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
