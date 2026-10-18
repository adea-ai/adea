import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

describe('desktop manifest error handling', () => {
  test.each(['null', '[]', '"manifest"', '42', 'false'])(
    'rejects non-object JSON %s without replacing it',
    async (contents) => {
      const path = await fixturePackage()
      await writeFile(path, contents)
      await expect(setDesktopReleaseVersion('1.43.0', path)).rejects.toThrow(
        'Desktop package manifest must contain a JSON object.'
      )
      expect(await readFile(path, 'utf8')).toBe(contents)
    }
  )

  test('preserves malformed JSON and reports read failures', async () => {
    const path = await fixturePackage()
    await writeFile(path, '{broken')
    await expect(setDesktopReleaseVersion('1.43.0', path)).rejects.toBeInstanceOf(SyntaxError)
    expect(await readFile(path, 'utf8')).toBe('{broken')
    await expect(setDesktopReleaseVersion('1.43.0', join(path, 'missing'))).rejects.toThrow()
  })
})

async function runReleaseEntry(version: string | undefined, packagePath: string) {
  const previous = { argv: process.argv, exitCode: process.exitCode }
  const script = fileURLToPath(new URL('./set-desktop-release-version.mjs', import.meta.url))
  const output = spyOn(process.stdout, 'write').mockImplementation(() => true)
  const errors = spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    // Every valid version has an explicit disposable manifest. The omitted
    // argument case must reject before the script's real default path is read.
    process.argv = [
      process.execPath,
      script,
      ...(version === undefined ? [] : [version, packagePath]),
    ]
    process.exitCode = 0
    await import(`./set-desktop-release-version.mjs?entry=${crypto.randomUUID()}`)
    return {
      status: process.exitCode,
      output: output.mock.calls.map(([chunk]) => String(chunk)).join(''),
      errors: errors.mock.calls.map(([chunk]) => String(chunk)).join(''),
    }
  } finally {
    process.argv = previous.argv
    process.exitCode = previous.exitCode
    output.mockRestore()
    errors.mockRestore()
  }
}

describe('desktop release version command', () => {
  test('reports success only after updating the disposable manifest', async () => {
    const path = await fixturePackage()
    const result = await runReleaseEntry('1.43.0-dev.17', path)
    expect(result).toEqual({
      status: 0,
      output: 'Desktop package version set to 1.43.0-dev.17.\n',
      errors: '',
    })
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe('1.43.0-dev.17')
  })

  test.each([undefined, 'v1.43.0'])(
    'reports an invalid or missing version %s without touching the manifest',
    async (version) => {
      const path = await fixturePackage()
      const original = await readFile(path, 'utf8')
      const result = await runReleaseEntry(version, path)
      expect(result.status).toBe(1)
      expect(result.output).toBe('')
      expect(result.errors).toBe(`Unsupported desktop release version: ${version}\n`)
      expect(await readFile(path, 'utf8')).toBe(original)
    }
  )

  test('reports an invalid manifest without claiming a successful release version', async () => {
    const path = await fixturePackage()
    await writeFile(path, 'null')
    const result = await runReleaseEntry('1.43.0', path)
    expect(result.status).toBe(1)
    expect(result.output).toBe('')
    expect(result.errors).toBe('Desktop package manifest must contain a JSON object.\n')
    expect(await readFile(path, 'utf8')).toBe('null')
  })
})
