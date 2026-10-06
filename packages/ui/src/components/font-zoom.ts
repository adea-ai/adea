/*
 * Copyright (c) 2026 Wing
 * Licensed under the MIT License.
 *
 * The platform zoom chords, mapped onto Adea's three text roles.
 *
 * macOS (and Windows/Linux) zoom shortcuts — Cmd/Ctrl with `=`, `+`, `-`, or
 * `0` — normally scale the browser's page zoom. In Adea every text element is
 * already tied to one of the three appearance font tiers (the UI tier drives
 * the whole `text-*` scale through `--font-ui-scale`; content and code roles
 * scale through their own tokens), so stepping those tiers reproduces zoom
 * while keeping the app inside its tokenized, persisted type system: the page
 * layout, menus, sheets, and terminals reflow live from the same projection
 * the appearance editor writes.
 */
import {
  APPEARANCE_EDITOR_FONT_AXES,
  APPEARANCE_EDITOR_FONT_SIZE_MAX,
  APPEARANCE_EDITOR_FONT_SIZE_MIN,
  normalizeAppearanceEditorFontSettings,
  type AppearanceEditorFontSettings,
} from '@adea-ai/ui/lib/appearance-font-settings'

/** What the user's zoom chord asked for. */
export type FontZoomIntent = 'in' | 'out' | 'reset'

/**
 * Classify the platform zoom chord: Cmd (macOS) or Ctrl (other platforms)
 * with `=`/`+` zooming in, `-` zooming out, and `0` resetting to the System
 * defaults. Unmodified keys, Alt-modified chords, and IME composition never
 * count, so typing and text editing are untouched.
 */
export function fontZoomShortcut(event: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  isComposing?: boolean
}): FontZoomIntent | undefined {
  if (event.isComposing || event.altKey) return undefined
  if (!(event.metaKey || event.ctrlKey)) return undefined
  if (event.key === '=' || event.key === '+') return 'in'
  if (event.key === '-') return 'out'
  if (event.key === '0') return 'reset'
  return undefined
}

/** Clamp a pixel size to the shared range the appearance editor enforces. */
function clampFontSize(size: number): number {
  return Math.min(APPEARANCE_EDITOR_FONT_SIZE_MAX, Math.max(APPEARANCE_EDITOR_FONT_SIZE_MIN, size))
}

/**
 * Step every text tier by `delta` pixels, clamped to that range. The axes move
 * together — that is what makes the chord read as zoom — and each keeps its
 * own family choice.
 */
export function stepAppearanceFontSizes(
  fonts: unknown,
  delta: 1 | -1
): AppearanceEditorFontSettings {
  const current = normalizeAppearanceEditorFontSettings(fonts).settings
  return {
    ui: { ...current.ui, size: clampFontSize(current.ui.size + delta) },
    content: { ...current.content, size: clampFontSize(current.content.size + delta) },
    code: { ...current.code, size: clampFontSize(current.code.size + delta) },
  }
}

/** Every axis name, for callers that want to report or test the stepping. */
export const FONT_ZOOM_AXES = APPEARANCE_EDITOR_FONT_AXES
