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
  accent: 'theme',
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
    editor.set({ mode: 'light', lightThemeId: 'slate-light' })
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

  test('differsFromDefaults drives the Reset affordance', () => {
    const editor = createAppearanceEditor(committed)
    editor.open(committed)
    expect(editor.differsFromDefaults()).toBe(true)
    editor.reset()
    expect(editor.differsFromDefaults()).toBe(false)
  })
})
