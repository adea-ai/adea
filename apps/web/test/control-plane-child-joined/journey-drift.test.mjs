// Opt-in companion to the journey suites (#1173): the installed `@adea-ai/contracts` and the one CP
// builds differ in `canonical-json.js` (a loop-based rewrite of `canonicalJsonStringify`, pinned by
// content hash in `declaredDrift`). Both implementations are run side by side here; they must agree
// on every output and every thrown error. This is the executable half of the drift justification.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { verifyJourneyPackages } from './journey-support.mjs'

const manifestPath = process.env.PI_FACTORY_MANIFEST
if (!manifestPath) throw new Error('VERIFIED_CANDIDATE_MANIFEST_REQUIRED')

const outcome = (implementation, value) => {
  try {
    return { ok: implementation.canonicalJsonStringify(value) }
  } catch (error) {
    return { error: `${error?.constructor?.name}:${error?.message}` }
  }
}

describe('canonicalJsonStringify: installed contracts versus the CP build', () => {
  let installed, built, directory
  beforeAll(async () => {
    await verifyJourneyPackages(manifestPath)
    const webRequire = createRequire(new URL('../../package.json', import.meta.url))
    const entry = webRequire.resolve('@adea-ai/contracts')
    installed = await import(pathToFileURL(join(entry, '..', 'canonical-json.js')).href)
    const archive = JSON.parse(
      execFileSync('cat', [manifestPath], { encoding: 'utf8' })
    ).artifacts.find((artifact) => artifact.name === '@adea-ai/contracts').archive
    directory = mkdtempSync(join(tmpdir(), 'journey-drift-'))
    writeFileSync(
      join(directory, 'canonical-json.mjs'),
      execFileSync('tar', [
        '-xOf',
        join(manifestPath, '..', archive),
        'package/dist/canonical-json.js',
      ])
    )
    built = await import(pathToFileURL(join(directory, 'canonical-json.mjs')).href)
  }, 60000)
  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  const inherited = Object.create({ a: 1 })
  const nullPrototype = Object.assign(Object.create(null), { b: 2, a: [undefined, 1] })
  const edge = [
    undefined,
    null,
    true,
    '',
    'é\u{1F600}\u0000"\\',
    0,
    -0,
    1e21,
    1.5e-7,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    [],
    {},
    [undefined, null, [undefined]],
    { b: undefined, a: 1 },
    { 'a-b': 1, ab: 2, a_b: 3, Aa: 4, 'a!': 5, '\u{1F600}': 6, ﬁ: 7, 10: 8, 9: 9 },
    nullPrototype,
    { nested: { z: [{ y: 1, x: undefined }], a: null } },
    10n,
    () => 1,
    Symbol('s'),
    new Date(0),
    new Map(),
    new Set(),
    inherited,
    { inner: 10n },
    [() => 1],
  ]
  test('agree on edge values, including thrown errors', () => {
    for (const value of edge) expect(outcome(built, value)).toEqual(outcome(installed, value))
    expect(outcome(built, { b: 1, a: undefined })).toEqual({ ok: '{"b":1}' })
  })
  test('agree on seeded pseudo-random documents', () => {
    let seed = 0x1173
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
    const keys = ['a', 'b', 'ab', 'a-b', 'a_b', 'Aa', 'é', '\u{1F600}', '0', '10', '9', 'z']
    const make = (depth) => {
      const kind = Math.floor(next() * (depth > 3 ? 6 : 8))
      if (kind === 0) return null
      if (kind === 1) return next() < 0.5
      if (kind === 2) return Math.round((next() - 0.5) * 1e6) / (next() < 0.5 ? 1 : 1000)
      if (kind === 3) return String.fromCodePoint(32 + Math.floor(next() * 0x2fff))
      if (kind === 4) return undefined
      if (kind === 5) return keys[Math.floor(next() * keys.length)]
      if (kind === 6) return Array.from({ length: Math.floor(next() * 5) }, () => make(depth + 1))
      return Object.fromEntries(
        Array.from({ length: Math.floor(next() * 6) }, () => [
          keys[Math.floor(next() * keys.length)],
          make(depth + 1),
        ])
      )
    }
    for (let index = 0; index < 2000; index++) {
      const value = make(0)
      expect(outcome(built, value)).toEqual(outcome(installed, value))
    }
  })
  test('agree on code-point key order', () => {
    const left = installed.compareCodePointOrder
    const right = built.compareCodePointOrder
    for (const pair of [
      ['a', 'b'],
      ['b', 'a'],
      ['a', 'a'],
      ['\u{1F600}', 'ﬁ'],
      ['', 'a'],
    ])
      expect(right(...pair)).toBe(left(...pair))
  })
})
