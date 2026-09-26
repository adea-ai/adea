/*
 * Pins the E2E contract of
 * apps/web/e2e/appearance.spec.ts "cancel reverts the draft and the OS
 * reduced-motion preference keeps the dialog operable" at the model level:
 * open the dialog, draft Dark (live preview), Cancel (revert + close),
 * re-open into a fresh dialog instance, draft Dark again, Cancel again.
 *
 * The `prefers-reduced-motion` half of the E2E scenario is CSS-only in this
 * app — no product script reads that media query, and the dialog carries no
 * enter/exit animation classes — so the operability contract it exercises is
 * exactly this reactive one. The hosting pattern mirrored here is the one in
 * the settings Appearance section (`AppearancePanel` from
 * `@adea-ai/dev-view/appearance`): entering the section mounts a fresh
 * instance, and leaving it disposes the instance and reverts the draft.
 */
import { describe, expect, test } from 'bun:test'
import { createEffect, createRoot, createSignal, untrack, type Accessor } from 'solid-js'

import {
  applyAppearanceToDocument,
  defaultAppearancePreferences,
  resolveAppearanceState,
  type AppearancePreferencesV2,
} from '@adea-ai/app-ui/components/appearance'
import { createAppearanceEditor, type AppearanceEditor } from '../src/appearance/editor'

type StyleRecord = Record<string, string>

function fakeDocument() {
  const style: StyleRecord = {}
  const dataset: Record<string, string> = {}
  const classes = new Set<string>()
  const document = {
    documentElement: {
      style: {
        colorScheme: '',
        setProperty: (name: string, value: string) => void (style[name] = value),
        removeProperty: (name: string) => void delete style[name],
      },
      dataset,
      classList: {
        toggle: (name: string, force: boolean) => {
          if (force) classes.add(name)
          else classes.delete(name)
        },
      },
    },
  }
  return { document, style, dataset, classes }
}

/**
 * The ThemeProvider contract the dialog consumes (the web app mounts one
 * ThemeProvider above the rail and the dialog): a committed-preferences
 * signal, `preview` applying a draft — or the committed state on `undefined`
 * — to the document without persisting, and `update` persisting. Resolved
 * against the E2E lane's environment: light OS appearance, no OS reduced
 * transparency, no native translucency.
 */
function createProviderHarness(doc: ReturnType<typeof fakeDocument>) {
  const [preferences, setPreferences] = createSignal<AppearancePreferencesV2>(
    defaultAppearancePreferences
  )
  const environment = {
    systemAppearance: 'light' as const,
    osReducedTransparency: false,
    nativeTranslucency: false,
  }
  const apply = (state: ReturnType<typeof resolveAppearanceState>) =>
    applyAppearanceToDocument(doc.document, state)
  // The provider's own effect: committed changes re-apply on their own.
  createEffect(() => apply(resolveAppearanceState(preferences(), environment)))
  return {
    preferences,
    preview: (draft: AppearancePreferencesV2 | undefined) => {
      apply(
        draft
          ? resolveAppearanceState(draft, environment)
          : resolveAppearanceState(preferences(), environment)
      )
    },
    update: (patch: Partial<AppearancePreferencesV2>) =>
      setPreferences({ ...preferences(), ...patch }),
  }
}

/** The dialog's reactive surface the E2E flow touches (see appearance-dialog.tsx). */
type DialogHarness = {
  draft: AppearanceEditor['draft']
  setDraft: (patch: Partial<AppearancePreferencesV2>) => void
  requestClose: () => void
}

// Signal writes outside a transaction flush effects on a microtask; the E2E's
// expect(...).toBeVisible() retries across the same gap.
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe('appearance dialog cancel/re-open (E2E appearance.spec contract)', () => {
  test('cancel reverts the draft and a re-opened dialog keeps previewing', async () => {
    createRoot(async (dispose) => {
      const doc = fakeDocument()
      const appearance = createProviderHarness(doc)

      expect(doc.classes.has('dark')).toBe(false)

      const [appearanceOpen, setAppearanceOpen] = createSignal(false)
      let dialog: DialogHarness | undefined

      createEffect(() => {
        if (!appearanceOpen()) {
          dialog = undefined
          return
        }
        const editor = createAppearanceEditor()
        // The dialog's snapshot-on-open effect (appearance-dialog.tsx): it
        // tracks the committed preferences only, never the draft.
        createEffect(() => {
          const committed = appearance.preferences()
          untrack(() => {
            editor.open(committed)
          })
        })
        const applyDraft = () => appearance.preview(editor.draft())
        dialog = {
          draft: editor.draft,
          setDraft: (patch) => {
            editor.set(patch)
            applyDraft()
          },
          requestClose: () => {
            appearance.preview(undefined)
            editor.revert()
            setAppearanceOpen(false)
          },
        }
      })

      // E2E: openAppearance(page)
      setAppearanceOpen(true)
      await settle()
      expect(dialog).toBeDefined()
      expect(dialog?.draft().mode).toBe('system')

      // E2E: draft Dark; the live preview turns the page dark.
      dialog?.setDraft({ mode: 'dark' })
      expect(dialog?.draft().mode).toBe('dark')
      expect(doc.classes.has('dark')).toBe(true)

      // E2E: Cancel; the dialog closes and the page reverts.
      dialog?.requestClose()
      await settle()
      expect(appearanceOpen()).toBe(false)
      expect(dialog).toBeUndefined()
      expect(doc.classes.has('dark')).toBe(false)

      // E2E: re-open; the dialog is operable again from the committed state.
      setAppearanceOpen(true)
      await settle()
      expect(dialog).toBeDefined()
      expect(dialog?.draft().mode).toBe('system')

      // E2E: draft Dark again; the live preview still applies.
      dialog?.setDraft({ mode: 'dark' })
      expect(doc.classes.has('dark')).toBe(true)

      // E2E: final Cancel.
      dialog?.requestClose()
      await settle()
      expect(doc.classes.has('dark')).toBe(false)

      dispose()
    })
  })

  test('draft reads stay accessors so the harness never snapshots mid-edit', () => {
    createRoot((dispose) => {
      const editor = createAppearanceEditor()
      const draft: Accessor<AppearancePreferencesV2> = editor.draft
      editor.open(defaultAppearancePreferences)
      editor.set({ mode: 'dark' })
      expect(draft().mode).toBe('dark')
      dispose()
    })
  })
})
