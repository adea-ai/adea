/*
 * The App Library's selection decisions, composed.
 *
 * The App Library is where the workspace's destinations live when the rail
 * cannot show them. Two interactions matter and are only reachable through the
 * navigation component: a REPEATED selection, and an INTERRUPTED one.
 *
 * - A repeated selection is idempotent: recording the same change again, or
 *   asking again for the destination that is already open, moves nowhere.
 * - An interrupted selection is not a navigation: while the App Library is
 *   open, the user has not chosen a destination yet, so recording a change must
 *   not dismiss the library before they do — and enabling the first app again
 *   leaves the library reachable rather than stranding the workspace.
 *
 * The rail preferences are the real persisted record, and the destination
 * resolution is the real one; only the profile storage is mocked.
 */
import { describe, expect, test } from 'bun:test'

import {
  appLibraryNavigationForPreferenceChange,
  appLibraryNavigationForRecovery,
  appLibraryNavigationForRequestedView,
} from '../src/lib/app-library-navigation'
import {
  defaultRailPreferences,
  readRailPreferences,
  writeRailPreferences,
} from '@adea-ai/workspace-ui/rail-preferences'
import { setWorkspaceAppEnabled } from '@adea-ai/workspace-ui/workspace-apps'

/** The profile-local storage the App Library record is written into. */
function profileStorage(bytes: Map<string, string> = new Map()) {
  return {
    bytes,
    storage: {
      getItem: (key: string) => bytes.get(key) ?? null,
      setItem: (key: string, value: string) => void bytes.set(key, value),
    },
  }
}

describe('App Library selection', () => {
  test('a repeated selection moves nowhere', () => {
    const preferences = defaultRailPreferences
    const first = appLibraryNavigationForRequestedView({
      preferences,
      requestedAppId: 'chat',
    })
    const second = appLibraryNavigationForRequestedView({
      preferences,
      requestedAppId: 'chat',
    })
    expect(first).toEqual({ kind: 'stay' })
    expect(second).toEqual(first)
  })

  test('recording the same change twice is idempotent', () => {
    const { storage } = profileStorage()
    const changed = setWorkspaceAppEnabled(defaultRailPreferences, 'dev', false)

    writeRailPreferences(storage, changed)
    const afterFirst = readRailPreferences(storage)
    writeRailPreferences(storage, changed)
    const afterSecond = readRailPreferences(storage)

    expect(afterFirst).toEqual(afterSecond)
    expect(afterFirst.hidden).toEqual(['dev'])
  })

  test('an interrupted selection does not dismiss the App Library', () => {
    // The user hides the destination they are on, from the library itself.
    const changed = setWorkspaceAppEnabled(defaultRailPreferences, 'chat', false)

    // The library is open and the user has not chosen a destination yet.
    const navigation = appLibraryNavigationForPreferenceChange({
      preferences: changed,
      requestedAppId: 'chat',
      libraryOpen: true,
    })

    expect(navigation).toEqual({ kind: 'stay' })
    // Without the library open, the same change moves to the destination that
    // now resolves.
    expect(
      appLibraryNavigationForPreferenceChange({
        preferences: changed,
        requestedAppId: 'chat',
        libraryOpen: false,
      })
    ).toEqual({ kind: 'open-app', appId: 'dev', replace: true })
  })

  test('an interrupted selection still leaves a reachable destination', () => {
    // Every destination disabled: the App Library is the recovery destination.
    let preferences = setWorkspaceAppEnabled(defaultRailPreferences, 'dev', false)
    preferences = setWorkspaceAppEnabled(preferences, 'chat', false)
    expect(
      appLibraryNavigationForRecovery({ preferences, requestedAppId: 'chat', libraryOpen: true })
    ).toEqual({ kind: 'stay' })
    expect(
      appLibraryNavigationForRecovery({ preferences, requestedAppId: 'chat', libraryOpen: false })
    ).toEqual({ kind: 'open-library', replace: true })

    // Enabling the first app again makes the request resolvable, and the
    // library is still where the user is.
    const restored = setWorkspaceAppEnabled(preferences, 'chat', true)
    expect(
      appLibraryNavigationForRecovery({
        preferences: restored,
        requestedAppId: 'chat',
        libraryOpen: true,
      })
    ).toEqual({ kind: 'stay' })
    expect(
      appLibraryNavigationForRequestedView({ preferences: restored, requestedAppId: 'chat' })
    ).toEqual({ kind: 'stay' })
  })

  test('a request for a destination that is not in the rail opens the App Library', () => {
    const withoutKanban = setWorkspaceAppEnabled(defaultRailPreferences, 'kanban', false)

    expect(
      appLibraryNavigationForRequestedView({
        preferences: withoutKanban,
        requestedAppId: 'kanban',
      })
    ).toEqual({ kind: 'open-library', replace: false })
  })

  test('a recorded change that hides the open destination moves to the one that resolves', () => {
    const changed = setWorkspaceAppEnabled(defaultRailPreferences, 'chat', false)

    const navigation = appLibraryNavigationForPreferenceChange({
      preferences: changed,
      requestedAppId: 'chat',
      libraryOpen: false,
    })

    expect(navigation).toEqual({ kind: 'open-app', appId: 'dev', replace: true })
  })

  test('the recovery pass rewrites a destination that no longer matches the request', () => {
    const changed = setWorkspaceAppEnabled(defaultRailPreferences, 'dev', false)

    expect(
      appLibraryNavigationForRecovery({
        preferences: changed,
        requestedAppId: 'dev',
        libraryOpen: false,
      })
    ).toEqual({ kind: 'open-app', appId: 'chat', replace: true })
    expect(
      appLibraryNavigationForRecovery({
        preferences: changed,
        requestedAppId: 'chat',
        libraryOpen: false,
      })
    ).toEqual({ kind: 'stay' })
  })
})
