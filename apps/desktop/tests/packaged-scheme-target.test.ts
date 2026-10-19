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
// BUNDLE SELECTION. The shared `findAppBundle` helper prefers
// `dev-macos-arm64/Adea-dev.app` but then returns ANY `.app` it finds, so a
// stable-only checkout hands back the stable bundle. The local-mode
// assertions below are about the DEV build's local target, and the stable
// bundle carries the RELEASE target, so selecting it there would fail a
// checkout that is entirely correct. This file therefore selects the
// development bundle itself — by its exact packaged path, and only after the
// bundle's own recorded channel says `dev` — and the regressions below prove
// that a stable-only checkout and a bundle-less checkout both select nothing.
//
// The bundle half needs a local `bun run --cwd apps/desktop shell:build` (the
// packaged lane builds it first). Without a bundle that half is skipped
// LOUDLY, and the halves that do not need a bundle still assert, so a green
// lane never means "nothing was checked".
//
// Scope: this proves the generated bundle's shape. It does NOT prove OS-level
// registration — macOS hands `adea://` URLs only to an app that is installed
// and registered with LaunchServices, which needs a live install.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
// The packaged lane's DEVELOPMENT bundle, by its exact packaged path. The
// shared `findAppBundle` is not used to pick it: that helper falls back to
// any `.app` it finds, which on a stable-only checkout is the stable bundle.
const DEVELOPMENT_BUNDLE = join('dev-macos-arm64', 'Adea-dev.app')
const verifierPath = new URL('../scripts/verify-release-target.mjs', import.meta.url).pathname
const shellConfigPath = new URL('../shell/electrobun.config.ts', import.meta.url).pathname

/**
 * The bundle's own recorded channel, or null when its identity file is
 * missing or malformed.
 *
 * `readPackagedIdentity` (the shared helper) falls back to `dev` when
 * `Contents/Resources/version.json` cannot be read, so it cannot decide that
 * a bundle IS the development build. This reads the identity file directly
 * and fails closed.
 */
function readBundleChannel(bundle: string): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(bundle, 'Contents/Resources/version.json'), 'utf8')
    ) as Record<string, unknown>
    return typeof parsed.channel === 'string' ? parsed.channel : null
  } catch {
    return null
  }
}

/**
 * The VERIFIED development bundle under a build root, or null.
 *
 * Selection is by the exact packaged path, then by the bundle's own recorded
 * channel. A bundle that cannot prove it is the development build is never
 * returned, so the development-bundle assertions below are never handed a
 * stable bundle (or any other `.app` a checkout happens to contain).
 */
function findDevelopmentBundle(root: string): string | null {
  const candidate = join(root, DEVELOPMENT_BUNDLE)
  if (!existsSync(candidate)) return null
  if (readBundleChannel(candidate) !== 'dev') return null
  return candidate
}

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

/**
 * The local-development-target contract: the embedded record is the local
 * target the client build recorded, and the release gate refuses it.
 *
 * This is the contract of the DEVELOPMENT bundle. The stable bundle carries
 * the release record and therefore does not satisfy it.
 */
function assertLocalDevelopmentTarget(bundle: string): void {
  const record = readFileSync(
    join(bundle, 'Contents/Resources/app/client', DESKTOP_TARGET_FILE),
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

// The development bundle the assertions below read.
const developmentBundle = findDevelopmentBundle(buildRoot)

describe.skipIf(process.platform !== 'darwin' || !developmentBundle)(
  'packaged macOS bundle: callback scheme and embedded build target',
  () => {
    test('the bundle registers the adea URL scheme in its Info.plist', () => {
      expect(
        developmentBundle,
        'the development bundle is missing — run `bun run --cwd apps/desktop shell:build` to build the .app first'
      ).not.toBeNull()
      expect(registeredSchemes(developmentBundle!)).toContain('adea')
    })

    test('the URL type is named after the bundle identifier', () => {
      const plist = readInfoPlist(developmentBundle!)
      const urlTypes = plist['CFBundleURLTypes']
      expect(Array.isArray(urlTypes)).toBe(true)
      const names = (urlTypes as Record<string, unknown>[]).map((entry) => entry['CFBundleURLName'])
      expect(names).toContain(plist['CFBundleIdentifier'])
    })

    test('the bundle embeds the local development target, which the release gate refuses', () => {
      assertLocalDevelopmentTarget(developmentBundle!)
    })
  }
)

describe('development bundle selection', () => {
  const roots: string[] = []
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  /** Stages a build root holding one bundle, or an empty root when null. */
  function stageBuildRoot(
    bundle: {
      path: readonly string[]
      channel: string
      target: string
    } | null
  ): string {
    const root = mkdtempSync(join(tmpdir(), 'adea-packaged-scheme-'))
    roots.push(root)
    if (!bundle) return root
    const appBundle = join(root, ...bundle.path)
    mkdirSync(join(appBundle, 'Contents/Resources/app/client'), { recursive: true })
    writeFileSync(
      join(appBundle, 'Contents/Resources/version.json'),
      JSON.stringify({
        version: '1.2.3',
        channel: bundle.channel,
        identifier: 'dev.adea.desktop',
      })
    )
    writeFileSync(
      join(appBundle, 'Contents/Resources/app/client', DESKTOP_TARGET_FILE),
      bundle.target
    )
    return root
  }

  test('a stable-only checkout does not select a development bundle', () => {
    const root = stageBuildRoot({
      path: ['stable-macos-arm64', 'Adea.app'],
      channel: 'stable',
      target: serializeDesktopTarget(desktopBuildTarget({ release: true })),
    })
    const stableBundle = join(root, 'stable-macos-arm64', 'Adea.app')
    // The shared helper is loose: it prefers the dev bundle, then returns ANY
    // `.app` it finds, so it hands back the stable bundle here. That is the
    // behaviour this selection must not inherit.
    expect(findAppBundle(root)).toBe(stableBundle)
    // The stable bundle is not the development bundle, so it is never handed
    // to the development-bundle assertions.
    expect(findDevelopmentBundle(root)).toBeNull()
    // And the local-mode contract genuinely does not hold for it — which is
    // exactly why selecting it there would fail a correct checkout.
    expect(() => assertLocalDevelopmentTarget(stableBundle)).toThrow()
  })

  test('a checkout with no bundle selects nothing', () => {
    // An empty build root, and a build root that does not exist at all.
    for (const root of [stageBuildRoot(null), join(stageBuildRoot(null), 'absent')]) {
      expect(findAppBundle(root)).toBeNull()
      expect(findDevelopmentBundle(root)).toBeNull()
    }
  })
})

// The bundle half is skipped when no development bundle is present. A green
// lane must not read as "the packaged bundle was proven" when it was not.
describe('packaged bundle availability', () => {
  test('the development bundle is either proven, or reported as unproven', () => {
    if (developmentBundle) {
      expect(readBundleChannel(developmentBundle)).toBe('dev')
      expect(existsSync(join(developmentBundle, 'Contents/Info.plist'))).toBe(true)
      return
    }
    // A real skip, not a quiet pass: the development-bundle assertions are
    // SKIPPED, not verified. Say so, and assert the selection reported
    // nothing rather than falling back to some other `.app`.
    console.log(
      'DEVELOPMENT BUNDLE NOT PRESENT: the packaged scheme and embedded target assertions are ' +
        'SKIPPED, not verified. Build it with `bun run --cwd apps/desktop shell:build`.'
    )
    expect(findDevelopmentBundle(buildRoot)).toBeNull()
  })
})
