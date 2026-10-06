import { describe, expect, test } from 'bun:test'

import {
  defaultAppearancePreferences,
  type AppearancePreferencesV2,
} from '@adea-ai/app-ui/components/appearance'
import { createAppearanceEditor } from '../src/appearance/editor'

const committed: AppearancePreferencesV2 = {
  version: 2,
  mode: 'dark',
  lightThemeId: 'adea-light',
  darkThemeId: 'adea-dark',
  terminalThemeId: 'theme',
  accent: 'violet',
  surface: 'frosted',
  reduceTransparency: false,
}

describe('appearance editor (Zeron setter semantics with the save/revert contract)', () => {
  test('open snapshots the committed preferences', () => {
    const editor = createAppearanceEditor(committed)
    editor.open(committed)
    expect(editor.draft()).toEqual(committed)
    expect(editor.dirty()).toBe(false)
  })

  test('set applies single fields and previews the whole draft', () => {
    const editor = createAppearanceEditor(committed)
    editor.open(committed)
    editor.set({ mode: 'light' })
    expect(editor.draft().mode).toBe('light')
    expect(editor.draft().surface).toBe('frosted')
    expect(editor.dirty()).toBe(true)
  })

  test('setting an unchanged value is a no-op (Zeron setter semantics)', () => {
    const editor = createAppearanceEditor(committed)
    editor.open(committed)
    const before = editor.draft()
    editor.set({ mode: 'dark' })
    expect(editor.draft()).toBe(before)
  })

  test('the terminal theme participates in the dirty delta both ways', () => {
    const editor = createAppearanceEditor(committed)
    editor.open(committed)
    // samePreferences must compare terminalThemeId: without that clause this
    // set() would no-op, the draft would stay clean, and the terminal row
    // would never surface an unsaved change or a Save button.
    const before = editor.draft()
    editor.set({ terminalThemeId: 'theme' })
    expect(editor.draft()).toBe(before)
    expect(editor.dirty()).toBe(false)

    const pinned = editor.draft()
    editor.set({ terminalThemeId: 'dracula' })
    expect(editor.draft()).not.toBe(pinned)
    expect(editor.draft().terminalThemeId).toBe('dracula')
    expect(editor.dirty()).toBe(true)
    expect(editor.differsFromDefaults()).toBe(true)
  })

  test('reset targets the shipped defaults but stays reversible', () => {
    const editor = createAppearanceEditor(committed)
    editor.open(committed)
    editor.set({ accent: 'blue' })
    editor.reset()
    expect(editor.draft()).toEqual(defaultAppearancePreferences)
    expect(editor.dirty()).toBe(true)
    editor.revert()
    expect(editor.draft()).toEqual(committed)
  })

  test('revert restores the pre-open snapshot', () => {
    const editor = createAppearanceEditor(committed)
    editor.open(committed)
    editor.set({ mode: 'light', accent: '#2563eb', surface: 'translucent' })
    const restored = editor.revert()
    expect(restored).toEqual(committed)
    expect(editor.draft().mode).toBe('dark')
  })

  test('save commits the draft and clears the dirty delta', () => {
    const editor = createAppearanceEditor(committed)
    editor.open(committed)
    editor.set({ mode: 'light', lightThemeId: 'nord-light' })
    const saved = editor.save()
    expect(saved).toEqual(editor.draft())
    expect(editor.dirty()).toBe(false)
    editor.revert()
    expect(editor.draft()).toEqual(saved)
  })

  test('open normalizes a broken committed record instead of inheriting it', () => {
    const editor = createAppearanceEditor()
    editor.open({ version: 3 } as unknown as AppearancePreferencesV2)
    expect(editor.draft()).toEqual(defaultAppearancePreferences)
  })

  test('a legacy stored theme default migrates to the default accent on open', () => {
    // The default accent is the Violet preset; documents saved before the
    // default became a preset carry 'theme' (the theme's own primary), and
    // open() must not resurrect it as an unpickable editor state. The
    // migration applies to the draft and its snapshot alike, so an untouched
    // legacy record never presents itself as an unsaved change.
    const editor = createAppearanceEditor()
    editor.open({ ...committed, accent: 'theme' })
    expect(editor.draft().accent).toBe('violet')
    expect(editor.dirty()).toBe(false)
  })

  test('differsFromDefaults drives the Reset affordance', () => {
    const editor = createAppearanceEditor(committed)
    editor.open(committed)
    expect(editor.differsFromDefaults()).toBe(true)
    editor.reset()
    expect(editor.differsFromDefaults()).toBe(false)
  })
})

for (const axis of ['ui', 'content', 'code'] as const) {
  test(`${axis} font changes participate in preview, save, and rollback`, () => {
    const editor = createAppearanceEditor(committed)
    editor.open(committed)
    const fonts = {
      ui: { family: 'system', size: 14 },
      content: { family: 'system', size: 14 },
      code: { family: 'system', size: 12 },
    }
    editor.set({ fonts })
    expect(editor.dirty()).toBe(false)
    editor.set({ fonts: { ...fonts, [axis]: { family: 'geist-mono', size: 18 } } })
    expect(editor.dirty()).toBe(true)
    expect(editor.draft().fonts?.[axis]).toEqual({ family: 'geist-mono', size: 18 })
    editor.revert()
    expect(editor.dirty()).toBe(false)
    expect(editor.draft()).toEqual(committed)
    editor.set({ fonts: { ...fonts, [axis]: { family: 'geist', size: 20 } } })
    const saved = editor.save()
    expect(editor.dirty()).toBe(false)
    editor.reset()
    expect(editor.dirty()).toBe(true)
    expect(editor.revert()).toEqual(saved)
  })
}
