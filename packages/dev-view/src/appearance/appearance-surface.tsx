/*
 * Adea host adapter for the published @adea-ai/ui AppearanceEditor.
 *
 * The published component owns presentation only. This host keeps Adea's V2
 * preference schema, provider preview/persistence, native transparency policy,
 * accepted compatibility IDs, and declared-license theme-library flow.
 */
import { AppearanceEditor, type AppearanceDraft } from '@adea-ai/ui/components/composites/appearance-editor'
import {
  accentPresets,
  accentPresetById,
  type AppearancePreferencesV2,
} from '@adea-ai/app-ui/components/appearance'
import { useTheme } from '@adea-ai/app-ui/components/theme-provider'
import { Button } from '@adea-ai/app-ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@adea-ai/app-ui/components/ui/dialog'
import { createMemo, createSignal, onCleanup, onMount, Show, untrack } from 'solid-js'

import { draftVariants } from './composition'
import { createAppearanceEditor } from './editor'
import {
  appearanceThemeForPreview,
  appearanceThemeRecords,
  normalizeCustomAccent,
} from './theme-record-adapter'

// The published catalogue is the palette authority. The local shape is kept
// here only as a narrow UI projection so importing the catalogue barrel cannot
// ship every theme adapter into the appearance chunk. A parity test compares
// these fields against @adea-ai/themes' canonical ACCENTS.
const appearanceAccentOptions = Object.freeze(
  accentPresets.map((accent) => ({ ...accent, description: `${accent.label} accent.` }))
)

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
      themes={appearanceThemeRecords}
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
    <Show
      when={!libraryOpen()}
      fallback={
        <Dialog open onOpenChange={(open: boolean) => !open && setLibraryOpen(false)}>
          <DialogContent class="max-w-md" aria-describedby="theme-library-description">
            <DialogHeader>
              <DialogTitle>Manage themes</DialogTitle>
              <DialogDescription id="theme-library-description">
                Import a local theme into your library or keep it linked to its source.
              </DialogDescription>
            </DialogHeader>
            <div class="grid gap-3 px-6 pb-6 text-sm">
              <p class="text-muted-foreground">
                Custom themes must declare an explicit license and provenance; Adea never infers
                redistribution permission from a “User supplied” marker.
              </p>
              <p class="text-muted-foreground">
                Imports activate through the signed App Library pipeline; M12 ships the built-in
                set.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setLibraryOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      }
    >
      <section aria-label="Appearance" class="grid gap-6">
        <header class="flex items-start gap-3">
          <div>
            <h3 class="text-sm font-medium">Appearance</h3>
            <p class="text-muted-foreground text-sm">
              Changes preview immediately. Save keeps them; leaving this section without saving
              restores your previous appearance.
            </p>
          </div>
        </header>
        {editorView}
      </section>
    </Show>
  )
}
