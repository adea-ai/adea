/*
 * Pins the editor mirror's theme wiring (app-bugs audit: "CodeMirror editor
 * is always light"). The mirror must colour every syntax role and piece of
 * chrome from the theme provider's `var()` tokens — the `--editor-*` ramp
 * and the semantic roles — so the surface follows the active theme (light,
 * dark, accent) instead of CodeMirror's hardcoded light defaults.
 */
import { describe, expect, test } from 'bun:test'

import { EDITOR_CHROME_SPEC, EDITOR_HIGHLIGHT_SPECS } from '../src/editor/editor-mirror'

/** Every syntax colour role the theme provider projects for the editor;
 *  `search-match` is consumed by the chrome (selection match) instead. */
const EDITOR_ROLE_TOKENS = [
  'keyword',
  'string',
  'number',
  'comment',
  'function',
  'variable',
  'type',
  'tag',
  'attribute',
  'operator',
  'heading',
  'link',
  'diff-add',
  'diff-delete',
] as const

/** Every string leaf in a spec object (colours, borders, layout values). */
function stringLeaves(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (Array.isArray(node)) return node.flatMap(stringLeaves)
  if (typeof node === 'object' && node !== null) return Object.values(node).flatMap(stringLeaves)
  return []
}

describe('editor mirror theme wiring', () => {
  test('every highlight spec colours from a theme token, never a literal', () => {
    expect(EDITOR_HIGHLIGHT_SPECS.length).toBeGreaterThan(0)
    for (const spec of EDITOR_HIGHLIGHT_SPECS) {
      expect(spec.color).toMatch(/^var\(--[a-z-]+\)$/)
    }
  })

  test('the published editor ramp is consumed role for role', () => {
    const colours = new Set(EDITOR_HIGHLIGHT_SPECS.map((spec) => spec.color))
    for (const role of EDITOR_ROLE_TOKENS) {
      expect(colours).toContain(`var(--editor-${role})`)
    }
  })

  test('chrome carries no colour literals', () => {
    for (const value of stringLeaves(EDITOR_CHROME_SPEC)) {
      expect(value.startsWith('#')).toBe(false)
      expect(value.startsWith('rgb')).toBe(false)
      expect(value.startsWith('oklch')).toBe(false)
    }
  })

  test('the chrome consumes the search-match role for selection matches', () => {
    expect(stringLeaves(EDITOR_CHROME_SPEC)).toContain('var(--editor-search-match)')
  })

  test('the chrome covers the light-only base-theme surfaces', () => {
    const keys = Object.keys(EDITOR_CHROME_SPEC)
    // The base theme paints these with hardcoded light greys through
    // &light/&dark-qualified rules; each needs a `&`-prefixed override.
    for (const key of [
      '&',
      '& .cm-content',
      '& .cm-cursor, & .cm-dropCursor',
      '& .cm-selectionBackground',
      '& .cm-gutters',
      '& .cm-activeLine',
    ]) {
      expect(keys).toContain(key)
    }
  })
})
