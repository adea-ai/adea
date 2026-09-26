/*
 * Copyright (c) 2026 Wing
 * Licensed under the MIT License.
 *
 * Draft/snapshot editing semantics substantially translated from Zeron
 * crates/ui/src/appearance.rs (the `set_mode`/`set_theme`/`set_accent`/
 * `set_surface` setter block), revision
 * 30a9a9537c5ec96226c87f4bf349b6f77c5dfb59: unchanged values no-op, and every
 * change resolves against the live palette immediately. Modified for Adea's
 * explicit save/revert popover contract: an open snapshot, draft preview,
 * Reset to defaults, Cancel back to the snapshot, Save to commit.
 * See NOTICE and docs/research/dev-view-donor-audit.md.
 */
import { createSignal } from 'solid-js'

import {
  defaultAppearancePreferences,
  normalizeAppearancePreferences,
  type AppearancePreferencesV2,
} from '@adea-ai/app-ui/components/appearance'

export type AppearanceEditor = Readonly<{
  /** The edited draft, reactive so dialog UI tracks every change. */
  draft: () => AppearancePreferencesV2
  /** True when the draft differs from the snapshot the editor opened with. */
  dirty: () => boolean
  /** True when the draft differs from the shipped defaults. */
  differsFromDefaults: () => boolean
  /** Begin editing: snapshot the committed preferences. */
  open: (committed: AppearancePreferencesV2) => void
  /** Set one or more draft fields; unchanged values no-op like Zeron's setters. */
  set: (patch: Partial<AppearancePreferencesV2>) => void
  /** Draft becomes the shipped defaults (still reversible until Save). */
  reset: () => void
  /** Discard the draft; the committed snapshot is authoritative again. */
  revert: () => AppearancePreferencesV2
  /** Commit the draft and clear the snapshot. */
  save: () => AppearancePreferencesV2
}>

function samePreferences(left: AppearancePreferencesV2, right: AppearancePreferencesV2): boolean {
  return (
    left.mode === right.mode &&
    left.lightThemeId === right.lightThemeId &&
    left.darkThemeId === right.darkThemeId &&
    left.accent === right.accent &&
    left.surface === right.surface &&
    left.reduceTransparency === right.reduceTransparency
  )
}

export function createAppearanceEditor(
  committed: AppearancePreferencesV2 = defaultAppearancePreferences
): AppearanceEditor {
  const [draft, setDraft] = createSignal<AppearancePreferencesV2>(committed)
  const [snapshot, setSnapshot] = createSignal<AppearancePreferencesV2>(committed)

  return {
    draft,
    dirty: () => !samePreferences(draft(), snapshot()),
    differsFromDefaults: () => !samePreferences(draft(), defaultAppearancePreferences),
    open: (value) => {
      const normalized = normalizeAppearancePreferences(value).value
      setSnapshot(normalized)
      setDraft(normalized)
    },
    set: (patch) => {
      const next = { ...draft(), ...patch }
      // Zeron's setters return early when the value did not change.
      if (samePreferences(next, draft())) return
      setDraft(next)
    },
    reset: () => {
      setDraft(defaultAppearancePreferences)
    },
    revert: () => {
      setDraft(snapshot())
      return snapshot()
    },
    save: () => {
      setSnapshot(draft())
      return draft()
    },
  }
}
