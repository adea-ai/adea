// Packaging lane: install-location resolution for the bundled component
// manifest (M10 #185, Dev Runtime spec "Local stack supervision").
//
// The manifest's `installLocation` is a bundle-relative label; this module is
// the packaging lane that resolves each label to an absolute path inside the
// Electrobun-built .app and proves containment + existence + artifact digest
// before anything is launched. It replaces the supervision smoke's dev-mode
// stand-ins when the lane runs packaged: the supervised sidecar command is
// resolved from the bundled layout and executed by the bundled Bun runtime
// (`Contents/MacOS/bun`, the repository-pinned Bun line), never by the
// smoke's own toolchain.
//
// Pure resolution over the real bundle: no side effects beyond reading files.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import {
  decodeComponentManifest,
  type ComponentManifest,
  type ComponentSpec,
} from '../src/supervision/component-manifest'
import type { ComponentCommand } from '../src/supervision/process-adapter'

/** Bundle-relative label of the packaged terminal sidecar entry, staged by
 *  the packaging lane (apps/desktop/scripts/shell.mjs + electrobun copy). */
export const SIDECAR_INSTALL_LABEL = 'Contents/Resources/app/dev-runtime-sidecar/entry.js'
/** Bundle-relative label of the bundled Bun runtime (the sidecar's executor). */
export const BUN_INSTALL_LABEL = 'Contents/MacOS/bun'
/** Bundle-relative label of the packaged app launcher binary. */
export const LAUNCHER_INSTALL_LABEL = 'Contents/MacOS/launcher'

export type InstallResolution =
  | { ok: true; label: string; absolutePath: string; bytes: number; digestSha256: string }
  | { ok: false; label: string; reason: string }

function sha256File(path: string): string {
  const hasher = createHash('sha256')
  hasher.update(readFileSync(path))
  return hasher.digest('hex')
}

/** Resolves one bundle-relative install label to an absolute path inside
 *  `appBundle`. Absolute labels, `..` escapes, and anything that resolves
 *  outside the bundle are refused — an install location can never point at
 *  host state outside the packaged layout. */
export function resolveInstallLocation(appBundle: string, label: string): InstallResolution {
  const bundleRoot = resolve(appBundle)
  if (label.length === 0) return { ok: false, label, reason: 'empty install label' }
  if (label.startsWith('/') || label.startsWith('\\')) {
    return { ok: false, label, reason: 'install label must be bundle-relative' }
  }
  const absolute = resolve(bundleRoot, label)
  if (absolute !== bundleRoot && !absolute.startsWith(bundleRoot + sep)) {
    return { ok: false, label, reason: 'resolved path escapes the app bundle' }
  }
  let stats
  try {
    stats = statSync(absolute)
  } catch {
    return { ok: false, label, reason: `no packaged artifact at ${label}` }
  }
  if (!stats.isFile()) {
    return { ok: false, label, reason: `packaged artifact ${label} is not a regular file` }
  }
  return {
    ok: true,
    label,
    absolutePath: absolute,
    bytes: stats.size,
    digestSha256: sha256File(absolute),
  }
}

/** Finds the Electrobun-built .app under the shell build directory, or null
 *  when the packaged lane has not built yet (same search the lane wrapper
 *  uses for its summary). */
export function findAppBundle(buildRoot: string, depth = 0): string | null {
  if (depth > 6) return null
  let entries
  try {
    entries = readdirSync(buildRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith('.app')) return join(buildRoot, entry.name)
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findAppBundle(join(buildRoot, entry.name), depth + 1)
      if (found) return found
    }
  }
  return null
}

export type PackagedIdentity = {
  appBundle: string
  version: string
  channel: string
  /** Resolved facts for every packaged component label, in manifest order. */
  resolutions: InstallResolution[]
}

/** Reads the bundle's own version identity (Resources/version.json). */
export function readPackagedIdentity(appBundle: string): PackagedIdentity {
  const versionPath = resolve(appBundle, 'Contents/Resources/version.json')
  let version = '0.0.0'
  let channel = 'dev'
  try {
    const parsed = JSON.parse(readFileSync(versionPath, 'utf8')) as Record<string, unknown>
    if (typeof parsed.version === 'string') version = parsed.version
    if (typeof parsed.channel === 'string') channel = parsed.channel
  } catch {
    // A bundle without a readable version.json still resolves components;
    // the identity falls back to the decoder defaults.
  }
  return { appBundle: resolve(appBundle), version, channel, resolutions: [] }
}

/**
 * Resolves the REAL packaged components: every component's install label is
 * resolved through `resolveInstallLocation`, the artifact digest is the
 * actual SHA-256 of the bundled bytes, and a label that fails resolution
 * fails the build — the manifest never describes an artifact the bundle does
 * not contain.
 *
 * Components:
 * - `dev-runtime-sidecar`: the packaged sidecar entry, executed by the
 *   bundled Bun runtime. This is the component the supervision smoke starts.
 * - `app-shell`: the Electrobun launcher binary. Resolved and digested only —
 *   starting a GUI app binary is not part of the headless evidence lane, so
 *   it stays an optional, never-started component (optional components never
 *   gate baseline readiness).
 */
export function resolvePackagedComponents(appBundle: string): {
  specs: ComponentSpec[]
  identity: PackagedIdentity
  commands: (dataDir: string) => Record<string, ComponentCommand>
} {
  const identity = readPackagedIdentity(appBundle)
  const resolutions: InstallResolution[] = [
    resolveInstallLocation(appBundle, SIDECAR_INSTALL_LABEL),
    resolveInstallLocation(appBundle, BUN_INSTALL_LABEL),
    resolveInstallLocation(appBundle, LAUNCHER_INSTALL_LABEL),
  ]
  identity.resolutions = resolutions
  const failed = resolutions.find((entry) => !entry.ok)
  if (failed) {
    throw new Error(
      `packaged install-location resolution failed: ${failed.label} — ${
        (failed as { reason: string }).reason
      }`
    )
  }
  const [sidecar, bun, launcher] = resolutions as Array<Extract<InstallResolution, { ok: true }>>

  const appVersion = `${identity.version}`
  const specs: ComponentSpec[] = [
    {
      id: 'dev-runtime-sidecar',
      product: 'Dev Runtime terminal sidecar (packaged entry)',
      version: appVersion,
      platform: 'darwin',
      arch: 'arm64',
      digestSha256: sidecar.digestSha256,
      // Signature verification belongs to the release lane; the dev-channel
      // bundle carries the lane's unsigned placeholder, as shipped.
      signature: 'c2ln',
      compatibility: { minAppVersion: '0.1.0', maxAppVersion: '99.0.0' },
      installLocation: SIDECAR_INSTALL_LABEL,
      dataLocation: 'dev-runtime/terminal-sidecar',
      startupPhase: 0,
      dependsOn: [],
      healthProbe: { kind: 'process', intervalMs: 15_000, unhealthyAfterMs: 45_000 },
      protocol: { name: 'adea.sidecar.terminal', major: 1, minor: 0 },
      rollbackTargetVersion: null,
      required: false,
    },
    {
      id: 'app-shell',
      product: 'Adea desktop shell launcher (Electrobun)',
      version: appVersion,
      platform: 'darwin',
      arch: 'arm64',
      digestSha256: launcher.digestSha256,
      signature: 'c2ln',
      compatibility: { minAppVersion: '0.1.0', maxAppVersion: '99.0.0' },
      installLocation: LAUNCHER_INSTALL_LABEL,
      dataLocation: 'app-shell',
      startupPhase: 0,
      dependsOn: [],
      healthProbe: { kind: 'process', intervalMs: 15_000, unhealthyAfterMs: 45_000 },
      protocol: null,
      rollbackTargetVersion: null,
      required: false,
    },
  ]
  const bunPath = bun.absolutePath
  const sidecarPath = sidecar.absolutePath
  const sidecarVersion = `${identity.version}-${identity.channel}`
  const sidecarIdentity = `adea-terminal-sidecar@${sidecarVersion}`
  return {
    specs,
    identity,
    commands: (dataDir: string) => ({
      // The packaged sidecar runs on the bundle's own Bun runtime: the
      // supervised process is launched from the bundled layout end to end.
      'dev-runtime-sidecar': {
        argv: [bunPath, sidecarPath, '--data-dir', dataDir],
        env: { ADEA_SIDECAR_VERSION: sidecarVersion, ADEA_SIDECAR_IDENTITY: sidecarIdentity },
      },
      // Resolution-only: the launcher is never started by the headless lane.
    }),
  }
}

/** The strict decoded manifest of the packaged components alone. */
export function buildPackagedManifest(appBundle: string): {
  manifest: ComponentManifest
  identity: PackagedIdentity
  commands: (dataDir: string) => Record<string, ComponentCommand>
} {
  const resolved = resolvePackagedComponents(appBundle)
  const decoded = decodeComponentManifest({ schemaVersion: 1, components: resolved.specs })
  if (!decoded.ok) throw new Error(`packaged manifest rejected: ${decoded.reason}`)
  return { manifest: decoded.manifest, identity: resolved.identity, commands: resolved.commands }
}
