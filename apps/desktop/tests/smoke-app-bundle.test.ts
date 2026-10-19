import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSmokeAppBundle } from '../shell/scripts/smoke-app-bundle'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'smoke-bundle-test-'))
  directories.push(root)
  const bundle = join(root, 'Outer.app')
  const resources = join(bundle, 'Contents/Resources')
  mkdirSync(resources, { recursive: true })
  return { root, bundle, resources }
}

test('an installed app is used in place and cleanup preserves it', async () => {
  const f = fixture()
  mkdirSync(join(f.bundle, 'Contents/MacOS'))
  writeFileSync(join(f.bundle, 'Contents/MacOS/bun'), 'fixture')
  const installed = await resolveSmokeAppBundle(f.bundle)
  expect(installed.appBundle).toBe(f.bundle)
  installed.cleanup()
  expect(existsSync(f.bundle)).toBe(true)
})

test('an outer extractor must carry exactly one payload, with no dev fallback', async () => {
  const f = fixture()
  await expect(resolveSmokeAppBundle(f.bundle)).rejects.toThrow('unique installed payload')
  for (const file of ['one.tar.zst', 'two.tar.zst']) writeFileSync(join(f.resources, file), '')
  await expect(resolveSmokeAppBundle(f.bundle)).rejects.toThrow('unique installed payload')
})

test('the extracted installed app is disposable and its source is preserved', async () => {
  const f = fixture()
  const app = join(f.root, 'source/Adea.app')
  mkdirSync(join(app, 'Contents/Resources'), { recursive: true })
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
  for (const file of [
    'Contents/Resources/main.js',
    'Contents/MacOS/launcher',
    'Contents/MacOS/bun',
  ])
    writeFileSync(join(app, file), 'fixture')
  const archive = join(f.resources, 'payload.tar.zst')
  const tar = Bun.spawnSync([
    'tar',
    '--zstd',
    '-cf',
    archive,
    '-C',
    join(f.root, 'source'),
    'Adea.app',
  ])
  expect(tar.exitCode).toBe(0)
  const installed = await resolveSmokeAppBundle(f.bundle)
  expect(installed.appBundle).not.toBe(f.bundle)
  expect(existsSync(join(installed.appBundle, 'Contents/MacOS/bun'))).toBe(true)
  installed.cleanup()
  expect(existsSync(installed.appBundle)).toBe(false)
  expect(existsSync(archive)).toBe(true)
})

test('a corrupt payload fails rather than relabeling the run as dev evidence', async () => {
  const f = fixture()
  writeFileSync(join(f.resources, 'payload.tar.zst'), 'corrupt')
  await expect(resolveSmokeAppBundle(f.bundle)).rejects.toThrow('could not be decompressed')
})
