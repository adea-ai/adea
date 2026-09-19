// macOS host-permission DTOs shared by the desktop shell's bridge command
// surface and the single web UI's permissions page (issue #471). These ride
// the guarded legacy invoke path behind the M10 channel gate — never the
// browser context — and mirror the donor status taxonomy (Orca's
// DeveloperPermissionState, MIT) narrowed to states a host probe can actually
// prove. `unavailable` is a first-class state, not an error: a host that lacks
// a probe (or a web tab with no bridge at all) reports it truthfully instead
// of guessing.
//
// The settings deep links are NOT part of this contract: the shell owns the
// only copy of the pane table, so a client can never open an arbitrary URL —
// it names a permission id and the shell opens the fixed pane.

/** The macOS TCC permissions a shipped Adea feature depends on. */
export const macPermissionIds = [
  'accessibility',
  'screen_recording',
  'notifications',
  'automation_apple_events',
  'microphone',
] as const

export type MacPermissionId = (typeof macPermissionIds)[number]

/**
 * Probe-provable status. The donor's `not-determined`/`restricted` collapse
 * here into `not_determined` (the TCC prompt is pending or was never shown)
 * because the shell's command-line probes cannot distinguish an MDM
 * restriction from a prompt; `unavailable` means this host lane has no probe
 * at all — it is never a stand-in for denied or granted.
 */
export const macPermissionStates = ['granted', 'denied', 'not_determined', 'unavailable'] as const

export type MacPermissionState = (typeof macPermissionStates)[number]

/** Why a permission could not be probed at all. */
export const macPermissionUnavailableReasons = [
  /** This host/lane ships no probe for the permission. */
  'capability_unavailable',
  /** The host platform is not macOS; no permission applies. */
  'unsupported_platform',
] as const

export type MacPermissionUnavailableReason = (typeof macPermissionUnavailableReasons)[number]

/** One permission's freshly probed status. */
export type MacPermissionReport = Readonly<{
  id: MacPermissionId
  state: MacPermissionState
  /** Present exactly when `state` is `unavailable`. */
  unavailableReason?: MacPermissionUnavailableReason
  /** RFC 3339 timestamp of this probe (or of the unavailability decision). */
  probedAt: string
}>

/**
 * The shell's permission snapshot. `hostPlatform` is probed, not asserted: a
 * non-macOS build reports `other` with every permission unavailable, and a
 * lane with no shell at all (plain web tab) reports `unknown` — neither ever
 * renders as granted or denied.
 */
export type MacPermissionsSnapshot = Readonly<{
  hostPlatform: 'macos' | 'other' | 'unknown'
  permissions: readonly MacPermissionReport[]
  probedAt: string
}>

/** The shell's answer to an open-System-Settings request. */
export type MacPermissionSettingsOpenResult = Readonly<{
  permissionId: MacPermissionId
  /** The exact fixed deep link the shell handed to the OS opener. */
  settingsUrl: string
}>

export function isMacPermissionId(value: unknown): value is MacPermissionId {
  return typeof value === 'string' && (macPermissionIds as readonly string[]).includes(value)
}
