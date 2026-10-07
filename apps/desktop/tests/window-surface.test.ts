// The glass setting's native half: the persisted preference decides whether
// the desktop window is created see-through. Nothing touches a real
// filesystem — the reader is scripted with throwaway directories.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { windowTransparentFor } from '../shell/src/window-surface'

function preferencesDir(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'adea-window-surface-'))
  mkdirSync(join(dir, 'desktop-state'))
  writeFileSync(join(dir, 'desktop-state', 'preferences.json'), JSON.stringify(body))
  return dir
}

describe('native window transparency preference', () => {
  test('only the frosted surface on darwin creates a see-through window', () => {
    expect(windowTransparentFor(preferencesDir({ windowSurface: 'frosted' }), 'darwin')).toBe(true)
    expect(windowTransparentFor(preferencesDir({ windowSurface: 'theme' }), 'darwin')).toBe(false)
    expect(windowTransparentFor(preferencesDir({ windowSurface: 'opaque' }), 'darwin')).toBe(false)
    expect(windowTransparentFor(preferencesDir({ windowSurface: 'frosted' }), 'linux')).toBe(false)
  })

  test('a missing or unreadable preferences file stays opaque', () => {
    expect(
      windowTransparentFor(mkdtempSync(join(tmpdir(), 'adea-window-surface-')), 'darwin')
    ).toBe(false)
    expect(windowTransparentFor(join(tmpdir(), 'adea-window-surface-absent'), 'darwin')).toBe(false)
  })

  test('hostile JSON content never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adea-window-surface-'))
    mkdirSync(join(dir, 'desktop-state'))
    writeFileSync(join(dir, 'desktop-state', 'preferences.json'), 'not json at all')
    expect(windowTransparentFor(dir, 'darwin')).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})
