/*
 * Adea host adapter for the published @adea-ai/ui AppearanceEditor.
 *
 * The published component owns presentation only. This host keeps Adea's V2
 * preference schema, provider preview/persistence, native transparency policy,
 * accepted compatibility IDs, and declared-license theme-library flow.
 */
import {
  AppearanceEditor,
  type AppearanceDraft,
} from '@adea-ai/ui/components/composites/appearance-editor'
import {
  accentPresets,
  accentPresetById,
  subscribeCustomThemes,
  type AppearancePreferencesV2,
} from '@adea-ai/app-ui/components/appearance'
import { useTheme } from '@adea-ai/app-ui/components/theme-provider'
import { Button } from '@adea-ai/ui/components/ui/button'
import { ModalDialog } from '@adea-ai/ui/components/ui/modal-dialog'
import { createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js'
import { MonitorCog } from 'lucide-solid'

import { readCustomThemeLibrary, removeCustomTheme } from '@adea-ai/app-ui/components/appearance'
import { For, Show } from 'solid-js'

import { draftVariants } from './composition'
import { createAppearanceEditor } from './editor'
import { importCustomTheme } from './custom-theme-import'
import {
  allThemeRecords,
  appearanceThemeForPreview,
  normalizeCustomAccent,
} from './theme-record-adapter'

// The published catalogue is the palette authority. The local shape is kept
// here only as a narrow UI projection so importing the catalogue barrel cannot
// ship every theme adapter into the appearance chunk. A parity test compares
// these fields against @adea-ai/themes' canonical ACCENTS.
const appearanceAccentOptions = Object.freeze(accentPresets.map((accent) => ({ ...accent })))

function customAccentValue(accent: string): string {
  return accent === 'theme' || accentPresetById(accent) ? '' : accent
}

export function AppearancePanel() {
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
    return subscribeCustomThemes(() => setLibrary(readCustomThemeLibrary(window.localStorage)))
  })
  // Reading the library signal here ties the editor's theme list to imports
  // and removals: the record projection itself has no reactive dependency.
  const themes = () => {
    library()
    return allThemeRecords()
  }
  const [importStatus, setImportStatus] = createSignal('')

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
        rawCustomAccent() && !accentPresetById(draft.accent) && draft.accent !== 'theme'
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
    if (value === 'theme' || accentPresetById(value)) {
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
    if (accentStatus()) return
    const committed = editor.save()
    appearance.update(committed)
    appearance.preview(undefined)
  }

  const reset = () => {
    editor.reset()
    setCustomAccent('')
    setRawCustomAccent('')
    setAccentStatus('')
    preview()
  }

  onMount(() => {
    const committed = untrack(() => appearance.preferences())
    editor.open(committed)
    setCustomAccent(customAccentValue(committed.accent))
    setRawCustomAccent(customAccentValue(committed.accent))
    setAccentStatus('')
    setLibraryOpen(false)
  })

  onCleanup(revertDraft)

  const editorView = (
    <AppearanceEditor
      draft={publishedDraft()}
      lightTheme={appearanceThemeForPreview(miniatures().light, editor.draft().accent)}
      darkTheme={appearanceThemeForPreview(miniatures().dark, editor.draft().accent)}
      resolvedAppearance={appearance.resolvedMode()}
      themes={themes()}
      accentOptions={appearanceAccentOptions}
      customAccentValue={customAccent() || '#2563eb'}
      customAccentError={accentStatus()}
      surfaceCapability={{
        frosted: true,
        themeDefaultDescription:
          'Native window vibrancy where supported; tokenized frost elsewhere.',
      }}
      onChange={onChange}
      onSave={save}
      onCancel={revertDraft}
      onReset={reset}
      onManageThemes={() => setLibraryOpen(true)}
    />
  )

  return (
    <>
      {/* The header is a direct child of the settings panel so it picks up the
          same section-header layout as every other settings view. */}
      <header>
        <MonitorCog aria-hidden="true" />
        <div>
          <h3>Appearance</h3>
          <p>
            Changes preview immediately. Save keeps them; leaving this section without saving
            restores your previous appearance.
          </p>
        </div>
      </header>
      <section aria-label="Appearance">{editorView}</section>
      <ModalDialog
        modal={false}
        open={libraryOpen()}
        onClose={() => setLibraryOpen(false)}
        title="Manage themes"
        description="Import a theme file. Imported themes appear in the Light and Dark theme menus and stay on this device."
        class="conventional-dialog conventional-theme-library-dialog"
      >
        <div class="conventional-theme-library">
          <label class="conventional-theme-library__import">
            <input
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
          </label>
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
