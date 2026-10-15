import { describe, expect, test } from 'bun:test'

import type { CustomThemeStored } from '@adea-ai/app-ui/components/custom-theme-library'
import type { CustomThemeImportResult } from '../src/appearance/custom-theme-import'
import {
  THEME_IMPORT_FAILED,
  THEME_IMPORT_PENDING,
  THEME_IMPORT_UNAVAILABLE,
  THEME_IMPORT_UNREADABLE,
  createThemeFileImporter,
  type ThemeFileImporterHost,
} from '../src/appearance/theme-file-importer'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const stored = (name: string, appearance: 'light' | 'dark' = 'dark', notes: string[] = []) =>
  ({ id: `custom-${name}`, name, appearance, notes }) as unknown as CustomThemeStored

function harness(load: ThemeFileImporterHost['load']) {
  const events: string[] = []
  const imported: string[] = []
  let loads = 0
  const importer = createThemeFileImporter({
    load: () => {
      loads += 1
      return load()
    },
    onPending: (pending) => events.push(`pending:${pending}`),
    onStatus: (message) => events.push(`status:${message}`),
    onImported: (theme) => imported.push(theme.id),
  })
  return { importer, events, imported, loads: () => loads }
}

const file = (text: string | Promise<string>) => ({ text: () => Promise.resolve(text) })

describe('theme file importer (lazy importer, stale and cancelled results)', () => {
  test('shows the pending state, loads the importer, and reports the imported theme', async () => {
    const { importer, events, imported } = harness(async () => (text) => ({
      ok: true,
      theme: stored(text, 'light', ['Missing roles were filled from the default theme.']),
    }))
    await importer.importFile(file('Paper'))
    expect(events).toEqual([
      'pending:true',
      `status:${THEME_IMPORT_PENDING}`,
      'pending:false',
      'status:Imported “Paper”. Missing roles were filled from the default theme.',
    ])
    expect(imported).toEqual(['custom-Paper'])
  })

  test('an importer rejection is reported and clears the pending state', async () => {
    const { importer, events, imported } = harness(async () => () => ({
      ok: false,
      error: 'That file is not valid JSON.',
    }))
    await importer.importFile(file('x'))
    expect(events.at(-1)).toBe('status:That file is not valid JSON.')
    expect(events).toContain('pending:false')
    expect(imported).toEqual([])
  })

  test('a chunk that fails to load reports an error and can be retried', async () => {
    let attempt = 0
    const { importer, events, imported, loads } = harness(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('Failed to fetch dynamically imported module')
      return (text) => ({ ok: true, theme: stored(text) })
    })
    await importer.importFile(file('first'))
    expect(events.at(-1)).toBe(`status:${THEME_IMPORT_UNAVAILABLE}`)
    expect(imported).toEqual([])
    await importer.importFile(file('second'))
    expect(imported).toEqual(['custom-second'])
    expect(loads()).toBe(2)
  })

  test('an unreadable file is reported without loading the importer', async () => {
    const { importer, events, loads } = harness(async () => () => ({ ok: false, error: 'unused' }))
    await importer.importFile({ text: () => Promise.reject(new Error('read failed')) })
    expect(events.at(-1)).toBe(`status:${THEME_IMPORT_UNREADABLE}`)
    expect(loads()).toBe(0)
  })

  test('an importer that throws is reported instead of escaping', async () => {
    const { importer, events, imported } = harness(async () => () => {
      throw new Error('storage unavailable')
    })
    await importer.importFile(file('x'))
    expect(events.at(-1)).toBe(`status:${THEME_IMPORT_FAILED}`)
    expect(imported).toEqual([])
  })

  test('a newer selection supersedes a run still reading its file', async () => {
    const slow = deferred<string>()
    const parsed: string[] = []
    const { importer, imported } = harness(async () => (text) => {
      parsed.push(text)
      return { ok: true, theme: stored(text) }
    })
    const first = importer.importFile({ text: () => slow.promise })
    const second = importer.importFile(file('newer'))
    await second
    slow.resolve('older')
    await first
    expect(parsed).toEqual(['newer'])
    expect(imported).toEqual(['custom-newer'])
  })

  test('a newer selection supersedes a run still loading the chunk', async () => {
    const chunk = deferred<(text: string) => CustomThemeImportResult>()
    const parsed: string[] = []
    let calls = 0
    const { importer, imported, events } = harness(() => {
      calls += 1
      return calls === 1
        ? chunk.promise
        : Promise.resolve((text: string) => {
            parsed.push(text)
            return { ok: true, theme: stored(text) } as CustomThemeImportResult
          })
    })
    const first = importer.importFile(file('older'))
    await Promise.resolve()
    await importer.importFile(file('newer'))
    chunk.resolve((text) => {
      parsed.push(text)
      return { ok: true, theme: stored(text) }
    })
    await first
    expect(parsed).toEqual(['newer'])
    expect(imported).toEqual(['custom-newer'])
    expect(events.filter((event) => event.startsWith('status:Imported'))).toEqual([
      'status:Imported “newer”.',
    ])
  })

  test('a failed load of a superseded run does not overwrite the newer result', async () => {
    const chunk = deferred<(text: string) => CustomThemeImportResult>()
    let calls = 0
    const { importer, events } = harness(() => {
      calls += 1
      return calls === 1
        ? chunk.promise
        : Promise.resolve((text: string) => ({ ok: true, theme: stored(text) }))
    })
    const first = importer.importFile(file('older'))
    await Promise.resolve()
    await importer.importFile(file('newer'))
    chunk.reject(new Error('network'))
    await first
    expect(events.at(-1)).toBe('status:Imported “newer”.')
    expect(events).not.toContain(`status:${THEME_IMPORT_UNAVAILABLE}`)
  })

  test('cancel drops a run before it parses or stores anything and clears the status', async () => {
    const chunk = deferred<(text: string) => CustomThemeImportResult>()
    const parsed: string[] = []
    const { importer, events, imported } = harness(() => chunk.promise)
    const run = importer.importFile(file('x'))
    await Promise.resolve()
    importer.cancel()
    chunk.resolve((text) => {
      parsed.push(text)
      return { ok: true, theme: stored(text) }
    })
    await run
    expect(parsed).toEqual([])
    expect(imported).toEqual([])
    expect(events).toEqual([
      'pending:true',
      `status:${THEME_IMPORT_PENDING}`,
      'pending:false',
      'status:',
    ])
  })

  test('cancel with nothing in flight leaves the last result alone', async () => {
    const { importer, events } = harness(async () => (text) => ({ ok: true, theme: stored(text) }))
    await importer.importFile(file('Done'))
    const before = events.length
    importer.cancel()
    expect(events).toHaveLength(before)
  })
})
