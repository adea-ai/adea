import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  verifyInstalledPackagePayload,
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
