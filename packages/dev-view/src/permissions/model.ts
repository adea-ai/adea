/*
 * macOS permissions page model (issue #471): pure presentation logic for the
 * permission rows, translated from Orca's developer-permission-status.ts and
 * DeveloperPermissionsPane.tsx row scaffolding (MIT, revision 403b62a8) to
 * Adea's token layer and typed capability contract. Kept DOM-free so the
 * status mapping, action affordances, dependent-feature degradation, and
 * screen-reader announcements are testable without rendering (the same bar
 * the Dev View a11y model sets). See NOTICE and
 * docs/research/dev-view-donor-audit.md.
 */
import {
  macPermissionIds,
  type MacPermissionId,
  type MacPermissionReport,
  type MacPermissionsSnapshot,
  type MacPermissionUnavailableReason,
} from '@adea-ai/types/desktop-permissions'

export type PermissionTone = 'ready' | 'attention' | 'blocked' | 'unknown'

export type PermissionPresentation = Readonly<{
  tone: PermissionTone
  label: string
  /** Why, in plain language — including the probe gap for unavailable rows. */
  hint: string
}>

export type PermissionActionKind = 'request' | 'open-settings'

export type PermissionAction = Readonly<{
  kind: PermissionActionKind
  label: string
}>

/** Static row metadata: what the permission is for, and what breaks without it. */
export type PermissionRowMeta = Readonly<{
  id: MacPermissionId
  title: string
  /** Plain-language purpose (the issue's "recorded feature reason"). */
  purpose: string
  /** Feature-level consequence of denial — honest degradation, not an error at use time. */
  consequence: string
}>

/**
 * The permissions this lane can actually probe with fixed-argv host commands.
 * Mirrors the shell's probe registry (apps/desktop/shell/src/desktop-permissions.ts);
 * both sides are pinned by tests and by the Dev Runtime spec's capability
 * matrix, so the page never promises a Request affordance the shell can't run.
 */
export const PROBE_SUPPORTED_PERMISSIONS: readonly MacPermissionId[] = Object.freeze([
  'accessibility',
  'automation_apple_events',
])

/**
 * Row metadata in page order (UX contract: Accessibility; Screen Recording;
 * Notifications; Automation/Apple Events; microphone — each with its recorded
 * feature reason). Only shipped-feature permissions are listed.
 */
export const PERMISSION_ROWS: readonly PermissionRowMeta[] = Object.freeze([
  {
    id: 'accessibility',
    title: 'Accessibility',
    purpose: 'Lets Adea drive other apps’ UI for computer-use sessions and scripted automation.',
    consequence: 'Computer-use sessions and UI automation cannot start.',
  },
  {
    id: 'screen_recording',
    title: 'Screen Recording',
    purpose: 'Lets Adea capture the screen for computer-use live view and screenshots.',
    consequence: 'Computer-use screen capture and live view cannot start.',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    purpose: 'Delivers mention and task notifications when Adea is in the background.',
    consequence: 'Mention and task notifications cannot reach you.',
  },
  {
    id: 'automation_apple_events',
    title: 'Automation (Apple Events)',
    purpose:
      'Lets Dev Runtime scripts control local apps (checked against Finder; macOS grants per target).',
    consequence: 'Scripts cannot control local apps with Apple Events.',
  },
  {
    id: 'microphone',
    title: 'Microphone',
    purpose: 'Feeds dictation and voice input.',
    consequence: 'Dictation and voice input stay unavailable.',
  },
] satisfies readonly PermissionRowMeta[])

const UNAVAILABLE_HINTS: Readonly<Record<MacPermissionUnavailableReason, string>> = Object.freeze({
  capability_unavailable: 'This lane has no probe for this permission — verify in System Settings.',
  unsupported_platform: 'Not applicable: this host is not macOS.',
})

export function rowMeta(id: MacPermissionId): PermissionRowMeta {
  const meta = PERMISSION_ROWS.find((row) => row.id === id)
  if (!meta) throw new Error(`no page row is registered for permission ${id}`)
  return meta
}

/** Status copy and tone for a probed (or honestly unprobed) permission. */
export function presentPermission(report: MacPermissionReport): PermissionPresentation {
  switch (report.state) {
    case 'granted':
      return { tone: 'ready', label: 'Granted', hint: '' }
    case 'denied':
      return {
        tone: 'blocked',
        label: 'Denied',
        hint: `${rowMeta(report.id).consequence} Re-check after changing it in System Settings.`,
      }
    case 'not_determined':
      return {
        tone: 'attention',
        label: 'Not requested',
        hint: 'macOS is waiting for your answer, or Adea has not asked yet.',
      }
    case 'unavailable':
      return {
        tone: 'unknown',
        label: 'Cannot check',
        hint:
          report.unavailableReason !== undefined
            ? UNAVAILABLE_HINTS[report.unavailableReason]
            : UNAVAILABLE_HINTS.capability_unavailable,
      }
  }
}

/**
 * The affordances a row offers for its current state. `denied` never offers
 * Request (macOS ignores re-prompts once denied) — the repair path is the
 * exact System Settings pane. Request runs a probe, which is what surfaces
 * the macOS consent prompt for not-yet-answered permissions.
 */
export function actionsFor(report: MacPermissionReport): readonly PermissionAction[] {
  if (report.state === 'granted') return []
  if (report.state === 'not_determined' && PROBE_SUPPORTED_PERMISSIONS.includes(report.id)) {
    return [{ kind: 'request', label: 'Request' }, openSettingsAction()]
  }
  return [openSettingsAction()]
}

function openSettingsAction(): PermissionAction {
  return { kind: 'open-settings', label: 'Open System Settings' }
}

/** Page grouping (UX contract: primary system-control rows first). */
export const PERMISSION_GROUPS: readonly Readonly<{
  id: string
  heading: string
  permissionIds: readonly MacPermissionId[]
}>[] = Object.freeze([
  {
    id: 'system-control',
    heading: 'System control',
    permissionIds: ['accessibility', 'screen_recording'],
  },
  {
    id: 'system-interactions',
    heading: 'System interactions',
    permissionIds: ['automation_apple_events', 'notifications', 'microphone'],
  },
])

export type PermissionGroupView = Readonly<{
  id: string
  heading: string
  rows: readonly Readonly<{ meta: PermissionRowMeta; report: MacPermissionReport }>[]
}>

/** Groups the snapshot's reports by page section; never invents rows. */
export function groupPermissions(snapshot: MacPermissionsSnapshot): readonly PermissionGroupView[] {
  const byId = new Map(snapshot.permissions.map((report) => [report.id, report]))
  return PERMISSION_GROUPS.map((group) => ({
    id: group.id,
    heading: group.heading,
    rows: group.permissionIds.flatMap((id) => {
      const report = byId.get(id)
      return report ? [{ meta: rowMeta(id), report }] : []
    }),
  }))
}

/**
 * Screen-reader text for a status change between two snapshots of the same
 * permission. `undefined` when nothing the user must know changed — a live
 * region must stay quiet unless state actually moved.
 */
export function stateChangeAnnouncement(
  before: MacPermissionReport | undefined,
  after: MacPermissionReport
): string | undefined {
  if (!before || before.state === after.state) return undefined
  return `${rowMeta(after.id).title} permission is now ${presentPermission(after).label.toLowerCase()}`
}

/** The summary line under the page heading ("2 need attention" pattern). */
export function snapshotSummary(snapshot: MacPermissionsSnapshot): string {
  if (snapshot.hostPlatform !== 'macos') {
    return snapshot.hostPlatform === 'unknown'
      ? 'The desktop shell is not connected, so permission states cannot be checked here.'
      : 'This host is not macOS; permissions do not apply here.'
  }
  const blocked = snapshot.permissions.filter(
    (report) => report.state === 'denied' || report.state === 'not_determined'
  ).length
  if (blocked === 0) {
    const unchecked = snapshot.permissions.filter((report) => report.state === 'unavailable').length
    return unchecked > 0
      ? 'Nothing needs attention. Some permissions cannot be checked from this lane.'
      : 'Everything Adea depends on is granted.'
  }
  const noun = blocked === 1 ? 'permission needs' : 'permissions need'
  return `${blocked} ${noun} your attention.`
}

/** Every page row is present in a well-formed snapshot, exactly once. */
export function snapshotCoversAllRows(snapshot: MacPermissionsSnapshot): boolean {
  const ids = snapshot.permissions.map((report) => report.id)
  return (
    ids.length === macPermissionIds.length &&
    macPermissionIds.every((id) => ids.includes(id)) &&
    new Set(ids).size === ids.length
  )
}
