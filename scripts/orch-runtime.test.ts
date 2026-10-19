import { test, expect, spyOn } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  chmodSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expectedId, identity, idOf, UNIDENTIFIED } from './orch-toolchain.mjs'
import * as urls from 'node:url'

test('runtime identity fingerprints executables behind transparent launchers', () => {
  const root = mkdtempSync(join(tmpdir(), 'adea-runtime-identity-'))
  const direct = join(root, 'direct')
  const wrapped = join(root, 'wrapped')
  for (const directory of [direct, wrapped]) mkdirSync(directory)
  try {
    for (const name of ['node', 'bun']) {
      symlinkSync(process.execPath, join(direct, name))
      const launcher = join(wrapped, name)
      writeFileSync(
        launcher,
        `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`
      )
      chmodSync(launcher, 0o755)
    }
    const a = identity({ root, searchPath: direct })
    const b = identity({ root, searchPath: wrapped })
    expect(b).toEqual(a)
    const digest = createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
    expect(b.bun.sha256).toBe(digest)
    expect(b.node.sha256).toBe(digest)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

async function toolchainEntry(args: string[], searchPath: string) {
  const script = urls.fileURLToPath(new URL('./orch-toolchain.mjs', import.meta.url))
  const entry = crypto.randomUUID()
  const address = new URL(`./orch-toolchain.mjs?entry=${entry}`, import.meta.url)
  const originalUrl = urls.pathToFileURL
  const previous = { argv: process.argv, env: process.env }
  const url = spyOn(urls, 'pathToFileURL').mockImplementation((path) =>
    path === script ? address : originalUrl(path)
  )
  const output = spyOn(console, 'log').mockImplementation(() => {})
  const error = spyOn(console, 'error').mockImplementation(() => {})
  const stopped = Symbol('toolchain exit')
  let code = 0
  const exit = spyOn(process, 'exit').mockImplementation((value) => {
    code = Number(value ?? 0)
    throw stopped
  })
  try {
    process.argv = [process.execPath, script, ...args]
    process.env = { PATH: searchPath }
    try {
      await import(`./orch-toolchain.mjs?entry=${entry}`)
    } catch (failure) {
      if (failure !== stopped) throw failure
    }
    return {
      code,
      output: output.mock.calls.flat().join('\n'),
      error: error.mock.calls.flat().join('\n'),
    }
  } finally {
    process.argv = previous.argv
    process.env = previous.env
    url.mockRestore()
    output.mockRestore()
    error.mockRestore()
    exit.mockRestore()
  }
}

test('toolchain guard refuses missing identity, mismatched binaries and unidentified graph keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adea-toolchain-cli-'))
  try {
    for (const name of ['node', 'bun']) symlinkSync(process.execPath, join(root, name))
    const id = idOf(identity({ root, searchPath: root }))
    expect(await toolchainEntry(['--expect', id], root)).toEqual({
      code: 0,
      output: `toolchain ${id}`,
      error: '',
    })
    const mismatch = await toolchainEntry(['--expect', 'different-toolchain'], root)
    expect(mismatch.code).toBe(1)
    expect(mismatch.error).toContain('cache keys were written for different-toolchain')
    const unknown = await toolchainEntry(['--expect', UNIDENTIFIED], root)
    expect(unknown.code).toBe(1)
    expect(unknown.error).toContain('could not be identified when the tasks were loaded')
    expect((await toolchainEntry([], root)).code).toBe(2)
    const absent = await toolchainEntry(['--expect', id], '')
    expect(absent.code).toBe(1)
    expect(absent.error).toContain('not on PATH')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('identity rejects empty versions and invalid executable probes without accepting a cache key', () => {
  const root = mkdtempSync(join(tmpdir(), 'adea-toolchain-invalid-'))
  const previous = process.env.PATH
  try {
    process.env.PATH = root
    expect(expectedId(root)).toBe(UNIDENTIFIED)
    const node = join(root, 'node')
    for (const [body, message] of [
      ['exit 7', '--version` failed'],
      ['exit 0', 'printed nothing'],
      [
        'if [ "$1" = --version ]; then echo v1.0.0; else echo /missing/fixture; fi',
        'executable probe failed',
      ],
    ]) {
      writeFileSync(node, `#!/bin/sh\n${body}\n`)
      chmodSync(node, 0o755)
      expect(() => identity({ root, searchPath: root })).toThrow(message)
    }
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('identity memo is optional and toolchain ids normalize version text safely', () => {
  const root = mkdtempSync(join(tmpdir(), 'adea-toolchain-memo-'))
  const previous = process.env.PATH
  try {
    for (const name of ['node', 'bun']) symlinkSync(process.execPath, join(root, name))
    process.env.PATH = root
    const found = identity({ root, searchPath: root })
    expect(expectedId(root)).toBe(idOf(found))
    writeFileSync(join(root, 'node_modules', '.cache', 'orch-toolchain-memo.json'), '{invalid')
    expect(identity({ root, searchPath: root })).toEqual(found)
    expect(idOf({ ...found, node: { ...found.node, version: 'v1.2.3+fixture tag' } })).toContain(
      'node1.2.3_fixture_tag-'
    )
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
    rmSync(root, { recursive: true, force: true })
  }
})
