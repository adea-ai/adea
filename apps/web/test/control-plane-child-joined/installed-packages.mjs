// Verifies that the SDK/contracts packages Adea's web app actually has installed from its own
// lockfile are the ones the Control Plane head under test builds. Nothing is overridden or
// substituted: the packages are the registry versions in Adea's dependency graph.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import {
  verifyFactoryArchives,
  verifyFactorySource,
  leadFactoryMethods,
} from '../../../../packages/db/tests/fixtures/lead-production-factory-preflight.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const webManifestUrl = new URL('../../package.json', import.meta.url)
// The fields that decide what a consumer resolves and loads. The publish step rewrites the
// remaining manifest fields (dependency ranges, empty dev/peer maps), so those are reported, not
// compared.
const loadFields = ['name', 'version', 'type', 'main', 'module', 'types', 'exports', 'files']

export async function verifyInstalledPackages({ manifestPath, expectedHead, cpRoot, port }) {
  const manifest = verifyFactoryArchives(manifestPath, expectedHead)
  const source = verifyFactorySource(cpRoot, manifest)
  const webManifest = JSON.parse(readFileSync(webManifestUrl, 'utf8'))
  const webRequire = createRequire(webManifestUrl)
  const sdkEntry = realpathSync(webRequire.resolve('@adea-ai/sdk'))
  const entries = {
    '@adea-ai/sdk': sdkEntry,
    '@adea-ai/contracts': realpathSync(webRequire.resolve('@adea-ai/contracts')),
    '@adea-ai/runtime-sdk': realpathSync(createRequire(sdkEntry).resolve('@adea-ai/runtime-sdk')),
  }
  const packages = []
  for (const artifact of manifest.artifacts) {
    const entry = entries[artifact.name]
    const installedRoot = resolve(dirname(entry), '..')
    const installed = JSON.parse(readFileSync(resolve(installedRoot, 'package.json'), 'utf8'))
    assert.equal(installed.name, artifact.name)
    // A registry install in Adea's dependency graph, not a file: or workspace link.
    assert.match(installedRoot, /node_modules\/\.bun\/@adea-ai\+[a-z-]+@[0-9.]+\/node_modules\//)
    // A patch version can differ when the release changed nothing a consumer loads (CP's contracts
    // 1.21.1 changed tests only). The identity claim is the payload comparison below, and the
    // version difference is reported, never hidden.
    for (const field of loadFields.filter((key) => key !== 'version'))
      assert.deepEqual(installed[field], artifact.declared[field], `${artifact.name} ${field}`)
    const tarEntries = execFileSync('tar', ['-tf', artifact.archivePath], { encoding: 'utf8' })
      .split('\n')
      .filter((name) => name && !name.endsWith('/') && name !== 'package/package.json')
    assert.ok(tarEntries.length > 0)
    for (const name of tarEntries) {
      assert.ok(name.startsWith('package/') && !name.split('/').includes('..'))
      const built = execFileSync('tar', ['-xOf', artifact.archivePath, name], {
        maxBuffer: 20 * 1024 * 1024,
      })
      const actual = readFileSync(resolve(installedRoot, name.slice('package/'.length)))
      assert.equal(
        sha256(actual),
        sha256(built),
        `INSTALLED_PAYLOAD_DIFFERS:${artifact.name}:${name}`
      )
    }
    packages.push({
      name: artifact.name,
      version: installed.version,
      comparedFiles: tarEntries.length,
    })
  }
  for (const name of ['@adea-ai/sdk', '@adea-ai/contracts'])
    assert.match(webManifest.dependencies[name], /^\d+\.\d+\.\d+$/, `${name} must be an exact pin`)
  assert.equal(port.supported, true, 'PI_FACTORY_PROOF_UNSUPPORTED_INSTALLED_SDK')
  const actualSdk = await import(sdkEntry)
  for (const method of leadFactoryMethods) {
    assert.equal(typeof actualSdk.ControlPlaneClient.prototype[method], 'function')
    assert.equal(typeof actualSdk.ControlApiOperations[method].requestSchema.parse, 'function')
    assert.equal(typeof actualSdk.ControlApiOperations[method].responseSchema.parse, 'function')
  }
  return { head: manifest.head, sourceDigest: source.sourceDigest, tree: source.tree, packages }
}
