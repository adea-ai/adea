// Issue #396 pane experience models: permissioned clipboard copy with typed
// denial degradation, in-pane search state with match counts, typed fallback
// shell selection (never a silent default), and the TUI/IME-safe surface key
// routing.
import { describe, expect, test } from 'bun:test'
import type { ShellProfile } from '@adea-ai/types/dev-runtime'

import {
  applyCopyOutcome,
  classifyClipboardFailure,
  clipboardPresentation,
  createClipboardState,
} from '../src/terminal/clipboard'
import {
  chooseShellProfile,
  createShellSelection,
  profileIntegrationNote,
  shellKindOf,
  shellSelectionPresentation,
} from '../src/terminal/shell-fallback'
import { isImeComposing, routePaneKey } from '../src/terminal/pane-keys'
import {
  createSearchState,
  searchClose,
  searchOpen,
  searchPresentation,
  searchSetQuery,
  searchSetResults,
  searchStep,
  searchToggleCaseSensitive,
} from '../src/terminal/search-model'

function profile(id: string, label: string, argv0: string): ShellProfile {
  return {
    id,
    scope: { accountId: 'a', workspaceId: 'w', runtimeNodeId: 'r' },
    label,
    argv: [argv0, '-l'],
    envAllowlistKeys: ['HOME'],
    builtin: true,
    version: 1,
  }
}

describe('permissioned clipboard copy', () => {
  test('a denial degrades the affordance typed, with a repair hint', () => {
    let state = createClipboardState()
    expect(clipboardPresentation(state)).toMatchObject({ label: 'Copy', degraded: false })
    state = applyCopyOutcome(state, 'denied')
    const presentation = clipboardPresentation(state)
    expect(presentation.degraded).toBe(true)
    expect(presentation.label).toBe('Copy blocked')
    expect(presentation.hint).toContain('system copy shortcut')
    expect(presentation.announcement).toContain('denied')
  })

  test('an unavailable clipboard API is distinct from a denial', () => {
    const state = applyCopyOutcome(createClipboardState(), 'unavailable')
    expect(clipboardPresentation(state).label).toBe('Copy unavailable')
    expect(clipboardPresentation(state).degraded).toBe(true)
  })

  test('granted copy reports success without degrading', () => {
    const state = applyCopyOutcome(createClipboardState(), 'granted')
    const presentation = clipboardPresentation(state)
    expect(presentation.label).toBe('Copied')
    expect(presentation.degraded).toBe(false)
  })

  test('failures classify: permission refusal is denied, everything else unavailable', () => {
    expect(classifyClipboardFailure(new DOMException('nope', 'NotAllowedError'))).toBe('denied')
    expect(classifyClipboardFailure(new DOMException('secure', 'SecurityError'))).toBe('denied')
    expect(classifyClipboardFailure(new Error('weird'))).toBe('unavailable')
    expect(classifyClipboardFailure(undefined)).toBe('unavailable')
  })
})

describe('in-pane search state', () => {
  test('query, stepping, and results drive the live count', () => {
    let state = searchOpen(createSearchState())
    expect(searchPresentation(state).count).toBe('')
    state = searchSetQuery(state, 'bun test')
    expect(searchPresentation(state)).toMatchObject({ count: 'Searching…', steppable: false })
    state = searchSetResults(state, { resultCount: 12, resultIndex: 2 })
    expect(searchPresentation(state)).toEqual({ count: '3 of 12 matches', steppable: true })
    // An out-of-range index never fabricates an ordinal.
    state = searchSetResults(state, { resultCount: 3, resultIndex: 99 })
    expect(searchPresentation(state).count).toBe('3 of 3 matches')
  })

  test('zero matches and empty queries disable stepping honestly', () => {
    let state = searchSetQuery(searchOpen(createSearchState()), 'zzz')
    state = searchSetResults(state, { resultCount: 0, resultIndex: -1 })
    expect(searchPresentation(state)).toEqual({ count: 'No matches', steppable: false })
    // Stepping without a query is a no-op request.
    expect(searchStep(createSearchState(), 'next').requested).toBeUndefined()
  })

  test('close clears results and pending steps; case toggle invalidates results', () => {
    let state = searchSetResults(searchSetQuery(searchOpen(createSearchState()), 'x'), {
      resultCount: 2,
      resultIndex: 0,
    })
    state = searchStep(state, 'next')
    expect(state.requested).toBe('next')
    state = searchClose(state)
    expect(state).toMatchObject({ open: false, results: undefined, requested: undefined })
    state = searchToggleCaseSensitive(searchSetQuery(searchOpen(state), 'x'))
    expect(state.caseSensitive).toBe(true)
    expect(state.results).toBeUndefined()
  })
})

describe('typed fallback shell selection', () => {
  const profiles = [profile('p-zsh', 'zsh', '/bin/zsh'), profile('p-bash', 'bash', '/bin/bash')]
  const profilesWithUnknown = [...profiles, profile('p-elvish', 'elvish', '/usr/local/bin/elvish')]

  test('an available preferred shell is confirmed implicitly', () => {
    const selection = createShellSelection({ preferredShell: '/bin/zsh', profiles })
    expect(selection.choice).toMatchObject({ status: 'preferred', profile: profiles[0] })
    expect(selection.confirmed).toBe(true)
    expect(shellSelectionPresentation(selection).showChooser).toBe(false)
  })

  test('a missing preferred shell proposes a fallback that needs explicit confirmation', () => {
    const selection = createShellSelection({ preferredShell: '/usr/bin/nu', profiles })
    expect(selection.choice).toMatchObject({
      status: 'fallback',
      reason: 'preferred_missing',
      preferredShell: '/usr/bin/nu',
    })
    expect(selection.confirmed).toBe(false)
    const presentation = shellSelectionPresentation(selection)
    expect(presentation.showChooser).toBe(true)
    expect(presentation.heading).toContain('/usr/bin/nu')
    expect(presentation.detail).toContain('nothing starts until you pick')
  })

  test('an explicit pick confirms and reports exactly the chosen profile', () => {
    let selection = createShellSelection({ preferredShell: '/usr/bin/nu', profiles })
    selection = chooseShellProfile(selection, profiles, 'p-bash')
    expect(selection.confirmed).toBe(true)
    expect(selection.selectedProfileId).toBe('p-bash')
    expect(shellSelectionPresentation(selection).showChooser).toBe(false)
  })

  test('an unknown profile id never confirms', () => {
    const selection = createShellSelection({ preferredShell: '/usr/bin/nu', profiles })
    expect(chooseShellProfile(selection, profiles, 'p-ghost').confirmed).toBe(false)
  })

  test('no preference or no profiles resolves without inventing a default', () => {
    const noPreference = createShellSelection({ profiles })
    expect(noPreference.choice).toMatchObject({ status: 'unresolved', reason: 'no_preference' })
    expect(shellSelectionPresentation(noPreference).showChooser).toBe(true)
    const noProfiles = createShellSelection({ preferredShell: '/bin/zsh', profiles: [] })
    expect(noProfiles.choice).toMatchObject({ status: 'unresolved', reason: 'no_profiles' })
    const presentation = shellSelectionPresentation(noProfiles)
    expect(presentation.showChooser).toBe(false)
    expect(presentation.detail).toContain('cannot start')
  })

  test('unknown-kind shells are selectable but honestly marked integration-less', () => {
    expect(shellKindOf('/usr/local/bin/elvish')).toBe('unknown')
    expect(shellKindOf('/bin/bash')).toBe('bash')
    expect(profileIntegrationNote(profilesWithUnknown[2]!)).toContain('without Adea shell integration')
    expect(profileIntegrationNote(profiles[0]!)).toBeUndefined()
  })
})

describe('surface key routing (TUI pass-through, IME-safe)', () => {
  const key = (overrides: Partial<Parameters<typeof routePaneKey>[0]> = {}) => ({
    key: 'x',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  })

  test('plain Ctrl+F and Ctrl+C reach the terminal untouched (readline regression)', () => {
    expect(routePaneKey(key({ key: 'f', ctrlKey: true }), 'raw')).toBe('none')
    expect(routePaneKey(key({ key: 'c', ctrlKey: true }), 'raw')).toBe('none')
  })

  test('search opens via Cmd+F and Ctrl+Shift+F; copy mirrors the convention', () => {
    expect(routePaneKey(key({ key: 'f', metaKey: true }), 'raw')).toBe('search')
    expect(routePaneKey(key({ key: 'F', ctrlKey: true, shiftKey: true }), 'raw')).toBe('search')
    expect(routePaneKey(key({ key: 'c', metaKey: true }), 'raw')).toBe('copy-selection')
    expect(routePaneKey(key({ key: 'C', ctrlKey: true, shiftKey: true }), 'raw')).toBe(
      'copy-selection'
    )
  })

  test('shifted Ctrl+C with alt and unmodified keys stay terminal-bound', () => {
    expect(routePaneKey(key({ key: 'C', ctrlKey: true, shiftKey: true, altKey: true }), 'raw')).toBe(
      'none'
    )
    expect(routePaneKey(key({ key: 'f' }), 'raw')).toBe('none')
  })

  test('IME composition keys are never intercepted', () => {
    expect(routePaneKey(key({ key: 'f', metaKey: true, isComposing: true }), 'raw')).toBe('none')
    expect(routePaneKey(key({ key: 'f', metaKey: true, keyCode: 229 }), 'raw')).toBe('none')
    expect(isImeComposing(key({ isComposing: true }))).toBe(true)
    expect(isImeComposing(key({ keyCode: 229 }))).toBe(true)
    expect(isImeComposing(key({}))).toBe(false)
  })

  test('routing is identical in both editor modes (raw mode is pass-through)', () => {
    for (const mode of ['compose', 'raw'] as const) {
      expect(routePaneKey(key({ key: 'a' }), mode)).toBe('none')
      expect(routePaneKey(key({ key: 'f', metaKey: true }), mode)).toBe('search')
    }
  })
})
