import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setDesktopReleaseVersion } from './set-desktop-release-version.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

async function fixturePackage() {
  const directory = await mkdtemp(join(tmpdir(), 'adea-desktop-release-version-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'package.json')
  await writeFile(
    path,
    `${JSON.stringify({ name: '@adea-ai/desktop', private: true, version: '0.79.1' }, null, 2)}\n`
  )
  return path
}

describe('desktop release version injection', () => {
  test.each(['1.43.0', '1.43.0-dev.17'])(
    'sets the disposable package manifest to %s',
    async (version) => {
      const path = await fixturePackage()

      await setDesktopReleaseVersion(version, path)

      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        name: '@adea-ai/desktop',
        private: true,
        version,
      })
    }
  )

  test.each(['v1.43.0', '1.43.0-beta.1', '1.43.0-dev.x'])(
    'rejects unsupported version %s without changing the manifest',
    async (version) => {
      const path = await fixturePackage()
      const original = await readFile(path, 'utf8')

      await expect(setDesktopReleaseVersion(version, path)).rejects.toThrow(
        `Unsupported desktop release version: ${version}`
      )

      expect(await readFile(path, 'utf8')).toBe(original)
    }
  )
})
