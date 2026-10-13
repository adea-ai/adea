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
import { batch, createEffect, createRoot, createSignal, untrack, type Accessor } from 'solid-js'

import {
  createVersionedPersistence,
  defaultThemeSelection,
  type ThemeContextValue,
  type ThemeSelection,
} from '@adea-ai/ui/components/theme'
import {
  adeaV2Codec,
  appearanceSchema,
  APPEARANCE_STORAGE_KEY,
  defaultAppearancePreferences,
  type AppearancePreferencesV2,
} from '@adea-ai/app-ui/components/appearance-codec'
import { createAppearanceContext } from '@adea-ai/app-ui/components/appearance-host'
import { createAppearanceEditor, type AppearanceEditor } from '../src/appearance/editor'

function memoryStorage() {
  const store = new Map<string, string>()
  return {
    store,
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
  }
}

/**
 * The shared ThemeProvider's seam as the host sees it, reduced to its contract:
 * a committed selection signal that persists through the real V2 codec,
 * `setSelection` that commits and ends any open preview (the shared provider's
 * rule), `preview` that lays a draft over the committed selection, and the
 * resolved appearance the document is painted from. The document write itself is
 * the shared provider's and is covered by its own tests; here `dark` on the root
 * stands for it. Resolved against the E2E lane: light OS appearance.
 */
function createSharedProviderHarness(storage: ReturnType<typeof memoryStorage>) {
  const persistence = createVersionedPersistence(appearanceSchema, adeaV2Codec, {
    storage: () => storage,
  })
  const [selection, setCommitted] = createSignal<ThemeSelection>({
    ...defaultThemeSelection,
    ...persistence.read(),
  })
  const [drafted, setDrafted] = createSignal<Partial<ThemeSelection> | undefined>()
  const shown = () => ({ ...selection(), ...drafted() })
  const resolvedAppearance = () => (shown().appearance === 'dark' ? 'dark' : 'light')
  // What the shared provider writes onto the root, read straight from the signals.
  const classes = { has: (name: string) => name === 'dark' && resolvedAppearance() === 'dark' }
  const ui = {
    selection,
    setSelection: (patch: Partial<ThemeSelection>) =>
      batch(() => {
        const next = { ...selection(), ...patch }
        setCommitted(next)
        setDrafted(undefined)
        persistence.write(next)
      }),
    preview: (patch: Partial<ThemeSelection> | undefined) => setDrafted(patch),
    previewing: () => drafted() !== undefined,
    resolvedAppearance,
    variant: () => ({
      id: shown().appearance === 'dark' ? shown().darkThemeId : shown().lightThemeId,
    }),
  } as unknown as ThemeContextValue
  return { ui, classes }
}

/**
 * The host's own context over that provider: what the appearance dialog consumes.
 */
function createProviderHarness(storage = memoryStorage()) {
  const shared = createSharedProviderHarness(storage)
  const appearance = createAppearanceContext(shared.ui)
  return { appearance, classes: shared.classes, storage }
}

/** The dialog's reactive surface the E2E flow touches (see appearance-surface.tsx). */
type DialogHarness = {
  draft: AppearanceEditor['draft']
  setDraft: (patch: Partial<AppearancePreferencesV2>) => void
  requestClose: () => void
}

// Signal writes flush effects on the microtask queue, but the exact scheduler
// depth is an implementation detail: a single microtask hop raced Solid's
// effect flush and failed this test nondeterministically under `bun test`.
// Drain macrotasks until the reactive outcome lands, like the E2E's
// expect(...).toBeVisible() retries across the same gap.
async function settle_until(check: () => boolean): Promise<void> {
  for (let hop = 0; hop < 20 && !check(); hop += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

describe('appearance dialog cancel/re-open (E2E appearance.spec contract)', () => {
  test('cancel reverts the draft and a re-opened dialog keeps previewing', async () => {
    const storage = memoryStorage()
    let harness!: ReturnType<typeof createProviderHarness>

    const [appearanceOpen, setAppearanceOpen] = createSignal(false)
    let dialog: DialogHarness | undefined

    // The root factory is synchronous on purpose: Solid does not flush the
    // effect queue of a root whose factory suspended on an await, so the
    // reactive machine is rooted here and every wait happens in the test,
    // keeping the assertions inside the test rather than leaking them as
    // unhandled errors after it completes.
    const disposeRoot = createRoot((dispose) => {
      harness = createProviderHarness(storage)
      const { appearance } = harness
      createEffect(() => {
        if (!appearanceOpen()) {
          dialog = undefined
          return
        }
        const editor = createAppearanceEditor()
        // The dialog's snapshot-on-open effect (appearance-surface.tsx): it
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
      return dispose
    })
    const doc = { classes: harness.classes }
    expect(doc.classes.has('dark')).toBe(false)

    // E2E: openAppearance(page)
    setAppearanceOpen(true)
    await settle_until(() => dialog !== undefined)
    expect(dialog).toBeDefined()
    expect(dialog?.draft().mode).toBe('system')

    // E2E: draft Dark; the live preview turns the page dark.
    dialog?.setDraft({ mode: 'dark' })
    expect(dialog?.draft().mode).toBe('dark')
    expect(doc.classes.has('dark')).toBe(true)

    // E2E: Cancel; the dialog closes and the page reverts.
    dialog?.requestClose()
    await settle_until(() => !appearanceOpen())
    expect(appearanceOpen()).toBe(false)
    expect(dialog).toBeUndefined()
    expect(doc.classes.has('dark')).toBe(false)
    // Nothing was written: a preview is never persisted.
    expect(storage.store.has(APPEARANCE_STORAGE_KEY)).toBe(false)

    // E2E: re-open; the dialog is operable again from the committed state.
    setAppearanceOpen(true)
    await settle_until(() => dialog !== undefined)
    expect(dialog).toBeDefined()
    expect(dialog?.draft().mode).toBe('system')

    // E2E: draft Dark again; the live preview still applies.
    dialog?.setDraft({ mode: 'dark' })
    expect(doc.classes.has('dark')).toBe(true)

    // E2E: final Cancel.
    dialog?.requestClose()
    await settle_until(() => !doc.classes.has('dark'))
    expect(doc.classes.has('dark')).toBe(false)
    expect(storage.store.has(APPEARANCE_STORAGE_KEY)).toBe(false)

    disposeRoot()
  })

  test('save commits the draft through the stored V2 document', () => {
    const storage = memoryStorage()
    let harness!: ReturnType<typeof createProviderHarness>
    // Effects of a root flush when its factory returns, so the actions below run
    // after it, like the dialog's own event handlers.
    const dispose = createRoot((disposeRoot) => {
      harness = createProviderHarness(storage)
      return disposeRoot
    })
    const { appearance, classes } = harness
    const editor = createAppearanceEditor()
    editor.open(appearance.preferences())
    editor.set({ mode: 'dark', accent: 'blue', surface: 'frosted' })
    appearance.preview(editor.draft())
    expect(classes.has('dark')).toBe(true)
    expect(storage.store.has(APPEARANCE_STORAGE_KEY)).toBe(false)

    appearance.update(editor.save())
    appearance.preview(undefined)
    expect(classes.has('dark')).toBe(true)
    expect(JSON.parse(storage.store.get(APPEARANCE_STORAGE_KEY)!)).toMatchObject({
      version: 2,
      mode: 'dark',
      accent: 'blue',
      surface: 'frosted',
      terminalThemeId: 'theme',
    })
    expect(appearance.preferences()).toMatchObject({ mode: 'dark', accent: 'blue' })
    dispose()
  })

  test('a committed change while a draft is open leaves the draft showing', () => {
    let harness!: ReturnType<typeof createProviderHarness>
    const dispose = createRoot((disposeRoot) => {
      harness = createProviderHarness()
      return disposeRoot
    })
    const { appearance, classes, storage } = harness
    const editor = createAppearanceEditor()
    editor.open(appearance.preferences())
    editor.set({ mode: 'dark' })
    appearance.preview(editor.draft())
    expect(classes.has('dark')).toBe(true)

    // The mode toggle and the zoom chords commit straight to the provider, which
    // ends a preview; the open draft is still the user's, so it keeps showing.
    appearance.setTheme('light')
    expect(appearance.theme()).toBe('light')
    expect(JSON.parse(storage.store.get(APPEARANCE_STORAGE_KEY)!).mode).toBe('light')
    expect(classes.has('dark')).toBe(true)

    // Ending the draft returns to what was committed.
    appearance.preview(undefined)
    expect(classes.has('dark')).toBe(false)
    dispose()
  })

  test('the legacy accent spelling commits as the default preset', () => {
    let harness!: ReturnType<typeof createProviderHarness>
    const dispose = createRoot((disposeRoot) => {
      harness = createProviderHarness()
      return disposeRoot
    })
    harness.appearance.update({ accent: 'theme' })
    expect(harness.appearance.preferences().accent).toBe('violet')
    dispose()
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
