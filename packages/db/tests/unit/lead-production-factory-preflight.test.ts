import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  verifyInstalledPackagePayload,
  leadFactoryMethods,
  verifyFactoryArchives,
  verifyFactorySource,
  verifyInstalledFactoryPackages,
} from '../fixtures/lead-production-factory-preflight.mjs'

const directory = mkdtempSync(join(tmpdir(), 'adea-factory-preflight-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const head = 'a'.repeat(40)
function manifest(extra: Record<string, unknown> = {}) {
  const path = join(directory, 'manifest.json')
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 'pi-durable-candidate-artifacts/v1',
      head,
      dirty: false,
      sourceDigest: `sha256:${'b'.repeat(64)}`,
      artifacts: [],
      ...extra,
    })
  )
  return path
}

describe('production factory candidate preflight', () => {
  test('rejects a manifest claiming another source head before archive loading', () => {
    expect(() => verifyFactoryArchives(manifest(), 'c'.repeat(40))).toThrow()
  })
  test('rejects dirty source provenance before archive loading', () => {
    expect(() => verifyFactoryArchives(manifest({ dirty: true }), head)).toThrow()
  })
  test('rejects changed archive bytes before extracting or importing a package', () => {
    writeFileSync(join(directory, 'contracts.tgz'), 'tampered')
    const artifacts = ['@adea-ai/contracts', '@adea-ai/runtime-sdk', '@adea-ai/sdk'].map(
      (name) => ({ name, archive: 'contracts.tgz', bytes: 8, sha256: '0'.repeat(64) })
    )
    expect(() => verifyFactoryArchives(manifest({ artifacts }), head)).toThrow()
  })
  test('rejects changed installed code even when package metadata is identical', () => {
    const payload = join(directory, 'payload', 'package')
    const installed = join(directory, 'installed')
    mkdirSync(join(payload, 'dist'), { recursive: true })
    mkdirSync(join(installed, 'dist'), { recursive: true })
    const metadata = JSON.stringify({ name: '@adea-ai/sdk', version: '1.15.0' })
    writeFileSync(join(payload, 'package.json'), metadata)
    writeFileSync(join(installed, 'package.json'), metadata)
    writeFileSync(join(payload, 'dist', 'index.js'), 'export const accepted = true')
    writeFileSync(join(installed, 'dist', 'index.js'), 'export const accepted = true')
    const archivePath = join(directory, 'payload.tgz')
    execFileSync('tar', ['-czf', archivePath, '-C', join(directory, 'payload'), 'package'])
    expect(verifyInstalledPackagePayload({ archivePath }, installed)).toBe(2)
    writeFileSync(join(installed, 'dist', 'index.js'), 'export const accepted = false')
    expect(() => verifyInstalledPackagePayload({ archivePath }, installed)).toThrow(
      'INSTALLED_ARTIFACT_PAYLOAD_MISMATCH'
    )
  })
  test('requires the owning checkout to match the verified head', () => {
    expect(() => verifyFactorySource(process.cwd(), { head })).toThrow()
  })
  test('absent installed lead capability is an explicit failure, never a mocked fallback', async () => {
    await expect(
      verifyInstalledFactoryPackages({}, import.meta.url, { supported: false })
    ).rejects.toThrow('PI_FACTORY_PROOF_UNSUPPORTED_INSTALLED_SDK')
  })
})

function syntheticFactoryPackages() {
  const fixtureRoot = mkdtempSync(join(directory, 'synthetic-packages-'))
  const artifacts = ['@adea-ai/contracts', '@adea-ai/runtime-sdk', '@adea-ai/sdk'].map(
    (name, index) => {
      const declared = {
        name,
        version: '0.0.0-unit-fixture',
        type: 'module',
        main: './dist/index.js',
      }
      const installedRoot = join(fixtureRoot, 'node_modules', name)
      mkdirSync(join(installedRoot, 'dist'), { recursive: true })
      writeFileSync(join(installedRoot, 'package.json'), JSON.stringify(declared))
      // These inert modules are local provenance fixtures only. No method is
      // called, no private package is loaded and no real factory is launched.
      const code =
        name === '@adea-ai/sdk'
          ? `export class ControlPlaneClient { ${leadFactoryMethods.map((method: string) => `${method}(){}`).join(' ')} }; export const ControlApiOperations = Object.fromEntries(${JSON.stringify(leadFactoryMethods)}.map(name => [name, {requestSchema:{parse(){}},responseSchema:{parse(){}}}]));`
          : 'export const syntheticFixture = true;'
      writeFileSync(join(installedRoot, 'dist', 'index.js'), code)
      const payloadRoot = join(fixtureRoot, `payload-${index}`)
      mkdirSync(join(payloadRoot, 'package', 'dist'), { recursive: true })
      writeFileSync(join(payloadRoot, 'package', 'package.json'), JSON.stringify(declared))
      writeFileSync(join(payloadRoot, 'package', 'dist', 'index.js'), code)
      const archive = `synthetic-${index}.tgz`
      const archivePath = join(fixtureRoot, archive)
      execFileSync('tar', ['-czf', archivePath, '-C', payloadRoot, 'package'])
      const bytes = readFileSync(archivePath)
      return {
        name,
        version: declared.version,
        archive,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        declared,
        archivePath,
      }
    }
  )
  const webManifest = join(fixtureRoot, 'package.json')
  writeFileSync(webManifest, JSON.stringify({ private: true }))
  const manifestPath = join(fixtureRoot, 'manifest.json')
  const candidate = {
    schemaVersion: 'pi-durable-candidate-artifacts/v1',
    head,
    dirty: false,
    sourceDigest: `sha256:${'b'.repeat(64)}`,
    artifacts: artifacts.map(
      ({ declared: _declared, archivePath: _archivePath, ...artifact }) => artifact
    ),
  }
  writeFileSync(manifestPath, JSON.stringify(candidate))
  return { fixtureRoot, webManifest, manifestPath, candidate, artifacts }
}

test('local synthetic archives verify declarations and all installed package instances', async () => {
  const fixture = syntheticFactoryPackages()
  const verified = verifyFactoryArchives(fixture.manifestPath, head)
  expect(verified.artifacts).toHaveLength(3)
  expect(verified.artifacts.map((artifact: { declared: unknown }) => artifact.declared)).toEqual(
    fixture.artifacts.map((artifact) => artifact.declared)
  )
  const installed = await verifyInstalledFactoryPackages(
    verified,
    pathToFileURL(fixture.webManifest),
    { supported: true }
  )
  expect(installed.methodsAndSchemas).toBe(8)
  for (const name of ['sdk', 'contracts', 'runtimeSdk'] as const) {
    expect(installed[name].version).toBe('0.0.0-unit-fixture')
    expect(installed[name].verifiedPayloadFiles).toBe(2)
  }
  // A declaration mismatch must not be accepted because the archive digest is valid.
  writeFileSync(
    fixture.manifestPath,
    JSON.stringify({
      ...fixture.candidate,
      artifacts: fixture.candidate.artifacts.map((artifact, index) =>
        index === 0 ? { ...artifact, version: 'wrong' } : artifact
      ),
    })
  )
  expect(() => verifyFactoryArchives(fixture.manifestPath, head)).toThrow()
})

test('archive path traversal is refused before opening an archive', () => {
  const fixture = syntheticFactoryPackages()
  writeFileSync(
    fixture.manifestPath,
    JSON.stringify({
      ...fixture.candidate,
      artifacts: fixture.candidate.artifacts.map((artifact, index) =>
        index === 0 ? { ...artifact, archive: '../outside.tgz' } : artifact
      ),
    })
  )
  expect(() => verifyFactoryArchives(fixture.manifestPath, head)).toThrow()
})

test('source provenance covers exact clean tracked bytes in a disposable Git fixture', () => {
  const source = mkdtempSync(join(directory, 'synthetic-source-'))
  const git = (args: string[]) =>
    execFileSync('git', ['-C', source, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git(['init'])
  const files = [
    ['a.txt', 'synthetic a\n'],
    ['b.txt', 'synthetic b\n'],
  ] as const
  for (const [file, bytes] of files) writeFileSync(join(source, file), bytes)
  git(['add', '.'])
  git([
    '-c',
    'user.name=Unit Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'synthetic fixture',
  ])
  const digest = createHash('sha256')
  for (const [file, bytes] of files) digest.update(file).update('\0').update(bytes).update('\0')
  const expected = {
    head: git(['rev-parse', 'HEAD']),
    sourceFiles: files.length,
    sourceDigest: `sha256:${digest.digest('hex')}`,
  }
  expect(verifyFactorySource(source, expected)).toEqual({
    head: expected.head,
    tree: git(['rev-parse', 'HEAD^{tree}']),
    sourceDigest: expected.sourceDigest,
  })
  expect(() => verifyFactorySource(source, { ...expected, sourceFiles: 1 })).toThrow()
  expect(() =>
    verifyFactorySource(source, { ...expected, sourceDigest: `sha256:${'0'.repeat(64)}` })
  ).toThrow()
  writeFileSync(join(source, 'a.txt'), 'changed')
  expect(() => verifyFactorySource(source, expected)).toThrow()
})
