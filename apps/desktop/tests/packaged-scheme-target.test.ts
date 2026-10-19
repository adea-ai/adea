// The packaging boundary of the packaged desktop: the callback scheme the
// GENERATED bundle registers, and the build target the GENERATED bundle
// carries.
//
// Both facts are read from the built macOS bundle, not only from the source
// that declares them:
//
//   1. `Contents/Info.plist` carries `CFBundleURLTypes` whose
//      `CFBundleURLSchemes` contains `adea`. `electrobun.config.ts` declares
//      that scheme; this asserts the declaration actually reaches the bundle,
//      which is what lets the OS hand the packaged shell an
//      `adea://auth/callback` URL at all.
//   2. The bundle's embedded `Resources/app/client/adea-desktop-target.json`
//      is the LOCAL development target the client build records, and the
//      existing release gate (`apps/desktop/scripts/verify-release-target.mjs`)
//      REFUSES it: a locally built bundle can never pass the release check.
//
// The release branch of the same target contract is proved without a release
// build: the record a release build writes is accepted by that same gate.
//
// The bundle half needs a local `bun run --cwd apps/desktop shell:build` (the
// packaged lane builds it first). Without a bundle that half is skipped
// LOUDLY, and the halves that do not need a bundle still assert, so a green
// lane never means "nothing was checked".
//
// Scope: this proves the generated bundle's shape. It does NOT prove OS-level
// registration — macOS hands `adea://` URLs only to an app that is installed
// and registered with LaunchServices, which needs a live install.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DEFAULT_CLOUD_ORIGIN,
  DESKTOP_TARGET_FILE,
  desktopBuildTarget,
  isLoopbackCloudOrigin,
  parseDesktopTarget,
  serializeDesktopTarget,
} from '../scripts/cloud-config.mjs'
import { findAppBundle } from '../shell/scripts/packaged-install'

const buildRoot = new URL('../shell/build', import.meta.url).pathname
// The packaged lane's dev bundle; a stable-channel bundle is never picked by
// accident (`findAppBundle` prefers `dev-macos-arm64/Adea-dev.app`).
const appBundle = findAppBundle(buildRoot)
const verifierPath = new URL('../scripts/verify-release-target.mjs', import.meta.url).pathname
const shellConfigPath = new URL('../shell/electrobun.config.ts', import.meta.url).pathname

/** Reads the bundle's `Info.plist` as JSON; `plutil` is the macOS-native reader. */
function readInfoPlist(bundle: string): Record<string, unknown> {
  const result = Bun.spawnSync(
    ['/usr/bin/plutil', '-convert', 'json', '-o', '-', join(bundle, 'Contents/Info.plist')],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  if (result.exitCode !== 0) {
    throw new Error(`plutil could not read the bundle plist: ${result.stderr.toString()}`)
  }
  return JSON.parse(result.stdout.toString()) as Record<string, unknown>
}

/** The URL schemes the bundle's `Info.plist` registers, across every URL type. */
function registeredSchemes(bundle: string): string[] {
  const urlTypes = readInfoPlist(bundle)['CFBundleURLTypes']
  if (!Array.isArray(urlTypes)) return []
  return urlTypes.flatMap((entry) => {
    const schemes = (entry as Record<string, unknown>)['CFBundleURLSchemes']
    return Array.isArray(schemes) ? schemes.map(String) : []
  })
}

/**
 * Runs the existing release target gate over a record, exactly as the release
 * lane does (the record on stdin, the gate's exit code as the verdict).
 */
function runReleaseGate(record: string): { exitCode: number; stderr: string; stdout: string } {
  const result = Bun.spawnSync([process.execPath, 'run', verifierPath], {
    stdin: Buffer.from(record, 'utf8'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  }
}

describe('desktop packaged scheme declaration', () => {
  test('the shell config declares the scheme the packaged bundle must register', () => {
    // The source of the bundle's `CFBundleURLTypes` entry. The generated
    // plist is proved below; this keeps the two tied together.
    expect(readFileSync(shellConfigPath, 'utf8')).toContain("urlSchemes: ['adea']")
  })
})

describe('desktop packaged build target gate', () => {
  test('the record a release build writes is accepted by the release gate', () => {
    const release = desktopBuildTarget({ release: true })
    expect(release).toEqual({ mode: 'release', cloudOrigin: DEFAULT_CLOUD_ORIGIN })
    const gate = runReleaseGate(serializeDesktopTarget(release))
    expect(gate.exitCode).toBe(0)
    expect(gate.stdout).toContain('Packaged client target verified')
  })

  test('a development record is refused by the release gate', () => {
    // A local build and a hosted development build both name a mode the
    // release gate must not accept, whatever origin they carry.
    for (const target of [
      desktopBuildTarget({ release: false }),
      desktopBuildTarget({ explicit: DEFAULT_CLOUD_ORIGIN, release: false, allowHosted: 'true' }),
    ]) {
      const gate = runReleaseGate(serializeDesktopTarget(target))
      expect(gate.exitCode).not.toBe(0)
      expect(gate.stderr).toContain('not as a release build')
    }
  })
})

describe.skipIf(process.platform !== 'darwin' || !appBundle)(
  'packaged macOS bundle: callback scheme and embedded build target',
  () => {
    test('the bundle registers the adea URL scheme in its Info.plist', () => {
      expect(
        appBundle,
        'the packaged bundle is missing — run `bun run --cwd apps/desktop shell:build` to build the .app first'
      ).not.toBeNull()
      expect(registeredSchemes(appBundle!)).toContain('adea')
    })

    test('the URL type is named after the bundle identifier', () => {
      const plist = readInfoPlist(appBundle!)
      const urlTypes = plist['CFBundleURLTypes']
      expect(Array.isArray(urlTypes)).toBe(true)
      const names = (urlTypes as Record<string, unknown>[]).map((entry) => entry['CFBundleURLName'])
      expect(names).toContain(plist['CFBundleIdentifier'])
    })

    test('the bundle embeds the local development target, which the release gate refuses', () => {
      const record = readFileSync(
        join(appBundle!, 'Contents/Resources/app/client', DESKTOP_TARGET_FILE),
        'utf8'
      )
      // The embedded record must parse: a malformed one stops the shell.
      const target = parseDesktopTarget(record)
      expect(target.mode).toBe('local')
      expect(isLoopbackCloudOrigin(target.cloudOrigin)).toBe(true)
      // It is the local development target, by the same rule the client build
      // applies.
      expect(target).toEqual(desktopBuildTarget({ explicit: target.cloudOrigin, release: false }))
      // And it can never pass the release gate.
      const gate = runReleaseGate(record)
      expect(gate.exitCode).not.toBe(0)
      expect(gate.stderr).toContain('not as a release build')
    })
  }
)
