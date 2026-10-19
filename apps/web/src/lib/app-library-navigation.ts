import type { RailPreferencesV1 } from '@adea-ai/workspace-ui/rail-preferences'
import { resolveWorkspaceApp, type WorkspaceAppId } from '@adea-ai/workspace-ui/workspace-apps'

/**
 * What the App Library does with the current destination.
 *
 * The App Library is where the workspace's destinations live when the rail
 * cannot show them: a destination the profile has not enabled, a destination
 * that was hidden, or every destination disabled at once. The rules that decide
 * what happens next are collected here so they are one composed decision rather
 * than a branch inside the navigation component:
 *
 * - a recorded preference change moves to the destination that now resolves,
 *   and never moves at all while the App Library is open: the user has not
 *   chosen a destination yet, so recording a change must not dismiss the
 *   library before they do;
 * - a request for a destination that is not in the rail opens the App Library
 *   rather than silently landing somewhere else;
 * - the recovery pass rewrites a stale or unreachable destination, and the
 *   App Library itself is a real destination.
 */
export type AppLibraryNavigation =
  | Readonly<{ kind: 'stay' }>
  | Readonly<{ kind: 'open-library'; replace: boolean }>
  | Readonly<{ kind: 'open-app'; appId: WorkspaceAppId; replace: boolean }>

export type AppLibraryNavigationInput = Readonly<{
  /** The recorded rail preferences. */
  preferences: RailPreferencesV1
  /** The destination the current request asks for. */
  requestedAppId: string
}>

/**
 * What a recorded preference change does to the destination.
 *
 * The App Library stays open across the change: enabling or hiding an app is a
 * customization, not a navigation, and the user opens a destination explicitly.
 */
export function appLibraryNavigationForPreferenceChange(
  input: AppLibraryNavigationInput & Readonly<{ libraryOpen: boolean }>
): AppLibraryNavigation {
  const destination = resolveWorkspaceApp(input.preferences, input.requestedAppId)
  if (!destination) return { kind: 'open-library', replace: true }
  if (input.libraryOpen) return { kind: 'stay' }
  if (destination.id !== input.requestedAppId)
    return { kind: 'open-app', appId: destination.id, replace: true }
  return { kind: 'stay' }
}

/**
 * What a request for a destination does when that destination is not in the
 * rail. The App Library opens instead: the request is not silently redirected
 * to another destination.
 */
export function appLibraryNavigationForRequestedView(
  input: AppLibraryNavigationInput
): AppLibraryNavigation {
  const destination = resolveWorkspaceApp(input.preferences, input.requestedAppId)
  if (!destination || destination.id !== input.requestedAppId)
    return { kind: 'open-library', replace: false }
  return { kind: 'stay' }
}

/**
 * The recovery pass. A destination that no longer resolves, or one that no
 * longer matches the request, is rewritten; the App Library is a real
 * destination and is never dismissed by the recovery itself.
 */
export function appLibraryNavigationForRecovery(
  input: AppLibraryNavigationInput & Readonly<{ libraryOpen: boolean }>
): AppLibraryNavigation {
  if (input.libraryOpen) return { kind: 'stay' }
  const destination = resolveWorkspaceApp(input.preferences, input.requestedAppId)
  if (!destination) return { kind: 'open-library', replace: true }
  if (destination.id !== input.requestedAppId)
    return { kind: 'open-app', appId: destination.id, replace: true }
  return { kind: 'stay' }
}
