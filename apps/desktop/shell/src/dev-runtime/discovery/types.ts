// M10 #30: shared discovery read-model contracts.
//
// These are the M10-internal shapes between a discovery source (a driver that
// observes installations) and the RuntimeConnection inventory (the typed
// aggregation that normalizes, dedupes, persists, and projects them). The
// wire-facing projections — `HarnessInstallation` and
// `RuntimeConnectionInventoryEntry` — mirror the exact DTOs in
// `packages/types/src/dev-runtime.ts`; the desktop shell is a standalone
// bundle, so the union values are mirrored here and the channel layer maps
// them into `DevError` replies verbatim.

import type { DevScope } from '../authority'

export type { DevScope }

export type HarnessProtocol = 'native' | 'acp' | 'pty'
export type HarnessAuthState = 'ready' | 'required' | 'expired' | 'unknown'
export type HarnessHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
export type HarnessAcpAvailability = 'available' | 'adapter_required' | 'unavailable'
export type RuntimeConnectionTransport = 'direct_local' | 'remote_gateway'
export type RuntimeConnectionProvenance = 'user_managed' | 'managed'

export type HarnessModelRef = Readonly<{
  id: string
  displayName: string
  capabilities: readonly string[]
}>

// Classified diagnostics. Codes are closed strings; messages carry class
// information only — never host paths, environment contents, or process output.
export type DiscoveryDiagnosticCode =
  | 'not_installed'
  | 'version_probe_failed'
  | 'version_probe_timeout'
  | 'version_probe_overflow'
  | 'incompatible_version'
  | 'permission_denied'
  | 'identity_mismatch'
  | 'limit_exceeded'

export type DiscoveryDiagnostic = Readonly<{
  family: string
  code: DiscoveryDiagnosticCode
  message: string
  observedAt: string
}>

// One installation candidate as a source observed it. A candidate has no
// identity yet: the inventory mints the stable installation ID, generation,
// and eligibility projection. `compatibility` is the source's own verdict
// that the observed version is inside its supported range; the inventory
// projects it into the `incompatible` eligibility blocker.
export type HarnessCandidate = Readonly<{
  family: string
  displayName: string
  provenance: RuntimeConnectionProvenance
  executableIdentity: string
  executableLabel: string
  protocol: HarnessProtocol
  acpAvailability: HarnessAcpAvailability
  acpVersion?: string
  version?: string
  auth: HarnessAuthState
  health: HarnessHealth
  compatibility?: 'compatible' | 'incompatible'
  capabilities: readonly string[]
  sessionOperations: readonly string[]
  entitlementHints: readonly string[]
  limitations: readonly string[]
  models: readonly HarnessModelRef[]
}>

export type HarnessSourceReport = Readonly<{
  connections: readonly HarnessCandidate[]
  diagnostics: readonly DiscoveryDiagnostic[]
}>

// A discovery source is one driver's observation pass. The managed Pi driver
// (M10 #31) and the ACP driver (M10 #32) plug in here; the built-in local
// source covers user-managed executable detection.
export type HarnessDiscoverySource = Readonly<{
  driverId: string
  driverVersion: string
  transport: RuntimeConnectionTransport
  discover(request: { scope: DevScope; now: string }): Promise<HarnessSourceReport>
}>
