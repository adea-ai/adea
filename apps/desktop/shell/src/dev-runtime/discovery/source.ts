// M10 #30: the built-in local executable discovery source.
//
// One observation pass over the supported family registry: resolve each
// family's executable (filesystem probe, never a spawn), run the bounded
// version probe, classify native auth from existence-only markers, and emit
// candidates plus classified diagnostics. Every family gets an outcome —
// missing installs become `not_installed` diagnostics instead of silence, so
// partial and empty devices are reported truthfully.
//
// Observing never mutates: this source reads nothing inside auth markers and
// writes nothing outside the caller's own stores.
import { realpathSync, statSync } from 'node:fs'

import type { HarnessFamilySpec } from './families'
import {
  compareVersions,
  resolveExecutable,
  spawnVersionProbe,
  type DiscoveryEnv,
  type PathProbe,
  type VersionProbe,
} from './probe'
import type {
  DiscoveryDiagnostic,
  HarnessCandidate,
  HarnessDiscoverySource,
  HarnessSourceReport,
} from './types'

export type LocalDiscoverySourceOptions = {
  specs?: readonly HarnessFamilySpec[]
  env?: DiscoveryEnv
  probe?: PathProbe
  versionProbe?: VersionProbe
  driverVersion?: string
}

export const LOCAL_EXECUTABLE_DRIVER_ID = 'local-executable'
export const LOCAL_EXECUTABLE_DRIVER_VERSION = '1'

type AuthClassification =
  | { state: 'ready' | 'required' | 'unknown'; permissionDenied?: false }
  | { state: 'unknown'; permissionDenied: true }

function defaultPathProbe(): PathProbe {
  return {
    isRegularFile: (path) => {
      try {
        return statSync(path).isFile()
      } catch (error) {
        // Permission loss is truthfully classified by callers; everything
        // else (missing, not-a-directory) simply reads as absent.
        if ((error as NodeJS.ErrnoException).code === 'EACCES') throw error
        return false
      }
    },
    realPath: (path) => {
      try {
        return realpathSync(path)
      } catch {
        return null
      }
    },
  }
}

export function createLocalExecutableDiscoverySource(
  options: LocalDiscoverySourceOptions = {}
): HarnessDiscoverySource {
  const specs = options.specs ?? []
  const env = options.env ?? {}
  const probe = options.probe ?? defaultPathProbe()
  const versionProbe = options.versionProbe ?? spawnVersionProbe
  const driverVersion = options.driverVersion ?? LOCAL_EXECUTABLE_DRIVER_VERSION

  async function discover(request: { now: string }): Promise<HarnessSourceReport> {
    const candidates: HarnessCandidate[] = []
    const diagnostics: DiscoveryDiagnostic[] = []

    for (const spec of specs) {
      const resolved = resolveExecutable({ spec, env, probe })
      if (!resolved.found) {
        diagnostics.push({
          family: spec.family,
          code: 'not_installed',
          message: `no ${spec.displayName} executable found in PATH or known locations`,
          observedAt: request.now,
        })
        continue
      }

      const probeResult = await versionProbe(resolved.identity, spec.versionArgv)
      if (!probeResult.ok) {
        diagnostics.push({
          family: spec.family,
          code: probeResult.code,
          message: `${spec.displayName} version probe did not complete (${probeResult.code})`,
          observedAt: request.now,
        })
        // An unprobed install is still reported, never silently dropped:
        // truthfully degraded when the probe failed mechanically, unhealthy
        // when the probe was refused outright.
        candidates.push({
          family: spec.family,
          displayName: spec.displayName,
          provenance: 'user_managed',
          executableIdentity: resolved.identity,
          executableLabel: resolved.label,
          protocol: spec.protocol,
          acpAvailability: 'unavailable',
          auth: 'unknown',
          health: probeResult.code === 'permission_denied' ? 'unhealthy' : 'degraded',
          capabilities: spec.capabilities,
          sessionOperations: spec.sessionOperations,
          entitlementHints: spec.entitlementHints,
          limitations: spec.limitations,
          models: [],
        })
        continue
      }

      const belowMinimum =
        spec.minimumVersion !== undefined &&
        compareVersions(probeResult.version, spec.minimumVersion) < 0
      if (belowMinimum) {
        diagnostics.push({
          family: spec.family,
          code: 'incompatible_version',
          message: `${spec.displayName} ${probeResult.version} is older than the supported minimum`,
          observedAt: request.now,
        })
      }

      const auth = classifyAuth(spec, env, probe)
      if (auth.permissionDenied) {
        diagnostics.push({
          family: spec.family,
          code: 'permission_denied',
          message: `${spec.displayName} auth markers are not readable by this process`,
          observedAt: request.now,
        })
      }
      candidates.push({
        family: spec.family,
        displayName: spec.displayName,
        provenance: 'user_managed',
        executableIdentity: resolved.identity,
        executableLabel: resolved.label,
        protocol: spec.protocol,
        acpAvailability: 'unavailable',
        version: probeResult.version,
        auth: auth.state,
        health: 'healthy',
        compatibility: belowMinimum ? 'incompatible' : 'compatible',
        capabilities: spec.capabilities,
        sessionOperations: spec.sessionOperations,
        entitlementHints: spec.entitlementHints,
        limitations: spec.limitations,
        models: [],
      })
    }

    return { connections: candidates, diagnostics }
  }

  return {
    driverId: LOCAL_EXECUTABLE_DRIVER_ID,
    driverVersion,
    transport: 'direct_local',
    discover: ({ now }) => discover({ now }),
  }
}

/**
 * Existence-only auth classification; marker contents are never read. Every
 * marker present classifies `ready`, none present `required`, a mixed or
 * unreadable state `unknown`.
 */
function classifyAuth(
  spec: HarnessFamilySpec,
  env: DiscoveryEnv,
  probe: PathProbe
): AuthClassification {
  if (spec.authMarkers.length === 0) return { state: 'unknown' }
  const home = env.HOME
  if (!home) return { state: 'unknown' }
  let sawAny = false
  let sawMissing = false
  for (const marker of spec.authMarkers) {
    let present: boolean
    try {
      present = probe.isRegularFile(`${home}/${marker}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EACCES')
        return { state: 'unknown', permissionDenied: true }
      present = false
    }
    if (present) sawAny = true
    else sawMissing = true
  }
  if (sawAny && !sawMissing) return { state: 'ready' }
  if (!sawAny) return { state: 'required' }
  return { state: 'unknown' }
}
