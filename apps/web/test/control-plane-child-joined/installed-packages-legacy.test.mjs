// Opt-in negative regressions for the legacy negative control's expected-absence rule in
// installed-packages.mjs. The exactly pinned legacy contracts 1.21.4 never shipped
// dist/pi-child-publication.{js,d.ts} (CP #1204 added them later), so for that one version and
// those two paths the gate asserts the files are absent. Everything else stays strict: any other
// candidate file missing from a legacy install is still a raw ENOENT, a legacy payload that has the
// excused files is refused, and the pinned versions are still enforced. Each case tampers with a
// throwaway copy of ./legacy-sdk; the real install is never touched.
// Needs a CP checkout at the candidate pin (ADEA_CONTROL_PLANE_SOURCE), PI_FACTORY_MANIFEST for
// that checkout, and the legacy fixture installed (bun install --cwd .../legacy-sdk
// --frozen-lockfile). No database.
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'bun:test'
import { isLegacyExpectedAbsence, verifyInstalledPackages } from './installed-packages.mjs'

const manifestPath = process.env.PI_FACTORY_MANIFEST
const cpRoot = process.env.ADEA_CONTROL_PLANE_SOURCE
if (!manifestPath || !cpRoot) throw new Error('VERIFIED_CANDIDATE_MANIFEST_AND_CP_SOURCE_REQUIRED')

const pin = JSON.parse(
  readFileSync(new URL('./source-allowance-candidate.json', import.meta.url), 'utf8')
)
const legacyRoot = new URL('./legacy-sdk/', import.meta.url)
const expectedAbsent = ['dist/pi-child-publication.d.ts', 'dist/pi-child-publication.js']
const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A throwaway copy of the legacy fixture at a path the gate recognizes as the isolated install
 * (…/control-plane-child-joined/legacy-sdk/node_modules/@adea-ai/…).
 */
function copyLegacy() {
  const directory = mkdtempSync(join(tmpdir(), 'legacy-gate-'))
  directories.push(directory)
  const fixture = join(directory, 'control-plane-child-joined', 'legacy-sdk')
  mkdirSync(fixture, { recursive: true })
  cpSync(legacyRoot, fixture, { recursive: true, dereference: true })
  return {
    package: (name) => join(fixture, 'node_modules', '@adea-ai', name),
    legacySdkManifestUrl: pathToFileURL(join(fixture, 'package.json')),
  }
}

const gate = (install) =>
  verifyInstalledPackages({
    manifestPath,
    expectedHead: pin.revision,
    cpRoot,
    port: { supported: true },
    installKind: 'isolated-legacy-sdk',
    legacySdkManifestUrl: install.legacySdkManifestUrl,
  })

describe('legacy negative control: expected absence is explicit and narrow', () => {
  test('the pinned legacy install passes and records exactly the two expected absences', async () => {
    const result = await gate(copyLegacy())
    expect(result.installKind).toBe('isolated-legacy-sdk')
    const byName = Object.fromEntries(result.packages.map((entry) => [entry.name, entry]))
    expect(byName['@adea-ai/contracts'].version).toBe('1.21.4')
    expect(byName['@adea-ai/contracts'].expectedAbsentFiles).toEqual(expectedAbsent)
    for (const file of expectedAbsent)
      expect(byName['@adea-ai/contracts'].differingFiles).toContain(file)
    // The absences are reported, never hidden, and nothing else is excused.
    expect(byName['@adea-ai/runtime-sdk'].expectedAbsentFiles).toEqual([])
    expect(byName['@adea-ai/sdk'].expectedAbsentFiles).toEqual([])
    for (const entry of result.packages) expect(entry.differingFiles.length).toBeGreaterThan(0)
  }, 60000)

  for (const file of expectedAbsent)
    test(`an excused file that is present is refused: ${file}`, async () => {
      const install = copyLegacy()
      writeFileSync(join(install.package('contracts'), file), '// present\n')
      await expect(gate(install)).rejects.toThrow(
        `LEGACY_EXPECTED_ABSENT_PRESENT:@adea-ai/contracts:${file}`
      )
    }, 60000)

  test('any other candidate file missing from legacy contracts is still ENOENT', async () => {
    const install = copyLegacy()
    unlinkSync(join(install.package('contracts'), 'dist', 'graphs.js'))
    await expect(gate(install)).rejects.toThrow(/ENOENT.*graphs\.js/)
  }, 60000)

  test('a file missing from legacy runtime-sdk is still ENOENT', async () => {
    const install = copyLegacy()
    unlinkSync(join(install.package('runtime-sdk'), 'dist', 'pi-durable-lead.js'))
    await expect(gate(install)).rejects.toThrow(/ENOENT.*pi-durable-lead\.js/)
  }, 60000)

  test('a file missing from legacy sdk is still ENOENT', async () => {
    const install = copyLegacy()
    unlinkSync(join(install.package('sdk'), 'dist', 'operations.js'))
    await expect(gate(install)).rejects.toThrow(/ENOENT.*operations\.js/)
  }, 60000)

  test('a legacy contracts version other than the pinned 1.21.4 is refused by the pin', async () => {
    const install = copyLegacy()
    const file = join(install.package('contracts'), 'package.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...manifest, version: '1.21.5' }))
    await expect(gate(install)).rejects.toThrow(/LEGACY_PIN:@adea-ai\/contracts/)
  }, 60000)

  test('the excuse covers only legacy contracts 1.21.4 and the two named files', () => {
    for (const file of expectedAbsent)
      expect(isLegacyExpectedAbsence('@adea-ai/contracts', '1.21.4', file)).toBe(true)
    // Other versions, packages and files are never excused, including the neighbouring modules.
    expect(isLegacyExpectedAbsence('@adea-ai/contracts', '1.23.1', expectedAbsent[0])).toBe(false)
    expect(isLegacyExpectedAbsence('@adea-ai/contracts', '1.21.5', expectedAbsent[1])).toBe(false)
    expect(isLegacyExpectedAbsence('@adea-ai/sdk', '1.21.4', expectedAbsent[0])).toBe(false)
    expect(isLegacyExpectedAbsence('@adea-ai/runtime-sdk', '1.16.1', expectedAbsent[0])).toBe(false)
    expect(isLegacyExpectedAbsence('@adea-ai/contracts', '1.21.4', 'dist/graphs.js')).toBe(false)
    expect(
      isLegacyExpectedAbsence('@adea-ai/contracts', '1.21.4', 'dist/pi-child-publication.js.map')
    ).toBe(false)
    expect(isLegacyExpectedAbsence('__proto__', '1.21.4', expectedAbsent[0])).toBe(false)
  })
})
