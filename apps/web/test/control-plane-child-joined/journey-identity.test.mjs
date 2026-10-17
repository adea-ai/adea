// Opt-in negative control for the package identity gate (#1173): the journey suites refuse to run
// unless the SDK/contracts installed from Adea's lockfile are byte-identical to the ones the
// pinned CP revision builds. This file proves the gate fails when it should: it copies the real
// installed packages into a throwaway tree, tampers with the copy, and requires the same gate to
// refuse. Nothing in the real install is touched. Needs the same inputs as the journey suites
// (CP checkout at the pin and PI_FACTORY_MANIFEST) but no database.
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'bun:test'
import { pin, root } from './harness.mjs'
import { verifyInstalledPackages } from './installed-packages.mjs'
import { verifyJourneyPackages } from './journey-support.mjs'
import { installedLeadSdkPort } from '../../src/server/lead-turn-sdk-port.ts'

const manifestPath = process.env.PI_FACTORY_MANIFEST
if (!manifestPath) throw new Error('VERIFIED_CANDIDATE_MANIFEST_REQUIRED')

const webManifestUrl = new URL('../../package.json', import.meta.url)
const webRequire = createRequire(webManifestUrl)
const packageRoot = (entry) => resolve(dirname(realpathSync(entry)), '..')
const sdkRoot = packageRoot(webRequire.resolve('@adea-ai/sdk'))
const sources = {
  '@adea-ai/sdk': sdkRoot,
  '@adea-ai/contracts': packageRoot(webRequire.resolve('@adea-ai/contracts')),
  '@adea-ai/runtime-sdk': packageRoot(createRequire(sdkRoot).resolve('@adea-ai/runtime-sdk')),
}
const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A throwaway copy of the installed package layout, resolvable the way the gate resolves it. */
function copyInstall(manifestChanges = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'journey-identity-'))
  directories.push(directory)
  const bunDirectory = (name) => {
    const real = sources[name]
    // .../node_modules/.bun/@adea-ai+<name>@<version>/node_modules/@adea-ai/<name>
    return join(directory, 'node_modules', '.bun', basename(dirname(dirname(dirname(real)))))
  }
  const copies = {}
  for (const [name, real] of Object.entries(sources)) {
    const target = join(bunDirectory(name), 'node_modules', '@adea-ai', basename(real))
    cpSync(real, target, { recursive: true })
    copies[name] = target
  }
  // The SDK finds runtime-sdk as its sibling dependency, as in the real install.
  symlinkSync(
    copies['@adea-ai/runtime-sdk'],
    join(dirname(copies['@adea-ai/sdk']), 'runtime-sdk'),
    'dir'
  )
  for (const name of ['@adea-ai/sdk', '@adea-ai/contracts']) {
    mkdirSync(join(directory, 'node_modules', '@adea-ai'), { recursive: true })
    symlinkSync(
      relative(join(directory, 'node_modules', '@adea-ai'), copies[name]),
      join(directory, 'node_modules', '@adea-ai', basename(sources[name])),
      'dir'
    )
  }
  const manifest = JSON.parse(readFileSync(webManifestUrl, 'utf8'))
  manifest.dependencies = { ...manifest.dependencies, ...manifestChanges }
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
  return { copies, webManifestUrl: pathToFileURL(join(directory, 'package.json')) }
}

const gate = (install) =>
  verifyInstalledPackages({
    manifestPath,
    expectedHead: pin.revision,
    cpRoot: root,
    port: installedLeadSdkPort,
    installKind: 'registry',
    webManifestUrl: install.webManifestUrl,
  })

describe('package identity gate refuses what is not the reviewed registry payload', () => {
  test('the real lockfile install passes with no allowed drift', async () => {
    const result = await verifyJourneyPackages(manifestPath)
    expect(result.installKind).toBe('registry')
    expect(result.head).toBe(pin.revision)
    expect(result.packages.map((entry) => `${entry.name}@${entry.version}`)).toEqual([
      '@adea-ai/contracts@1.21.3',
      '@adea-ai/runtime-sdk@1.15.1',
      '@adea-ai/sdk@1.18.1',
    ])
    for (const entry of result.packages) expect(entry).not.toHaveProperty('differingFiles')
  }, 60000)

  test('a changed byte in an installed file is refused and names the package and file', async () => {
    const install = copyInstall()
    appendFileSync(join(install.copies['@adea-ai/contracts'], 'dist', 'graphs.js'), '\n// x')
    await expect(gate(install)).rejects.toThrow(
      /INSTALLED_PAYLOAD_DIFFERS:@adea-ai\/contracts:package\/dist\/graphs\.js/
    )
  }, 60000)

  test('a changed lead contract file in runtime-sdk is refused', async () => {
    const install = copyInstall()
    appendFileSync(
      join(install.copies['@adea-ai/runtime-sdk'], 'dist', 'pi-durable-lead.js'),
      '\n// x'
    )
    await expect(gate(install)).rejects.toThrow(
      /INSTALLED_PAYLOAD_DIFFERS:@adea-ai\/runtime-sdk:package\/dist\/pi-durable-lead\.js/
    )
  }, 60000)

  test('a file missing from the install is refused', async () => {
    const install = copyInstall()
    unlinkSync(join(install.copies['@adea-ai/sdk'], 'dist', 'operations.js'))
    await expect(gate(install)).rejects.toThrow(/operations\.js/)
  }, 60000)

  test('a changed load field in an installed manifest is refused', async () => {
    const install = copyInstall()
    const file = join(install.copies['@adea-ai/contracts'], 'package.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...manifest, main: './dist/other.js' }))
    await expect(gate(install)).rejects.toThrow(/@adea-ai\/contracts main/)
  }, 60000)

  test('a floating dependency range instead of an exact lockfile pin is refused', async () => {
    const install = copyInstall({ '@adea-ai/sdk': '^1.18.1' })
    await expect(gate(install)).rejects.toThrow(/@adea-ai\/sdk must be an exact pin/)
  }, 60000)
})
