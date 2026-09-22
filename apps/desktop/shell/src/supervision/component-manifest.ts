// The bundled component manifest for the supervised local stack (M10 #185).
// One install/management unit (owner decision 2026-09-16): this manifest
// records, for every bundled component, the exact product version,
// platform/architecture, artifact digest and signature, compatibility window,
// install and data locations, startup order, health probe, and rollback
// target. Incompatible component combinations must fail before execution with
// actionable remediation, and rollback never touches component data
// locations. The supervision engine that consumes this manifest lives in
// `supervisor.ts`; the Dev Runtime sidecar registers with the same lifecycle.
//
// This module is a strict decoder plus pure planners: no filesystem, clock,
// or process access, so every decision is unit-testable (Dev Runtime spec,
// "Test contract": host unit tests with injected clocks).
import { versionLessThan } from '../updates'

export const COMPONENT_MANIFEST_VERSION = 1

export type ComponentId = string

export type HealthProbeKind = 'process' | 'endpoint'

export type ComponentHealthProbe = {
  kind: HealthProbeKind
  /** Probe cadence in milliseconds (supervision default: 15 seconds). */
  intervalMs: number
  /** No successful observation for this long marks the component unhealthy. */
  unhealthyAfterMs: number
}

export type ComponentProtocol = {
  name: string
  major: number
  minor: number
}

/**
 * Where a component's artifact lives and who resolves the install label:
 * - `bundled` — the label is bundle-relative; the packaging lane resolves it
 *   against the running `.app` (containment + existence + digest) before the
 *   manifest is composed, and a failed resolution fails the boot: the manifest
 *   never describes an artifact the bundle does not contain.
 * - `managed-data-dir` — the label is data-dir-relative under the owner-only
 *   data root; the artifact is installed at runtime by its owning lifecycle
 *   (the managed Pi driver) and may truthfully be ABSENT at boot. Absence is
 *   a typed resolution state, never a boot failure and never fabricated as
 *   present; the manifest carries the build-time pin (version + digest) the
 *   owning lifecycle installs.
 */
export type ComponentInstallKind = 'bundled' | 'managed-data-dir'

export type ComponentSpec = {
  /** Opaque stable identity; never a path, PID, port, or product name. */
  id: ComponentId
  product: string
  version: string
  platform: 'darwin' | 'linux' | 'win32' | 'universal'
  arch: 'arm64' | 'x64' | 'universal'
  /** SHA-256 of the packaged artifact; surfaced for diagnostics. */
  digestSha256: string
  /** Detached signature over the artifact digest (release-lane key). */
  signature: string
  /** Inclusive app-version window this component build supports. */
  compatibility: { minAppVersion: string; maxAppVersion: string }
  /**
   * Install label. For `bundled` components it is bundle-relative; for
   * `managed-data-dir` components it is data-dir-relative under the owner-only
   * data root. Interpretation is fixed by `installKind`.
   */
  installLocation: string
  /** How `installLocation` resolves (see ComponentInstallKind). Decoded
   *  manifests always carry the field; an absent key decodes as `bundled`. */
  installKind: ComponentInstallKind
  /** User-data-relative label; never deleted by rollback or upgrade. */
  dataLocation: string
  /** Lower phases start first; dependencies refine the order further. */
  startupPhase: number
  dependsOn: ComponentId[]
  healthProbe: ComponentHealthProbe
  /** Registration contract (e.g. the Dev Runtime sidecar handshake); null when the component has none. */
  protocol: ComponentProtocol | null
  /** Explicit prior version to roll back to; null refuses implicit rollback. */
  rollbackTargetVersion: string | null
  /** Optional components (e.g. Cortana) never gate baseline readiness. */
  required: boolean
}

export type ComponentManifest = {
  schemaVersion: typeof COMPONENT_MANIFEST_VERSION
  components: ComponentSpec[]
}

export type ManifestDecodeResult =
  | { ok: true; manifest: ComponentManifest }
  | { ok: false; reason: 'unsupported_version' | 'corrupt_state' }

const PLATFORMS = ['darwin', 'linux', 'win32', 'universal'] as const
const ARCHES = ['arm64', 'x64', 'universal'] as const
const PROBE_KINDS = ['process', 'endpoint'] as const
const INSTALL_KINDS = ['bundled', 'managed-data-dir'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function decodeHealthProbe(value: unknown): ComponentHealthProbe | null {
  if (!isRecord(value)) return null
  if (!PROBE_KINDS.includes(value.kind as HealthProbeKind)) return null
  if (!isInteger(value.intervalMs) || value.intervalMs <= 0) return null
  if (!isInteger(value.unhealthyAfterMs) || value.unhealthyAfterMs < value.intervalMs) return null
  return {
    kind: value.kind as HealthProbeKind,
    intervalMs: value.intervalMs,
    unhealthyAfterMs: value.unhealthyAfterMs,
  }
}

function decodeProtocol(value: unknown): ComponentProtocol | null {
  if (value === null) return null
  if (!isRecord(value)) return null
  if (!isNonEmptyString(value.name)) return null
  if (!isInteger(value.major) || value.major < 1) return null
  if (!isInteger(value.minor) || value.minor < 0) return null
  return { name: value.name, major: value.major, minor: value.minor }
}

/** Additive field: an absent key decodes as `bundled` (the only kind before
 *  the field existed); a present key must be a known literal. */
function decodeInstallKind(value: unknown): ComponentInstallKind | null {
  if (value === undefined) return 'bundled'
  if (typeof value === 'string' && (INSTALL_KINDS as readonly string[]).includes(value)) {
    return value as ComponentInstallKind
  }
  return null
}

function decodeComponent(value: unknown): ComponentSpec | null {
  if (!isRecord(value)) return null
  if (!isNonEmptyString(value.id)) return null
  if (!isNonEmptyString(value.product)) return null
  if (!isNonEmptyString(value.version)) return null
  if (!PLATFORMS.includes(value.platform as 'darwin')) return null
  if (!ARCHES.includes(value.arch as 'arm64')) return null
  if (!isDigest(value.digestSha256)) return null
  if (!isNonEmptyString(value.signature)) return null
  const compatibility = value.compatibility
  if (
    !isRecord(compatibility) ||
    !isNonEmptyString(compatibility.minAppVersion) ||
    !isNonEmptyString(compatibility.maxAppVersion)
  ) {
    return null
  }
  if (!isNonEmptyString(value.installLocation)) return null
  const installKind = decodeInstallKind(value.installKind)
  if (!installKind) return null
  if (!isNonEmptyString(value.dataLocation)) return null
  if (!isInteger(value.startupPhase) || value.startupPhase < 0) return null
  if (!Array.isArray(value.dependsOn) || value.dependsOn.some((id) => !isNonEmptyString(id)))
    return null
  const healthProbe = decodeHealthProbe(value.healthProbe)
  if (!healthProbe) return null
  const protocol = decodeProtocol(value.protocol)
  if (value.protocol !== null && !protocol) return null
  if (value.rollbackTargetVersion !== null && !isNonEmptyString(value.rollbackTargetVersion)) {
    return null
  }
  if (typeof value.required !== 'boolean') return null
  return {
    id: value.id,
    product: value.product,
    version: value.version,
    platform: value.platform as ComponentSpec['platform'],
    arch: value.arch as ComponentSpec['arch'],
    digestSha256: value.digestSha256,
    signature: value.signature,
    compatibility: {
      minAppVersion: compatibility.minAppVersion,
      maxAppVersion: compatibility.maxAppVersion,
    },
    installLocation: value.installLocation,
    installKind,
    dataLocation: value.dataLocation,
    startupPhase: value.startupPhase,
    dependsOn: [...value.dependsOn],
    healthProbe,
    protocol,
    rollbackTargetVersion: value.rollbackTargetVersion,
    required: value.required,
  }
}

/**
 * Strict version-1 decoder. Unknown schema versions are `unsupported_version`;
 * structurally invalid manifests are `corrupt_state`. Unknown extra keys are
 * tolerated so additive manifest fields stay forward-compatible; every known
 * field must still decode.
 */
export function decodeComponentManifest(raw: unknown): ManifestDecodeResult {
  if (!isRecord(raw)) return { ok: false, reason: 'corrupt_state' }
  if (raw.schemaVersion !== COMPONENT_MANIFEST_VERSION) {
    return { ok: false, reason: 'unsupported_version' }
  }
  if (!Array.isArray(raw.components)) return { ok: false, reason: 'corrupt_state' }
  const components: ComponentSpec[] = []
  const seen = new Set<string>()
  for (const entry of raw.components) {
    const component = decodeComponent(entry)
    if (!component) return { ok: false, reason: 'corrupt_state' }
    if (seen.has(component.id)) return { ok: false, reason: 'corrupt_state' }
    seen.add(component.id)
    if (component.dependsOn.includes(component.id)) return { ok: false, reason: 'corrupt_state' }
    components.push(component)
  }
  for (const component of components) {
    for (const dependency of component.dependsOn) {
      if (!seen.has(dependency)) return { ok: false, reason: 'corrupt_state' }
    }
  }
  return { ok: true, manifest: { schemaVersion: COMPONENT_MANIFEST_VERSION, components } }
}

export type HostIdentity = { platform: string; arch: string; appVersion: string }

export type IncompatibilityReason = 'platform' | 'arch' | 'version_window'

export type CompatibilityResult = {
  compatible: ComponentSpec[]
  incompatible: Array<{ component: ComponentSpec; reason: IncompatibilityReason }>
}

/**
 * Per-component compatibility against this host. Incompatible combinations
 * must fail before execution with an actionable reason; the caller renders
 * the remediation (required platform/arch or the supported app window).
 */
export function evaluateCompatibility(
  manifest: ComponentManifest,
  host: HostIdentity
): CompatibilityResult {
  const compatible: ComponentSpec[] = []
  const incompatible: CompatibilityResult['incompatible'] = []
  for (const component of manifest.components) {
    if (component.platform !== 'universal' && component.platform !== host.platform) {
      incompatible.push({ component, reason: 'platform' })
      continue
    }
    if (component.arch !== 'universal' && component.arch !== host.arch) {
      incompatible.push({ component, reason: 'arch' })
      continue
    }
    const withinWindow =
      !versionLessThan(host.appVersion, component.compatibility.minAppVersion) &&
      !versionLessThan(component.compatibility.maxAppVersion, host.appVersion)
    if (!withinWindow) {
      incompatible.push({ component, reason: 'version_window' })
      continue
    }
    compatible.push(component)
  }
  return { compatible, incompatible }
}

/** Components the baseline requires; optional components never gate it. */
export function requiredComponents(manifest: ComponentManifest): ComponentSpec[] {
  return manifest.components.filter((component) => component.required)
}

export type StartupPlan =
  | {
      ok: true
      /** Phases in start order; within a phase, manifest order. */ phases: ComponentId[][]
    }
  | { ok: false; reason: 'invalid_state' }

/**
 * Dependency-aware startup order. Two hard gates: dependencies must be
 * admitted first, and nothing starts while any component with a lower
 * declared `startupPhase` is unplaced — the manifest's startup order is a
 * sequence, not a hint. A dependency cycle is `invalid_state` — the
 * supervisor refuses to boot into a deadlock.
 */
export function startupPlan(manifest: ComponentManifest): StartupPlan {
  const remaining = new Map<ComponentId, Set<ComponentId>>(
    manifest.components.map((c) => [c.id, new Set(c.dependsOn.filter((d) => d !== c.id))])
  )
  const phases: ComponentId[][] = []
  while (remaining.size > 0) {
    const eligible = [...remaining.entries()].filter(([, deps]) => deps.size === 0)
    if (eligible.length === 0) return { ok: false, reason: 'invalid_state' }
    const minPhase = Math.min(
      ...eligible.map(([id]) => manifest.components.find((c) => c.id === id)?.startupPhase ?? 0)
    )
    const phase: ComponentId[] = manifest.components
      .filter(
        (c) => remaining.has(c.id) && c.startupPhase === minPhase && remaining.get(c.id)?.size === 0
      )
      .map((c) => c.id)
    if (phase.length === 0) return { ok: false, reason: 'invalid_state' }
    phases.push(phase)
    for (const id of phase) remaining.delete(id)
    for (const deps of remaining.values()) {
      for (const id of phase) deps.delete(id)
    }
  }
  return { ok: true, phases }
}

export type RollbackPlan =
  | {
      ok: true
      componentId: ComponentId
      fromVersion: string
      toVersion: string
      /** Preserved untouched: rollback replaces binaries, never component data. */
      dataLocation: string
    }
  | { ok: false; reason: 'not_found' | 'no_rollback_target' }

/** Resolve the explicit rollback target; absence refuses implicit rollback. */
export function resolveRollbackTarget(
  manifest: ComponentManifest,
  componentId: ComponentId
): RollbackPlan {
  const component = manifest.components.find((c) => c.id === componentId)
  if (!component) return { ok: false, reason: 'not_found' }
  if (!component.rollbackTargetVersion) return { ok: false, reason: 'no_rollback_target' }
  return {
    ok: true,
    componentId,
    fromVersion: component.version,
    toVersion: component.rollbackTargetVersion,
    dataLocation: component.dataLocation,
  }
}
