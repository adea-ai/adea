/*
 * Adea host adapter for the published @adea-ai/ui AppearanceEditor.
 *
 * The published component owns presentation only. This host keeps Adea's V2
 * preference schema, provider preview/persistence, native transparency policy,
 * accepted compatibility IDs, and declared-license theme-library flow.
 */
import {
  type AppearanceDraft,
  type AppearanceEditorProps,
} from '@adea-ai/ui/components/composites/appearance-editor'
import {
  accentPresets,
  accentPresetById,
  isThemeAccentId,
  subscribeCustomThemes,
  type AppearancePreferencesV2,
} from '@adea-ai/app-ui/components/appearance'
import { useTheme } from '@adea-ai/app-ui/components/theme-provider'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'
import { ModalDialog } from '@adea-ai/ui/components/ui/modal-dialog'
import { createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js'
import { MonitorCog } from 'lucide-solid'

import { readCustomThemeLibrary, removeCustomTheme } from '@adea-ai/app-ui/components/appearance'
import { For, Show } from 'solid-js'
import { themeAccentPresets } from '@adea-ai/themes'

import { AdeaAppearanceEditor, AdeaAppearancePopover } from './appearance-editor'
import { draftVariants } from './composition'
import { createAppearanceEditor } from './editor'
import { importCustomTheme } from './custom-theme-import'
import {
  allThemeRecords,
  appearanceThemeForPreview,
  DEFAULT_CUSTOM_ACCENT,
  normalizeCustomAccent,
} from './theme-record-adapter'

// The shared catalogue owns every preset; theme-specific slots are offered separately.
const appearanceAccentOptions = Object.freeze(accentPresets.map((accent) => ({ ...accent })))

function customAccentValue(accent: string): string {
  return accent === 'theme' || accentPresetById(accent) || isThemeAccentId(accent) ? '' : accent
}

type AppearanceControlProps = {
  open: boolean
  onOpen(): void
  onClose(): void
}

export function AppearancePanel() {
  return <AppearanceHost />
}

/** Device-local preview and persistence around the shared live popover. */
export function AppearanceControl(props: AppearanceControlProps) {
  return <AppearanceHost popover={props} />
}

function AppearanceHost(props: { popover?: AppearanceControlProps }) {
  const appearance = useTheme()
  const editor = createAppearanceEditor()
  const [customAccent, setCustomAccent] = createSignal('')
  // The published editor is controlled by the draft it receives. Keep an
  // invalid raw string in that presentation draft while the host's canonical
  // editor draft and live preview remain on the last validated accent.
  const [rawCustomAccent, setRawCustomAccent] = createSignal('')
  const [accentStatus, setAccentStatus] = createSignal('')
  const [libraryOpen, setLibraryOpen] = createSignal(false)

  const miniatures = createMemo(() => draftVariants(editor.draft()))
  // Imported themes: refreshed through the registry subscription so the
  // picker and this dialog track imports and removals without prop drilling.
  const [library, setLibrary] = createSignal(
    readCustomThemeLibrary(typeof window === 'undefined' ? undefined : window.localStorage)
  )
  onMount(() => {
    setLibrary(readCustomThemeLibrary(window.localStorage))
    onCleanup(subscribeCustomThemes(() => setLibrary(readCustomThemeLibrary(window.localStorage))))
  })
  // Reading the library signal here ties the editor's theme list to imports
  // and removals: the record projection itself has no reactive dependency.
  const themes = () => {
    library()
    return allThemeRecords()
  }
  const [importStatus, setImportStatus] = createSignal('')

  const themeAccentOptions = createMemo(() => {
    const draft = editor.draft()
    const records = themes()
    const light = records.find((record) => record.id === draft.lightThemeId)
    const dark = records.find((record) => record.id === draft.darkThemeId)
    return light && dark ? themeAccentPresets(light, dark) : []
  })

  const importThemeFile = async (file: File) => {
    const text = await file.text()
    const result = importCustomTheme(
      text,
      typeof window === 'undefined' ? undefined : window.localStorage,
      readCustomThemeLibrary(window.localStorage)
    )
    if (result.ok) {
      setImportStatus(
        `Imported “${result.theme.name}”.` +
          (result.theme.notes.length > 0 ? ` ${result.theme.notes.join(' ')}` : '')
      )
      // Select the imported theme for its appearance so the user sees it land.
      setDraft(
        result.theme.appearance === 'dark'
          ? { darkThemeId: result.theme.id }
          : { lightThemeId: result.theme.id }
      )
    } else {
      setImportStatus(result.error)
    }
  }
  const publishedDraft = createMemo<AppearanceDraft>(() => {
    const draft = editor.draft()
    return {
      ...draft,
      accent:
        rawCustomAccent() &&
        !accentPresetById(draft.accent) &&
        !isThemeAccentId(draft.accent) &&
        draft.accent !== 'theme'
          ? rawCustomAccent()
          : draft.accent,
      surface: draft.surface === 'translucent' ? 'theme' : draft.surface,
    }
  })

  const sampleVariant = () => {
    const variants = miniatures()
    const mode = editor.draft().mode
    if (mode === 'light') return variants.light
    if (mode === 'dark') return variants.dark
    return untrack(() => document.documentElement.classList.contains('dark'))
      ? variants.dark
      : variants.light
  }

  const preview = () => appearance.preview(editor.draft())

  const revertDraft = () => {
    appearance.preview(undefined)
    const reverted = editor.revert()
    setCustomAccent(customAccentValue(reverted.accent))
    setRawCustomAccent(customAccentValue(reverted.accent))
    setAccentStatus('')
    setLibraryOpen(false)
  }

  const setDraft = (patch: Partial<AppearancePreferencesV2>) => {
    editor.set(patch)
    preview()
  }

  const setAccent = (value: string) => {
    if (value === 'theme' || accentPresetById(value) || isThemeAccentId(value)) {
      setCustomAccent('')
      setRawCustomAccent('')
      setAccentStatus('')
      setDraft({ accent: value })
      return
    }

    const validation = normalizeCustomAccent(value, sampleVariant().colors.background)
    if (validation.value === undefined) {
      // Keep the previous preview active while preserving the invalid input
      // in the controlled published editor for correction and recovery.
      setRawCustomAccent(value)
      setAccentStatus(validation.error ?? 'Invalid custom accent.')
      return
    }
    setCustomAccent(validation.value)
    setRawCustomAccent(validation.value)
    setAccentStatus('')
    setDraft({ accent: validation.value })
  }

  const onChange = (patch: Partial<AppearanceDraft>) => {
    if (patch.accent !== undefined) {
      setAccent(patch.accent)
      return
    }
    if (patch.surface !== undefined) {
      setDraft({ surface: patch.surface === 'theme' ? 'translucent' : patch.surface })
      return
    }
    setDraft(patch as Partial<AppearancePreferencesV2>)
  }

  const save = () => {
    // The embedded section's published action stays disabled until the draft
    // differs from the snapshot (saveDisabledReason below); this guard keeps a
    // no-op open→close from writing even if the action were invoked through
    // another path. The sheet keeps Save available instead: with nothing to
    // write, saving is dismissing, so the sheet never shows disabled-state
    // copy — it reverts the (unchanged) draft and closes.
    if (accentStatus()) return
    if (!editor.dirty()) {
      revertDraft()
      props.popover?.onClose()
      return
    }
    const committed = editor.save()
    appearance.update(committed)
    appearance.preview(undefined)
    props.popover?.onClose()
  }

  const reset = () => {
    editor.reset()
    setCustomAccent('')
    setRawCustomAccent('')
    setAccentStatus('')
    preview()
  }

  const openDraft = () => {
    const committed = untrack(() => appearance.preferences())
    editor.open(committed)
    setCustomAccent(customAccentValue(committed.accent))
    setRawCustomAccent(customAccentValue(committed.accent))
    setAccentStatus('')
    setLibraryOpen(false)
  }

  onMount(openDraft)

  onCleanup(revertDraft)

  const editorProps: AppearanceEditorProps = {
    get draft() {
      return publishedDraft()
    },
    get lightTheme() {
      return appearanceThemeForPreview(miniatures().light, editor.draft().accent)
    },
    get darkTheme() {
      return appearanceThemeForPreview(miniatures().dark, editor.draft().accent)
    },
    get resolvedAppearance() {
      return appearance.resolvedMode()
    },
    get themes() {
      return themes()
    },
    accentOptions: appearanceAccentOptions,
    get themeAccentOptions() {
      return themeAccentOptions()
    },
    get customAccentValue() {
      return customAccent() || DEFAULT_CUSTOM_ACCENT
    },
    get customAccentError() {
      return accentStatus()
    },
    // The published composite renders the reason as the action row's status
    // line and disables Save while it is set. The embedded settings section
    // keeps that disabled-with-reason treatment: its action row sits at the
    // bottom of a long scrolling form, where "Save" being unavailable needs
    // its one-line why. The sheet renders Save always available instead —
    // with no edits, saving is dismissing (save above) — so the sheet never
    // opens showing "No changes to save yet." over its action row.
    get saveDisabledReason() {
      if (props.popover) return undefined
      return editor.dirty() ? undefined : 'No changes to save yet.'
    },
    surfaceCapability: {
      frosted: true,
      themeDefaultDescription: 'Native window vibrancy where supported; tokenized frost elsewhere.',
    },
    onChange,
    onSave: save,
    onCancel: () => {
      revertDraft()
      props.popover?.onClose()
    },
    onReset: reset,
    onManageThemes: () => setLibraryOpen(true),
  }

  return (
    <>
      <Show
        when={props.popover}
        fallback={
          <section aria-label="Appearance" class="grid gap-4">
            <header class="conventional-settings-section-header">
              <MonitorCog aria-hidden="true" />
              <div>
                <h3>Appearance</h3>
                <p>
                  Changes preview immediately. Save keeps them; leaving this section without saving
                  restores your previous appearance.
                </p>
              </div>
            </header>
            <AdeaAppearanceEditor {...editorProps} />
          </section>
        }
      >
        {(control) => (
          <AdeaAppearancePopover
            {...editorProps}
            open={control().open}
            onOpen={() => {
              openDraft()
              control().onOpen()
            }}
            onDismiss={() => {
              revertDraft()
              control().onClose()
            }}
          />
        )}
      </Show>
      <ModalDialog
        modal={props.popover !== undefined}
        open={libraryOpen()}
        onClose={() => setLibraryOpen(false)}
        title="Manage themes"
        description="Import a theme file. Imported themes appear in the Light and Dark theme menus and stay on this device."
        class="conventional-dialog conventional-theme-library-dialog"
      >
        <div class="conventional-theme-library">
          <Label class="conventional-theme-library__import">
            <Input
              type="file"
              accept=".json,application/json"
              class="sr-only"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (file) void importThemeFile(file)
              }}
            />
            Import a theme file (.json)
          </Label>
          <Show when={importStatus()}>
            <p class="conventional-theme-library__status" role="status">
              {importStatus()}
            </p>
          </Show>
          <Show when={library().length > 0}>
            <ul class="conventional-theme-library__list">
              <For each={library()}>
                {(theme) => (
                  <li>
                    <span class="conventional-theme-library__name">{theme.name}</span>
                    <span class="conventional-theme-library__meta">
                      {theme.appearance} · imported{' '}
                      {new Date(theme.importedAt).toLocaleDateString()}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        removeCustomTheme(
                          theme.id,
                          typeof window === 'undefined' ? undefined : window.localStorage
                        )
                        setImportStatus('')
                      }}
                    >
                      Remove
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
        <footer class="flex justify-end">
          <Button type="button" variant="outline" onClick={() => setLibraryOpen(false)}>
            Close
          </Button>
        </footer>
      </ModalDialog>
    </>
  )
}
