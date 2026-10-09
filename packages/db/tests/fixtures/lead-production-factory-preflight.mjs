import assert from 'node:assert/strict'
import { FactoryFixtureFailure } from './lead-production-factory-process.mjs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, resolve } from 'node:path'

const packages = ['@adea-ai/contracts', '@adea-ai/runtime-sdk', '@adea-ai/sdk']
export const leadFactoryMethods = [
  'preparePiDurableLead',
  'lookupPiDurableLead',
  'dispatchPiDurableLead',
  'getPiDurableLeadStatus',
  'getPiDurableLeadProgress',
  'cancelPiDurableLead',
  'getPiDurableLeadPublication',
  'getModelSelectionFunding',
]
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Verify local candidate archives before opening any fixture connection. */
export function verifyFactoryArchives(manifestPath, expectedHead) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.match(expectedHead, /^[a-f0-9]{40}$/)
  assert.equal(manifest.schemaVersion, 'pi-durable-candidate-artifacts/v1')
  assert.equal(manifest.head, expectedHead)
  assert.equal(manifest.dirty, false)
  assert.match(manifest.sourceDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(manifest.artifacts.length, packages.length)
  const artifacts = manifest.artifacts.map((artifact, index) => {
    assert.equal(artifact.name, packages[index])
    assert.equal(basename(artifact.archive), artifact.archive)
    const archive = resolve(dirname(manifestPath), artifact.archive)
    const bytes = readFileSync(archive)
    assert.equal(bytes.length, artifact.bytes)
    assert.equal(sha256(bytes), artifact.sha256)
    const declared = JSON.parse(
      execFileSync('tar', ['-xOf', archive, 'package/package.json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    )
    assert.equal(declared.name, artifact.name)
    assert.equal(declared.version, artifact.version)
    return { ...artifact, declared, archivePath: archive }
  })
  return { ...manifest, artifacts }
}

export function verifyFactorySource(cpRoot, manifest) {
  const git = (args) =>
    execFileSync('git', args, { cwd: cpRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(git(['rev-parse', 'HEAD']).trim(), manifest.head)
  assert.equal(git(['status', '--porcelain']), '')
  const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean)
    .toSorted()
  assert.equal(files.length, manifest.sourceFiles)
  const digest = createHash('sha256')
  for (const file of files)
    digest
      .update(file)
      .update('\0')
      .update(readFileSync(resolve(cpRoot, file)))
      .update('\0')
  assert.equal(`sha256:${digest.digest('hex')}`, manifest.sourceDigest)
  return {
    head: manifest.head,
    tree: git(['rev-parse', 'HEAD^{tree}']).trim(),
    sourceDigest: manifest.sourceDigest,
  }
}

/** Compare the actual installed payload, not only its version and package metadata. */
export function verifyInstalledPackagePayload(artifact, installedRoot) {
  const entries = execFileSync('tar', ['-tf', artifact.archivePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\n')
    .filter(Boolean)
  let files = 0
  for (const entry of entries) {
    assert.ok(entry.startsWith('package/') && !entry.split('/').includes('..'))
    if (entry.endsWith('/')) continue
    const expected = execFileSync('tar', ['-xOf', artifact.archivePath, entry], {
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const actual = readFileSync(resolve(installedRoot, entry.slice('package/'.length)))
    assert.equal(sha256(actual), sha256(expected), `INSTALLED_ARTIFACT_PAYLOAD_MISMATCH:${entry}`)
    files++
  }
  assert.ok(files > 0)
  return files
}

/** Resolve from the actual web consumer, including both transitive package instances. */
export async function verifyInstalledFactoryPackages(manifest, webManifestUrl, port) {
  if (!port.supported) throw new FactoryFixtureFailure('PI_FACTORY_PROOF_UNSUPPORTED_INSTALLED_SDK')
  const webRequire = createRequire(webManifestUrl)
  function installed(name, from = webRequire) {
    const entry = realpathSync(from.resolve(name))
    const declared = JSON.parse(readFileSync(resolve(dirname(entry), '..', 'package.json'), 'utf8'))
    const artifact = manifest.artifacts.find((value) => value.name === name)
    assert.equal(declared.name, artifact.name)
    assert.equal(declared.version, artifact.version)
    assert.deepEqual(declared, artifact.declared)
    const verifiedPayloadFiles = verifyInstalledPackagePayload(
      artifact,
      resolve(dirname(entry), '..')
    )
    return { entry, name, version: declared.version, verifiedPayloadFiles }
  }
  const sdk = installed('@adea-ai/sdk'),
    sdkRequire = createRequire(sdk.entry)
  const contracts = installed('@adea-ai/contracts')
  const runtimeSdk = installed('@adea-ai/runtime-sdk', sdkRequire)
  assert.equal(installed('@adea-ai/contracts', sdkRequire).entry, contracts.entry)
  assert.equal(
    installed('@adea-ai/contracts', createRequire(runtimeSdk.entry)).entry,
    contracts.entry
  )
  const actualSdk = await import(sdk.entry)
  for (const method of leadFactoryMethods) {
    assert.equal(typeof actualSdk.ControlPlaneClient.prototype[method], 'function')
    assert.equal(typeof actualSdk.ControlApiOperations[method].requestSchema.parse, 'function')
    assert.equal(typeof actualSdk.ControlApiOperations[method].responseSchema.parse, 'function')
  }
  return { sdk, contracts, runtimeSdk, methodsAndSchemas: leadFactoryMethods.length }
}
