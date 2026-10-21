// The workspace settings dialog's sections and deep links. Kept apart from the
// app Settings sections so the navigation entry, which reads these links at
// startup, does not carry the app Settings section tables with it.

/**
 * The per-workspace settings dialog's sections, deep-linked as
 * `#workspace-settings/<section>`.
 */
export const workspaceSettingsSections = ['general', 'memory', 'connections'] as const

export type WorkspaceSettingsSection = (typeof workspaceSettingsSections)[number]

export const workspaceSettingsSectionLabels: Readonly<Record<WorkspaceSettingsSection, string>> = {
  general: 'General',
  memory: 'Memory',
  connections: 'Connections',
}

export const workspaceSettingsHashPrefix = '#workspace-settings'

/**
 * App Settings sections that moved into the workspace settings dialog, keyed
 * by their old `#settings/<section>` deep link so those links keep working.
 */
const legacyWorkspaceSettingsSections: Readonly<Record<string, WorkspaceSettingsSection>> = {
  workspace: 'general',
  memory: 'memory',
  connections: 'connections',
}

/**
 * The workspace settings section a hash addresses: `#workspace-settings/<section>`
 * (an unknown section falls back to General), or one of the retired
 * `#settings/workspace|memory|connections` links. `undefined` when the
 * hash is not a workspace settings link at all.
 */
export function workspaceSettingsSectionFromHash(
  hash: string
): WorkspaceSettingsSection | undefined {
  if (hash === workspaceSettingsHashPrefix || hash.startsWith(`${workspaceSettingsHashPrefix}/`)) {
    const candidate = hash.slice(workspaceSettingsHashPrefix.length + 1)
    return workspaceSettingsSections.includes(candidate as WorkspaceSettingsSection)
      ? (candidate as WorkspaceSettingsSection)
      : 'general'
  }
  const legacy = /^#settings\/([^/?#]+)$/.exec(hash)?.[1]
  return legacy && Object.hasOwn(legacyWorkspaceSettingsSections, legacy)
    ? legacyWorkspaceSettingsSections[legacy]
    : undefined
}

/** The canonical deep link for one workspace settings section. */
export function workspaceSettingsHash(section: WorkspaceSettingsSection) {
  return `${workspaceSettingsHashPrefix}/${section}`
}

/**
 * True for any hash that opens the Settings dialog: the canonical
 * `#settings/<section>` or a retired `#workspace-settings/<section>` link.
 * Kept here so the navigation entry reads it without the Settings tables.
 */
export function isSettingsHash(hash: string): boolean {
  return hash.startsWith('#settings') || hash.startsWith(workspaceSettingsHashPrefix)
}
