// M10 #30: local harness discovery and the RuntimeConnection inventory.
//
// This module is the sole discovery authority for Dev View: it observes local
// harness installations and projects the normalized read model that #398
// (sidebar) and #400 (harness launch) consume. Dev View renders these
// snapshots and never re-probes. Discovery never installs, rewrites, or
// migrates native configuration, and never reads credential material.
//
// Registration into the authenticated command channel stays with the M10
// channel layer; this module exposes no command handlers.
export {
  harnessFamilySpec,
  harnessFamilySpecs,
  type HarnessFamilyId,
  type HarnessFamilySpec,
} from './families'
export {
  compareVersions,
  nodeVersionManagerBins,
  parseVersionOutput,
  resolveExecutable,
  spawnVersionProbe,
  VERSION_PROBE_MAX_BYTES,
  VERSION_PROBE_TIMEOUT_MS,
  VERSION_RECORD_MAX_BYTES,
  type DiscoveryEnv,
  type PathProbe,
  type ResolvedExecutable,
  type VersionProbe,
  type VersionProbeResult,
} from './probe'
export {
  createLocalExecutableDiscoverySource,
  LOCAL_EXECUTABLE_DRIVER_ID,
  LOCAL_EXECUTABLE_DRIVER_VERSION,
  type LocalDiscoverySourceOptions,
} from './source'
export {
  createRuntimeConnectionInventory,
  harnessInstallationOf,
  type InventoryOptions,
  type RuntimeConnectionBlocker,
  type RuntimeConnectionEligibility,
  type RuntimeConnectionEntry,
  type RuntimeConnectionInventory,
  type RuntimeConnectionSnapshot,
  type StoredConnection,
  type StoredHarnessModel,
} from './inventory'
export type {
  DevScope,
  DiscoveryDiagnostic,
  DiscoveryDiagnosticCode,
  HarnessAcpAvailability,
  HarnessAuthState,
  HarnessCandidate,
  HarnessDiscoverySource,
  HarnessHealth,
  HarnessModelRef,
  HarnessProtocol,
  HarnessSourceReport,
  RuntimeConnectionProvenance,
  RuntimeConnectionTransport,
} from './types'
