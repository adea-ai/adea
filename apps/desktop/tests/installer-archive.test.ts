// The installer's retained payload tar is retired for the running build only.
// These tests stage a real on-disk layout (Application Support identity root
// plus an installed bundle's Resources) and execute the removal, including the
// stable -> dev upgrade shape where an earlier install's archive must survive.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { retireInstallerArchive } from '../shell/src/installer-archive'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const IDENTIFIER = 'dev.adea.desktop'

function stage(options: { hash: string; channel?: string; archives?: readonly string[] }) {
  const root = mkdtempSync(join(tmpdir(), 'installer-archive-'))
  roots.push(root)
  const channel = options.channel ?? 'stable'
  const resourcesDir = join(root, 'bundle', 'Contents', 'Resources')
  mkdirSync(resourcesDir, { recursive: true })
  writeFileSync(
    join(resourcesDir, 'version.json'),
    JSON.stringify({ identifier: IDENTIFIER, channel, version: '1.2.3', hash: options.hash })
  )
  const applicationSupportDir = join(root, 'Application Support')
  const extractionDir = join(applicationSupportDir, IDENTIFIER, channel, 'self-extraction')
  mkdirSync(extractionDir, { recursive: true })
  for (const name of options.archives ?? []) writeFileSync(join(extractionDir, name), 'tar bytes')
  return { root, resourcesDir, applicationSupportDir, extractionDir }
}

describe('retireInstallerArchive', () => {
  test('removes the archive the installer wrote for the running build', () => {
    const f = stage({ hash: 'abc123', archives: ['abc123.tar'] })
    const outcome = retireInstallerArchive(f)
    expect(outcome).toEqual({ state: 'removed', path: join(f.extractionDir, 'abc123.tar') })
    expect(existsSync(join(f.extractionDir, 'abc123.tar'))).toBe(false)
    // The directory itself and the installed bundle are untouched.
    expect(existsSync(f.extractionDir)).toBe(true)
    expect(existsSync(join(f.resourcesDir, 'version.json'))).toBe(true)
  })

  test('a second boot finds nothing to do', () => {
    const f = stage({ hash: 'abc123', archives: ['abc123.tar'] })
    retireInstallerArchive(f)
    expect(retireInstallerArchive(f)).toEqual({ state: 'absent' })
  })

  test('stable -> dev upgrade: the original installer archive is historical and stays', () => {
    // The user installed stable build `stablehash`; Adea's own updater later
    // swapped in dev build `devhash`. The running bundle's hash is the dev one.
    const f = stage({ hash: 'devhash', archives: ['stablehash.tar'] })
    expect(retireInstallerArchive(f)).toEqual({ state: 'absent' })
    expect(existsSync(join(f.extractionDir, 'stablehash.tar'))).toBe(true)
  })

  test('fresh dev install removes its own archive and no one else’s', () => {
    const f = stage({
      hash: 'devhash',
      channel: 'dev',
      archives: ['devhash.tar', 'olderhash.tar', 'devhash.tar.previous'],
    })
    expect(retireInstallerArchive(f).state).toBe('removed')
    expect(existsSync(join(f.extractionDir, 'devhash.tar'))).toBe(false)
    expect(existsSync(join(f.extractionDir, 'olderhash.tar'))).toBe(true)
    expect(existsSync(join(f.extractionDir, 'devhash.tar.previous'))).toBe(true)
  })

  test('a pending Electrobun update record means hands off', () => {
    const f = stage({
      hash: 'abc123',
      archives: ['abc123.tar', '.electrobun-prepared-update.json'],
    })
    expect(retireInstallerArchive(f)).toEqual({
      state: 'skipped',
      reason: 'a prepared update record exists',
    })
    expect(existsSync(join(f.extractionDir, 'abc123.tar'))).toBe(true)
  })

  test('a symlink is never followed or removed', () => {
    const f = stage({ hash: 'abc123' })
    const target = join(f.root, 'precious.bin')
    writeFileSync(target, 'user data')
    symlinkSync(target, join(f.extractionDir, 'abc123.tar'))
    expect(retireInstallerArchive(f)).toEqual({
      state: 'skipped',
      reason: 'not a regular file',
    })
    expect(existsSync(target)).toBe(true)
  })

  test('an unsafe identity never reaches the filesystem', () => {
    for (const identity of [
      { identifier: IDENTIFIER, channel: 'stable', hash: '../escape' },
      { identifier: '../..', channel: 'stable', hash: 'abc123' },
      { identifier: IDENTIFIER, channel: '../x', hash: 'abc123' },
      { identifier: IDENTIFIER, channel: 'stable', hash: '' },
      { identifier: IDENTIFIER, channel: 'stable' },
    ]) {
      const f = stage({ hash: 'abc123', archives: ['abc123.tar'] })
      writeFileSync(join(f.resourcesDir, 'version.json'), JSON.stringify(identity))
      expect(retireInstallerArchive(f).state).toBe('skipped')
      expect(existsSync(join(f.extractionDir, 'abc123.tar'))).toBe(true)
    }
  })

  test('not a packaged install, or unreadable identity: skipped, never thrown', () => {
    const missing = stage({ hash: 'abc123', archives: ['abc123.tar'] })
    rmSync(join(missing.resourcesDir, 'version.json'))
    expect(retireInstallerArchive(missing)).toEqual({
      state: 'skipped',
      reason: 'not a packaged install',
    })

    const garbled = stage({ hash: 'abc123', archives: ['abc123.tar'] })
    writeFileSync(join(garbled.resourcesDir, 'version.json'), '{not json')
    expect(retireInstallerArchive(garbled).state).toBe('skipped')
    expect(existsSync(join(garbled.extractionDir, 'abc123.tar'))).toBe(true)
  })
})
