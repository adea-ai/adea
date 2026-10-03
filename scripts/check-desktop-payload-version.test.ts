import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDesktopPayloadVersion } from './check-desktop-payload-version.mjs'

const fixtures: string[] = []
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function installerFixture(contents?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'adea-payload-version-'))
  fixtures.push(directory)
  const payloadSource = join(directory, 'payload')
  const resources = join(payloadSource, 'Adea.app/Contents/Resources')
  mkdirSync(resources, { recursive: true })
  if (contents !== undefined) writeFileSync(join(resources, 'version.json'), contents)
  const outerResources = join(directory, 'installer/Adea.app/Contents/Resources')
  mkdirSync(outerResources, { recursive: true })
  const archive = join(outerResources, 'fixture.tar.zst')
  const result = spawnSync('tar', ['--zstd', '-cf', archive, '-C', payloadSource, 'Adea.app'])
  if (result.error || result.status !== 0)
    throw new Error(`Could not create payload: ${result.stderr}`)
  return { archive, outerResources }
}

describe('desktop installer payload version', () => {
  test.each(['1.2.3', '1.2.3-dev.27'])('reads %s without requiring outer metadata', (version) => {
    const { archive, outerResources } = installerFixture(
      JSON.stringify({ version, channel: 'stable' })
    )
    expect(existsSync(join(outerResources, 'version.json'))).toBe(false)
    expect(checkDesktopPayloadVersion(archive, version)).toBe(version)
  })

  test('rejects an outdated payload even if the outer installer claims the requested version', () => {
    const { archive, outerResources } = installerFixture('{"version":"1.2.2"}')
    writeFileSync(join(outerResources, 'version.json'), '{"version":"1.2.3"}')
    expect(() => checkDesktopPayloadVersion(archive, '1.2.3')).toThrow(
      'does not match release 1.2.3'
    )
  })

  test('rejects missing, malformed, and non-string payload identity', () => {
    for (const contents of [undefined, '{', '{"version":3}', 'null']) {
      const { archive } = installerFixture(contents)
      expect(() => checkDesktopPayloadVersion(archive, '1.2.3')).toThrow()
    }
  })
})
