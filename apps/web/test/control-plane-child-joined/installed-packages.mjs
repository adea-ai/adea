// Verifies that the SDK/contracts packages Adea's web app actually has installed from its own
// lockfile are the ones the Control Plane head under test builds. Nothing is overridden or
// substituted: the packages are the registry versions in Adea's dependency graph. The one
// exception is the 'isolated-legacy-sdk' install kind, the negative control: the exactly pinned
// packages in ./legacy-sdk (which predate the field under test), resolved in place of Adea's own.
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
const defaultWebManifestUrl = new URL('../../package.json', import.meta.url)
const legacySdkManifestUrl = new URL('./legacy-sdk/package.json', import.meta.url)
// The exact registry versions installed in ./legacy-sdk: the last releases that predate the lead
// `childAllowance` disclosure (CP #1136, first published in sdk 1.20.0 and runtime-sdk 1.17.0).
const legacySdkPins = Object.freeze({
  '@adea-ai/contracts': '1.21.4',
  '@adea-ai/runtime-sdk': '1.16.1',
  '@adea-ai/sdk': '1.19.1',
})
// The fields that decide what a consumer resolves and loads. The publish step rewrites the
// remaining manifest fields (dependency ranges, empty dev/peer maps), so those are reported, not
// compared.
const loadFields = ['name', 'version', 'type', 'main', 'module', 'types', 'exports', 'files']

/**
 * installKind 'registry' (default): the packages are registry installs from Adea's lockfile, with
 * exact pins, and must be byte-identical to the CP candidate: the current consumer acceptance gate.
 * 'candidate-overlay': a throwaway checkout whose manifest points at the packed candidate archives
 * themselves (file: tarballs). That is pre-release evidence for a CP change no published package
 * carries yet; it is never evidence about Adea's lockfile or a release.
 * 'isolated-legacy-sdk': legacy compatibility evidence. The packages are the exact registry
 * versions pinned in ./legacy-sdk (installed there with its own lockfile, outside Adea's dependency
 * graph and swapped in by ./legacy-sdk/tsconfig.override.json). They are expected to differ from
 * the candidate: the differing files are returned and must be non-empty, so the gap a consumer
 * would have without the bump is on the record.
 */
export async function verifyInstalledPackages({
  manifestPath,
  expectedHead,
  cpRoot,
  port,
  installKind = 'registry',
  /** The web app manifest whose resolution decides which installed packages are compared. */
  webManifestUrl = defaultWebManifestUrl,
}) {
  assert.ok(
    ['registry', 'isolated-legacy-sdk', 'candidate-overlay'].includes(installKind),
    'UNKNOWN_INSTALL_KIND'
  )
  const legacy = installKind === 'isolated-legacy-sdk'
  const manifest = verifyFactoryArchives(manifestPath, expectedHead)
  const source = verifyFactorySource(cpRoot, manifest)
  const baseUrl = legacy ? legacySdkManifestUrl : webManifestUrl
  const webManifest = JSON.parse(readFileSync(webManifestUrl, 'utf8'))
  const webRequire = createRequire(baseUrl)
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
    if (legacy) {
      // The isolated fixture's own install, with exactly the pinned version.
      assert.match(
        installedRoot,
        /\/control-plane-child-joined\/legacy-sdk\/node_modules\/@adea-ai\//
      )
      assert.equal(installed.version, legacySdkPins[artifact.name], `LEGACY_PIN:${artifact.name}`)
    } else if (installKind !== 'candidate-overlay') {
      // A registry install in Adea's dependency graph, not a file: or workspace link.
      assert.match(installedRoot, /node_modules\/\.bun\/@adea-ai\+[a-z-]+@[0-9.]+\/node_modules\//)
    } else {
      // The overlay installs exactly the packed archive the manifest names.
      assert.match(installedRoot, /node_modules\/\.bun\/@adea-ai\+[a-z-]+@/)
      assert.equal(sha256(readFileSync(artifact.archivePath)), artifact.sha256, 'ARCHIVE_DIGEST')
      if (artifact.name !== '@adea-ai/runtime-sdk')
        assert.equal(webManifest.dependencies[artifact.name], `file:${artifact.archivePath}`)
    }
    // A patch version can differ when the release changed nothing a consumer loads (CP's contracts
    // 1.21.1 changed tests only). The identity claim is the payload comparison below, and the
    // version difference is reported, never hidden.
    for (const field of loadFields.filter((key) => key !== 'version'))
      assert.deepEqual(installed[field], artifact.declared[field], `${artifact.name} ${field}`)
    const differing = []
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
      if (legacy) {
        if (sha256(actual) !== sha256(built)) differing.push(name.slice('package/'.length))
        continue
      }
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
      ...(legacy
        ? { candidateVersion: artifact.version, differingFiles: differing.toSorted() }
        : {}),
    })
  }
  if (!legacy && installKind !== 'candidate-overlay')
    for (const name of ['@adea-ai/sdk', '@adea-ai/contracts'])
      assert.match(
        webManifest.dependencies[name],
        /^\d+\.\d+\.\d+$/,
        `${name} must be an exact pin`
      )
  assert.equal(port.supported, true, 'PI_FACTORY_PROOF_UNSUPPORTED_INSTALLED_SDK')
  const actualSdk = await import(sdkEntry)
  for (const method of leadFactoryMethods) {
    assert.equal(typeof actualSdk.ControlPlaneClient.prototype[method], 'function')
    assert.equal(typeof actualSdk.ControlApiOperations[method].requestSchema.parse, 'function')
    assert.equal(typeof actualSdk.ControlApiOperations[method].responseSchema.parse, 'function')
  }
  return {
    head: manifest.head,
    sourceDigest: source.sourceDigest,
    tree: source.tree,
    installKind,
    packages,
  }
}
