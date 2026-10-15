/*
 * The Manage themes dialog's import flow, with the parsing and projection code
 * behind a dynamic import. Selecting a file is what loads it, so opening
 * Appearance never downloads the importer.
 *
 * A newer selection, a closed dialog and a disposed panel each supersede an
 * import still in flight: the result of a superseded run is dropped before
 * anything is stored, selected or reported.
 */
import type { CustomThemeStored } from '@adea-ai/app-ui/components/custom-theme-library'

import type { CustomThemeImportResult } from './custom-theme-import'

export type ThemeFileImporterHost = Readonly<{
  /**
   * Loads the importer and returns the function that imports one file's text.
   * It runs after every await so the library it merges into is read fresh.
   */
  load: () => Promise<(text: string) => CustomThemeImportResult>
  onPending: (pending: boolean) => void
  onStatus: (message: string) => void
  onImported: (theme: CustomThemeStored) => void
}>

export type ThemeFileImporter = Readonly<{
  importFile: (file: Pick<File, 'text'>) => Promise<void>
  /** Drops the run in flight, if any, and clears its pending status. */
  cancel: () => void
}>

export const THEME_IMPORT_PENDING = 'Importing theme…'
export const THEME_IMPORT_UNREADABLE = 'That file could not be read.'
export const THEME_IMPORT_UNAVAILABLE =
  'The theme importer could not be loaded. Reload the app and try again.'
export const THEME_IMPORT_FAILED = 'That theme could not be imported.'

export function createThemeFileImporter(host: ThemeFileImporterHost): ThemeFileImporter {
  let latest = 0
  let pending = false
  const settle = () => {
    if (!pending) return
    pending = false
    host.onPending(false)
  }

  return {
    cancel() {
      latest += 1
      if (!pending) return
      settle()
      host.onStatus('')
    },
    async importFile(file) {
      latest += 1
      const run = latest
      const current = () => run === latest
      pending = true
      host.onPending(true)
      host.onStatus(THEME_IMPORT_PENDING)

      let text: string
      try {
        text = await file.text()
      } catch {
        if (!current()) return
        settle()
        host.onStatus(THEME_IMPORT_UNREADABLE)
        return
      }
      if (!current()) return

      let importText: (text: string) => CustomThemeImportResult
      try {
        importText = await host.load()
      } catch {
        if (!current()) return
        settle()
        host.onStatus(THEME_IMPORT_UNAVAILABLE)
        return
      }
      if (!current()) return

      let result: CustomThemeImportResult
      try {
        result = importText(text)
      } catch {
        settle()
        host.onStatus(THEME_IMPORT_FAILED)
        return
      }
      settle()
      if (!result.ok) {
        host.onStatus(result.error)
        return
      }
      host.onStatus(
        `Imported “${result.theme.name}”.` +
          (result.theme.notes.length > 0 ? ` ${result.theme.notes.join(' ')}` : '')
      )
      host.onImported(result.theme)
    },
  }
}
