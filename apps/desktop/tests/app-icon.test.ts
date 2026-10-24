// The Dock icon colourway's native half: the persisted pick decides which
// icon the shell asks for, and a shell with no native setter says so instead
// of claiming the icon changed.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  APP_ICON_VARIANTS,
  appIconFile,
  appIconFor,
  createAppIconApplier,
  isAppIconVariant,
} from '../shell/src/app-icon'

function preferencesDir(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'adea-app-icon-'))
  mkdirSync(join(dir, 'desktop-state'))
  writeFileSync(join(dir, 'desktop-state', 'preferences.json'), body)
  return dir
}

describe('app icon preference', () => {
  test('reads the three colourways and defaults everything else to white', () => {
    for (const variant of APP_ICON_VARIANTS)
      expect(appIconFor(preferencesDir(JSON.stringify({ appIcon: variant })))).toBe(variant)
    expect(appIconFor(preferencesDir(JSON.stringify({ appIcon: 'green' })))).toBe('white')
    expect(appIconFor(preferencesDir(JSON.stringify({})))).toBe('white')
    expect(appIconFor(preferencesDir('not json at all'))).toBe('white')
    expect(appIconFor(join(tmpdir(), 'adea-app-icon-absent'))).toBe('white')
  })

  test('accepts only the known colourways', () => {
    expect(isAppIconVariant('violet')).toBe(true)
    for (const value of ['', 'Violet', '../white', 7, null, undefined])
      expect(isAppIconVariant(value)).toBe(false)
  })
})

describe('app icon applier', () => {
  test('asks the native port for the picked colourway on macOS', async () => {
    const files: string[] = []
    const apply = createAppIconApplier({
      iconsDir: '/app/app-icons',
      platform: 'darwin',
      native: (file) => void files.push(file),
    })
    expect(await apply('black')).toBe(true)
    expect(files).toEqual([appIconFile('/app/app-icons', 'black')])
    expect(files[0]).toBe('/app/app-icons/black.png')
  })

  test('reports not applied without a native port, off macOS, or when the port fails', async () => {
    expect(await createAppIconApplier({ iconsDir: '/x', platform: 'darwin' })('white')).toBe(false)
    expect(
      await createAppIconApplier({ iconsDir: '/x', platform: 'linux', native: () => undefined })(
        'white'
      )
    ).toBe(false)
    expect(
      await createAppIconApplier({
        iconsDir: '/x',
        platform: 'darwin',
        native: () => {
          throw new Error('no dock')
        },
      })('white')
    ).toBe(false)
  })
})

rmSync(join(tmpdir(), 'adea-app-icon-absent'), { force: true, recursive: true })
