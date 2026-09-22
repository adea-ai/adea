// Packaging lane: install-location resolution for the bundled component
// manifest (M10 #185, Dev Runtime spec "Local stack supervision").
//
// The manifest's `installLocation` is resolved per the component's
// `installKind`: a `bundled` label is bundle-relative and this module resolves
// it against the Electrobun-built .app, proving containment + existence +
// artifact digest before anything is launched (a failed resolution fails the
// manifest — the manifest never describes an artifact the bundle does not
// contain). A `managed-data-dir` label is data-dir-relative under the
// owner-only data root: the artifact is installed at runtime by its owning
// lifecycle (the managed Pi driver) and may truthfully be ABSENT — absence is
// a typed resolution state, never a failure and never fabricated as present.
//
// It replaces the supervision smoke's dev-mode stand-ins when the lane runs
// packaged: the supervised sidecar command is resolved from the bundled
// layout and executed by the bundled Bun runtime (`Contents/MacOS/bun`, the
// repository-pinned Bun line), never by the smoke's own toolchain.
//
// Pure resolution over the real bundle and data dir: no side effects beyond
// reading files.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import {
  decodeComponentManifest,
  type ComponentManifest,
  type ComponentSpec,
} from '../src/supervision/component-manifest'
import type { ComponentCommand } from '../src/supervision/process-adapter'
import {
  MANAGED_PI_PINNED_ARCHIVE_SHA256,
  MANAGED_PI_PINNED_VERSION,
} from '../src/dev-runtime/harness/managed-pi-driver'

/** Bundle-relative label of the packaged terminal sidecar entry, staged by
 *  the packaging lane (apps/desktop/scripts/shell.mjs + electrobun copy). */
export const SIDECAR_INSTALL_LABEL = 'Contents/Resources/app/dev-runtime-sidecar/entry.js'
/** Bundle-relative label of the bundled Bun runtime (the sidecar's executor). */
export const BUN_INSTALL_LABEL = 'Contents/MacOS/bun'
/** Bundle-relative label of the packaged app launcher binary. */
export const LAUNCHER_INSTALL_LABEL = 'Contents/MacOS/launcher'

/** The managed Pi's manifest component id (#185 follow-up). It mirrors the
 *  driver's own identity (`MANAGED_PI_DRIVER_ID`) so the supervision surface
 *  and the install lifecycle name the same thing. */
export const MANAGED_PI_COMPONENT_ID = 'managed-pi'
/** Data-dir-relative install label of the managed Pi executable. Derived
 *  from the driver's default install root
 *  (`<dataDir>/dev-runtime/harness/managed-pi/<pinned version>/pi`); if the
 *  driver's install root is ever overridden, this label moves with it. */
export const MANAGED_PI_INSTALL_LABEL = `dev-runtime/harness/managed-pi/${MANAGED_PI_PINNED_VERSION}/pi`

export type InstallResolution =
  | { ok: true; label: string; absolutePath: string; bytes: number; digestSha256: string }
  | { ok: false; label: string; reason: string }

function sha256File(path: string): string {
  const hasher = createHash('sha256')
  hasher.update(readFileSync(path))
  return hasher.digest('hex')
}

/** Containment-only resolve of a label against a root: the label must be
 *  non-empty and relative, and must resolve strictly inside the root. Shared
 *  by the bundle-relative and the data-dir-relative resolutions. */
function containedResolve(
  root: string,
  label: string
): { ok: true; absolutePath: string } | { ok: false; reason: string } {
  const rootPath = resolve(root)
  if (label.length === 0) return { ok: false, reason: 'empty install label' }
  if (label.startsWith('/') || label.startsWith('\\')) {
    return { ok: false, reason: 'install label must be root-relative' }
  }
  const absolute = resolve(rootPath, label)
  if (absolute !== rootPath && !absolute.startsWith(rootPath + sep)) {
    return { ok: false, reason: 'resolved path escapes the root' }
  }
  return { ok: true, absolutePath: absolute }
}

/** Resolves one bundle-relative install label to an absolute path inside
 *  `appBundle`. Absolute labels, `..` escapes, and anything that resolves
 *  outside the bundle are refused — an install location can never point at
 *  host state outside the packaged layout. */
export function resolveInstallLocation(appBundle: string, label: string): InstallResolution {
  const contained = containedResolve(appBundle, label)
  if (!contained.ok) return { ok: false, label, reason: contained.reason }
  const { absolutePath: absolute } = contained
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

/**
 * Truthful-absence resolution for a data-dir-relative component label (#185
 * follow-up). Same containment treatment as `resolveInstallLocation` (the
 * label must resolve strictly inside the root), but absence is TYPED, not a
 * failure: a `managed-data-dir` component's artifact is installed at runtime
 * by its owning lifecycle and is legitimately not there before the first
 * ensure. When the artifact exists, its real digest is observed and compared
 * with `expectedDigest` (the manifest's pin) — a mismatch is surfaced
 * truthfully (`digestMatchesPin: false`: install drift the owning lifecycle
 * heals), never silently accepted and never fatal here.
 */
export type DataDirInstallResolution =
  | {
      ok: true
      absent: false
      label: string
      absolutePath: string
      bytes: number
      digestSha256: string
      digestMatchesPin: boolean
    }
  | {
      ok: true
      absent: true
      label: string
      absolutePath: string
      /** Why the artifact is absent — installing it is the owner's job. */
      reason: string
    }
  | { ok: false; label: string; reason: string }

export function resolveDataDirInstall(
  dataDir: string,
  label: string,
  options?: { expectedDigest?: string }
): DataDirInstallResolution {
  const contained = containedResolve(dataDir, label)
  if (!contained.ok) return { ok: false, label, reason: contained.reason }
  const { absolutePath: absolute } = contained
  if (!existsSync(absolute)) {
    return {
      ok: true,
      absent: true,
      label,
      absolutePath: absolute,
      reason: 'not installed yet (the owning lifecycle installs it on first ensure)',
    }
  }
  let stats
  try {
    stats = statSync(absolute)
  } catch {
    return { ok: false, label, reason: `data-dir artifact ${label} is not observable` }
  }
  if (!stats.isFile()) {
    return { ok: false, label, reason: `data-dir artifact ${label} is not a regular file` }
  }
  const digestSha256 = sha256File(absolute)
  return {
    ok: true,
    absent: false,
    label,
    absolutePath: absolute,
    bytes: stats.size,
    digestSha256,
    digestMatchesPin:
      options?.expectedDigest === undefined || digestSha256 === options.expectedDigest,
  }
}

/** The managed Pi component's data-dir resolution against the shell's data
 *  root, with the driver's pinned digest as the expected one. */
export function resolveManagedPiInstall(dataDir: string): DataDirInstallResolution {
  return resolveDataDirInstall(dataDir, MANAGED_PI_INSTALL_LABEL, {
    expectedDigest: MANAGED_PI_PINNED_ARCHIVE_SHA256,
  })
}

/** Finds the Electrobun-built .app under the shell build directory, or null
 *  when the packaged lane has not built yet (same search the lane wrapper
 *  uses for its summary). */
export function findAppBundle(buildRoot: string, depth = 0): string | null {
  if (depth > 6) return null
  // The packaged lane targets the DEV channel build; a stable-channel
  // Adea.app must never be picked by accident.
  const preferred = join(buildRoot, 'dev-macos-arm64', 'Adea-dev.app')
  if (existsSync(preferred)) return preferred
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

/** The managed Pi manifest component from the driver's build-time pin (#185
 *  follow-up). Shared by the packaged manifest and the smoke's dev fallback
 *  manifest so both describe the same component. */
export function managedPiComponentSpec(): ComponentSpec {
  return {
    id: MANAGED_PI_COMPONENT_ID,
    product: 'Managed Pi runtime (driver-installed at the pinned version)',
    version: MANAGED_PI_PINNED_VERSION,
    platform: 'darwin',
    arch: 'arm64',
    // The driver's build-time pinned archive digest: the installed
    // executable is the digest-verified archive bytes written verbatim, so
    // the manifest's pin and the on-disk artifact are comparable.
    digestSha256: MANAGED_PI_PINNED_ARCHIVE_SHA256,
    signature: 'c2ln',
    compatibility: { minAppVersion: '0.1.0', maxAppVersion: '99.0.0' },
    installLocation: MANAGED_PI_INSTALL_LABEL,
    installKind: 'managed-data-dir',
    dataLocation: 'dev-runtime/harness/managed-pi',
    startupPhase: 1,
    dependsOn: [],
    healthProbe: { kind: 'process', intervalMs: 15_000, unhealthyAfterMs: 45_000 },
    // The managed Pi registers with no adoption protocol: the driver owns
    // install and the launch path, so there is nothing for the engine's
    // sidecar handshake to adopt. Null is the truthful declaration.
    protocol: null,
    rollbackTargetVersion: null,
    // Installed lazily by the driver's boot warm; never gates readiness.
    required: false,
  }
}

/**
 * Resolves the REAL packaged components: every `bundled` component's install
 * label is resolved through `resolveInstallLocation`, the artifact digest is
 * the actual SHA-256 of the bundled bytes, and a label that fails resolution
 * fails the build — the manifest never describes an artifact the bundle does
 * not contain. A `managed-data-dir` component is registered from its
 * build-time pin and is NOT resolved here (its artifact lives under the data
 * root, installed by its owning lifecycle; see `resolveManagedPiInstall`).
 *
 * Components:
 * - `dev-runtime-sidecar`: the packaged sidecar entry, executed by the
 *   bundled Bun runtime. This is the component the supervision smoke starts.
 * - `app-shell`: the Electrobun launcher binary. Resolved and digested only —
 *   starting a GUI app binary is not part of the headless evidence lane, so
 *   it stays an optional, never-started component (optional components never
 *   gate baseline readiness).
 * - `managed-pi`: the driver-installed managed Pi runtime (#185 follow-up).
 *   The manifest carries the driver's build-time pin (version + archive
 *   digest); the driver keeps install ownership (the engine observes/starts
 *   per policy, it never installs), the install location resolves with
 *   truthful-absence semantics against the data root, and the health probe
 *   is the process probe over the engine's own launch of the installed
 *   executable. Before the first successful ensure the component is
 *   truthfully absent and a start fails typed (`spawn_failed`) — the engine
 *   holds and reports it exactly like the sidecar, never fabricates state.
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
      installKind: 'bundled',
      dataLocation: 'dev-runtime/terminal-sidecar',
      startupPhase: 0,
      dependsOn: [],
      healthProbe: { kind: 'process', intervalMs: 15_000, unhealthyAfterMs: 45_000 },
      // The registration protocol the sidecar actually speaks (the wire
      // constant `SIDECAR_PROTOCOL`): the supervision engine's adoption
      // verdict compares name and major against it.
      protocol: { name: 'adea-terminal-sidecar', major: 1, minor: 0 },
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
      installKind: 'bundled',
      dataLocation: 'app-shell',
      startupPhase: 0,
      dependsOn: [],
      healthProbe: { kind: 'process', intervalMs: 15_000, unhealthyAfterMs: 45_000 },
      protocol: null,
      rollbackTargetVersion: null,
      required: false,
    },
    managedPiComponentSpec(),
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
      // The managed Pi's argv is the data-dir install label's absolute path:
      // the engine's spawn observes the driver's install result (typed
      // `spawn_failed` before the first ensure) — install stays the driver's.
      [MANAGED_PI_COMPONENT_ID]: {
        argv: [join(dataDir, MANAGED_PI_INSTALL_LABEL)],
      },
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

/** What the production shell entry loads at boot: the running bundle (when
 *  the entry is packaged) and its strictly decoded component manifest, or the
 *  typed reason the manifest is absent. An absent manifest is not an error —
 *  it is the shell's truthful no-supervision state. */
export type RunningManifestLoad =
  | { ok: true; appBundle: string; manifest: ComponentManifest }
  | { ok: false; appBundle: string | null; reason: string }

/** Locates the .app bundle the running shell itself was launched from, given
 *  the bundled main process's directory. In the packaged layout the entry
 *  lives at `Contents/Resources/app`, so the bundle root is three levels up;
 *  the candidate counts only when it is a `.app` carrying the bundled Bun
 *  runtime (`Contents/MacOS/bun`). A repo dev run (and any test) resolves
 *  null — never a mistaken bundle. */
export function findRunningAppBundle(entryDir: string): string | null {
  const bundleRoot = resolve(entryDir, '..', '..', '..')
  if (!bundleRoot.endsWith('.app')) return null
  if (!existsSync(join(bundleRoot, BUN_INSTALL_LABEL))) return null
  return bundleRoot
}

/**
 * The production shell entry's manifest load (the #185 one-supervisor wiring):
 * locates the running bundle with `findRunningAppBundle` and resolves its
 * packaged component manifest through `buildPackagedManifest`'s strict
 * install-location resolution and decode. Not running packaged, or a bundle
 * whose resolution or decode fails, returns `ok: false` with the reason — the
 * caller then boots the truthful no-supervision composition. It never throws
 * and never fabricates a manifest.
 */
export function loadPackagedManifestForEntry(entryDir: string): RunningManifestLoad {
  const appBundle = findRunningAppBundle(entryDir)
  if (!appBundle) {
    return {
      ok: false,
      appBundle: null,
      reason: 'the shell is not running from a packaged app bundle',
    }
  }
  try {
    return { ok: true, appBundle, manifest: buildPackagedManifest(appBundle).manifest }
  } catch (error) {
    return {
      ok: false,
      appBundle,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
