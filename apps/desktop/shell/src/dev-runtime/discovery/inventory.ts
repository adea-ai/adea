// M10 #30: the RuntimeConnection inventory.
//
// The typed aggregation over discovery sources. It normalizes candidate
// reports into stable `HarnessInstallation`-shaped records (opaque stable ID,
// scope binding, generation), dedupes across sources with managed provenance
// taking precedence, persists the last observation per scope for restart
// rediscovery, and projects the RuntimeConnection read model that #398
// (sidebar) and #400 (harness launch) consume.
//
// The aggregation idea (many typed per-driver reports folding into one
// inventory with attention counts) is review-only bb `useUpdateInventory`
// influence: the React hook, its query wiring, and its static staleness are
// not ported. Freshness here is derived per read from the persisted
// observation time against a configurable stale window — never a static flag.
//
// Fail-closed rules from the Dev Runtime contract: unknown stored state is
// never coerced into success, oversized or malformed candidate metadata is
// dropped with a `limit_exceeded` diagnostic instead of truncated silently,
// and `read` never re-probes — it is a pure projection of the last persisted
// observation.
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { nowIso, sameScope, type DevScope } from '../authority'
import type { AuthorityAudit } from '../audit'
import { createDurableJsonStore } from '../host-store'
import type {
  DiscoveryDiagnostic,
  HarnessAcpAvailability,
  HarnessAuthState,
  HarnessDiscoverySource,
  HarnessHealth,
  HarnessProtocol,
  RuntimeConnectionProvenance,
  RuntimeConnectionTransport,
} from './types'

export type StoredHarnessModel = Readonly<{
  id: string
  displayName: string
  capabilities: readonly string[]
}>

export type StoredConnection = Readonly<{
  id: string
  scope: DevScope
  family: string
  displayName: string
  driverId: string
  driverVersion: string
  provenance: RuntimeConnectionProvenance
  executableIdentity: string
  executableLabel: string
  protocol: HarnessProtocol
  acpAvailability: HarnessAcpAvailability
  acpVersion?: string
  version?: string
  auth: HarnessAuthState
  health: HarnessHealth
  compatibility: 'compatible' | 'incompatible'
  capabilities: readonly string[]
  sessionOperations: readonly string[]
  entitlementHints: readonly string[]
  limitations: readonly string[]
  transport: RuntimeConnectionTransport
  models: readonly StoredHarnessModel[]
  observedAt: string
  generation: number
}>

export type RuntimeConnectionBlockerCode =
  | 'auth_required'
  | 'unavailable'
  | 'incompatible'
  | 'capability_unavailable'

export type RuntimeConnectionBlocker = Readonly<{
  code: RuntimeConnectionBlockerCode
  message: string
}>

export type RuntimeConnectionEligibility = Readonly<{
  eligible: boolean
  blockers: readonly RuntimeConnectionBlocker[]
}>

export type RuntimeConnectionEntry = Readonly<{
  id: string
  scope: DevScope
  family: string
  displayName: string
  driverId: string
  driverVersion: string
  provenance: RuntimeConnectionProvenance
  executableIdentity: string
  executableLabel: string
  protocol: HarnessProtocol
  acpAvailability: HarnessAcpAvailability
  acpVersion?: string
  version?: string
  auth: HarnessAuthState
  health: HarnessHealth
  capabilities: readonly string[]
  sessionOperations: readonly string[]
  entitlementHints: readonly string[]
  limitations: readonly string[]
  eligibility: RuntimeConnectionEligibility
  transport: RuntimeConnectionTransport
  models: readonly StoredHarnessModel[]
  observedAt: string
  generation: number
  freshness: 'fresh' | 'stale'
}>

export type RuntimeConnectionSnapshot = Readonly<{
  scope: DevScope
  connections: readonly RuntimeConnectionEntry[]
  diagnostics: readonly DiscoveryDiagnostic[]
  observedAt: string
}>

export type InventoryOptions = {
  dataDir: string
  sources: readonly HarnessDiscoverySource[]
  audit?: AuthorityAudit
  clock?: () => Date
  /** Read-time stale window for the freshness projection (default 5 minutes). */
  staleAfterMs?: number
  /** Scope policy capabilities every connection must declare to be eligible. */
  requiredCapabilitiesFor?: (scope: DevScope) => readonly string[]
}

type StoredDiagnostic = Readonly<{ scope: DevScope; diagnostic: DiscoveryDiagnostic }>

type StoredRecord =
  | Readonly<{ kind: 'connection'; entry: StoredConnection }>
  | Readonly<{ kind: 'diagnostic'; record: StoredDiagnostic }>

const STORE_SCHEMA_VERSION = 1
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000
const MAX_CONNECTIONS_PER_SOURCE = 64
const MAX_TOTAL_CONNECTIONS = 500
const MAX_DIAGNOSTICS = 256
const MAX_MODELS = 1000
const ID_NAMESPACE = 'adea-m10-30-harness-installation'

const CANDIDATE_STRING_BOUNDS = {
  family: 128,
  displayName: 128,
  executableIdentity: 4096,
  executableLabel: 256,
  version: 128,
  acpVersion: 128,
} as const

/**
 * Deterministic RFC 4122 v5-shaped installation ID over the full scope plus
 * (family, executable identity digest). Opaque and stable across
 * rediscovery: the same installation inside one account/workspace/node scope
 * keeps its ID and generation lifecycle, and the ID never embeds the path
 * itself.
 */
function stableInstallationId(scope: DevScope, family: string, digest: string): string {
  const raw = createHash('sha1')
    .update(ID_NAMESPACE)
    .update('\0')
    .update(
      `${scope.accountId}\0${scope.workspaceId}\0${scope.runtimeNodeId}\0${family}\0${digest}`
    )
    .digest()
  raw[6] = (raw[6]! & 0x0f) | 0x50
  raw[8] = (raw[8]! & 0x3f) | 0x80
  const hex = raw.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function identityDigest(executableIdentity: string): string {
  return createHash('sha256').update(executableIdentity).digest('hex')
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) return null
  return value
}

function boundedStringList(
  value: unknown,
  maxItems: number,
  maxItemLength: number
): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null
  const items: string[] = []
  for (const entry of value) {
    const item = boundedString(entry, maxItemLength)
    if (item === null) return null
    items.push(item)
  }
  return items
}

function boundedModels(value: unknown): readonly StoredHarnessModel[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_MODELS) return null
  const models: StoredHarnessModel[] = []
  for (const entry of value) {
    const item = entry as Record<string, unknown> | null
    if (!item || typeof item !== 'object') return null
    const id = boundedString(item.id, 256)
    const displayName = boundedString(item.displayName, 256)
    const capabilities = boundedStringList(item.capabilities, MAX_MODELS, 128)
    if (id === null || displayName === null || capabilities === null) return null
    models.push({ id, displayName, capabilities })
  }
  return models
}

/**
 * Validate one candidate against the spec bounds, returning the stored
 * connection facts without identity, scope, observation, or generation —
 * null when the candidate must be dropped with a `limit_exceeded`
 * diagnostic.
 */
function normalizeCandidate(
  candidate: unknown
): Omit<
  StoredConnection,
  'id' | 'scope' | 'generation' | 'driverId' | 'driverVersion' | 'transport' | 'observedAt'
> | null {
  const item = candidate as Record<string, unknown> | null
  if (!item || typeof item !== 'object') return null
  const family = boundedString(item.family, CANDIDATE_STRING_BOUNDS.family)
  const displayName = boundedString(item.displayName, CANDIDATE_STRING_BOUNDS.displayName)
  const executableIdentity = boundedString(
    item.executableIdentity,
    CANDIDATE_STRING_BOUNDS.executableIdentity
  )
  const executableLabel = boundedString(
    item.executableLabel,
    CANDIDATE_STRING_BOUNDS.executableLabel
  )
  const protocol = item.protocol
  const provenance = item.provenance
  const acpAvailability = item.acpAvailability
  const auth = item.auth
  const health = item.health
  const compatibility = item.compatibility ?? 'compatible'
  const capabilities = boundedStringList(item.capabilities, 64, 128)
  const sessionOperations = boundedStringList(item.sessionOperations, 32, 128)
  const entitlementHints = boundedStringList(item.entitlementHints, 32, 128)
  const limitations = boundedStringList(item.limitations, 32, 256)
  const models = boundedModels(item.models)
  if (
    family === null ||
    displayName === null ||
    executableIdentity === null ||
    executableLabel === null ||
    capabilities === null ||
    sessionOperations === null ||
    entitlementHints === null ||
    limitations === null ||
    models === null ||
    (protocol !== 'native' && protocol !== 'acp' && protocol !== 'pty') ||
    (provenance !== 'user_managed' && provenance !== 'managed') ||
    (acpAvailability !== 'available' &&
      acpAvailability !== 'adapter_required' &&
      acpAvailability !== 'unavailable') ||
    (auth !== 'ready' && auth !== 'required' && auth !== 'expired' && auth !== 'unknown') ||
    (health !== 'healthy' &&
      health !== 'degraded' &&
      health !== 'unhealthy' &&
      health !== 'unknown') ||
    (compatibility !== 'compatible' && compatibility !== 'incompatible')
  ) {
    return null
  }
  let version: string | undefined
  if (item.version !== undefined) {
    const parsed = boundedString(item.version, CANDIDATE_STRING_BOUNDS.version)
    if (parsed === null) return null
    version = parsed
  }
  let acpVersion: string | undefined
  if (item.acpVersion !== undefined) {
    const parsed = boundedString(item.acpVersion, CANDIDATE_STRING_BOUNDS.acpVersion)
    if (parsed === null) return null
    acpVersion = parsed
  }
  return {
    family,
    displayName,
    provenance,
    executableIdentity,
    executableLabel,
    protocol,
    acpAvailability,
    ...(acpVersion !== undefined ? { acpVersion } : {}),
    ...(version !== undefined ? { version } : {}),
    auth,
    health,
    compatibility,
    capabilities,
    sessionOperations,
    entitlementHints,
    limitations,
    models,
  }
}

export function createRuntimeConnectionInventory(options: InventoryOptions) {
  const {
    dataDir,
    sources,
    audit,
    clock = () => new Date(),
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    requiredCapabilitiesFor,
  } = options
  const store = createDurableJsonStore<StoredRecord>({
    file: join(dataDir, 'dev-runtime', 'discovery', 'inventory.json'),
    schemaVersion: STORE_SCHEMA_VERSION,
    label: 'runtime connection inventory',
  })

  function load(): { connections: StoredConnection[]; diagnostics: StoredDiagnostic[] } {
    const connections: StoredConnection[] = []
    const diagnostics: StoredDiagnostic[] = []
    for (const record of store.load().records) {
      if (record.kind === 'connection') connections.push(record.entry)
      else diagnostics.push(record.record)
    }
    return { connections, diagnostics }
  }

  function persist(
    connections: readonly StoredConnection[],
    diagnostics: readonly StoredDiagnostic[]
  ): void {
    const records: StoredRecord[] = [
      ...connections.map((entry) => ({ kind: 'connection' as const, entry })),
      ...diagnostics.map((record) => ({ kind: 'diagnostic' as const, record })),
    ]
    store.save(records)
  }

  /** Project eligibility and freshness on read; never mutates stored state. */
  function project(
    entry: StoredConnection,
    nowMs: number,
    scopePolicyCapabilities: readonly string[]
  ): RuntimeConnectionEntry {
    const blockers: RuntimeConnectionBlocker[] = []
    if (entry.auth !== 'ready') {
      blockers.push({
        code: 'auth_required',
        message:
          entry.auth === 'expired'
            ? 'harness authentication has expired; re-authentication is required'
            : entry.auth === 'required'
              ? 'harness authentication has not been completed'
              : 'harness authentication state is unverified',
      })
    }
    if (entry.health === 'unhealthy' || entry.health === 'unknown') {
      blockers.push({
        code: 'unavailable',
        message:
          entry.health === 'unhealthy'
            ? 'installation is unhealthy'
            : 'installation has never been verified',
      })
    }
    if (entry.compatibility === 'incompatible') {
      blockers.push({ code: 'incompatible', message: 'installation version is not supported' })
    }
    const missing = [...scopePolicyCapabilities].filter(
      (capability) => !entry.capabilities.includes(capability)
    )
    if (missing.length > 0) {
      blockers.push({
        code: 'capability_unavailable',
        message: `required capabilities are not declared (count: ${missing.length})`,
      })
    }
    const observedMs = Date.parse(entry.observedAt)
    const freshness: 'fresh' | 'stale' =
      Number.isFinite(observedMs) && nowMs - observedMs <= staleAfterMs ? 'fresh' : 'stale'
    if (freshness === 'stale') {
      blockers.push({
        code: 'unavailable',
        message: 'observation is stale; refresh discovery before launch',
      })
    }
    return {
      id: entry.id,
      scope: entry.scope,
      family: entry.family,
      displayName: entry.displayName,
      driverId: entry.driverId,
      driverVersion: entry.driverVersion,
      provenance: entry.provenance,
      executableIdentity: entry.executableIdentity,
      executableLabel: entry.executableLabel,
      protocol: entry.protocol,
      acpAvailability: entry.acpAvailability,
      ...(entry.acpVersion !== undefined ? { acpVersion: entry.acpVersion } : {}),
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      auth: entry.auth,
      health: entry.health,
      capabilities: entry.capabilities,
      sessionOperations: entry.sessionOperations,
      entitlementHints: entry.entitlementHints,
      limitations: entry.limitations,
      eligibility: { eligible: blockers.length === 0, blockers },
      transport: entry.transport,
      models: entry.models,
      observedAt: entry.observedAt,
      generation: entry.generation,
      freshness,
    }
  }

  async function discover(scope: DevScope): Promise<RuntimeConnectionSnapshot> {
    const now = nowIso(clock)
    const previous = load()
    const generationsById = new Map(
      previous.connections.map((entry) => [entry.id, entry.generation])
    )
    const byKey = new Map<string, StoredConnection>()
    const diagnostics: DiscoveryDiagnostic[] = []

    for (const source of sources) {
      const report = await source.discover({ scope, now })
      for (const diagnostic of report.diagnostics) diagnostics.push(diagnostic)
      if (report.connections.length > MAX_CONNECTIONS_PER_SOURCE) {
        diagnostics.push({
          family: '*',
          code: 'limit_exceeded',
          message: `source ${source.driverId} exceeded the connection budget; results truncated with a diagnostic`,
          observedAt: now,
        })
      }
      for (const candidate of report.connections.slice(0, MAX_CONNECTIONS_PER_SOURCE)) {
        const normalized = normalizeCandidate(candidate)
        if (normalized === null) {
          diagnostics.push({
            family: candidateFamilyLabel(candidate),
            code: 'limit_exceeded',
            message: 'candidate metadata exceeded inventory bounds and was dropped',
            observedAt: now,
          })
          continue
        }
        const digest = identityDigest(normalized.executableIdentity)
        const key = `${normalized.family}\0${digest}`
        const existing = byKey.get(key)
        // Managed provenance wins; otherwise the first source in order wins.
        if (existing && existing.provenance === 'managed') continue
        const id = stableInstallationId(scope, normalized.family, digest)
        const generation = (generationsById.get(id) ?? 0) + 1
        byKey.set(key, {
          ...normalized,
          driverId: source.driverId,
          driverVersion: source.driverVersion,
          transport: source.transport,
          id,
          scope,
          observedAt: now,
          generation,
        })
      }
      if (byKey.size >= MAX_TOTAL_CONNECTIONS) break
    }
    if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.length = MAX_DIAGNOSTICS

    // Persist replaces only this scope's observation; every other scope's
    // records survive untouched for their own rediscovery.
    persist(
      [
        ...previous.connections.filter((entry) => !sameScope(entry.scope, scope)),
        ...byKey.values(),
      ],
      [
        ...previous.diagnostics.filter((record) => !sameScope(record.scope, scope)),
        ...diagnostics.map((diagnostic) => ({ scope, diagnostic })),
      ]
    )
    audit?.append({
      action: 'discovery.completed',
      subjectId: scope.runtimeNodeId,
      outcome: 'granted',
      detail: {
        connections: String(byKey.size),
        diagnostics: String(diagnostics.length),
        drivers: String(sources.length),
      },
    })

    const nowMs = clock().getTime()
    const scopePolicyCapabilities = requiredCapabilitiesFor?.(scope) ?? []
    return {
      scope,
      connections: [...byKey.values()].map((entry) =>
        project(entry, nowMs, scopePolicyCapabilities)
      ),
      diagnostics,
      observedAt: now,
    }
  }

  /** Pure projection of the last persisted observation. Never re-probes. */
  function read(scope: DevScope): RuntimeConnectionSnapshot {
    const { connections, diagnostics } = load()
    const nowMs = clock().getTime()
    const scopePolicyCapabilities = requiredCapabilitiesFor?.(scope) ?? []
    return {
      scope,
      connections: connections
        .filter((entry) => sameScope(entry.scope, scope))
        .map((entry) => project(entry, nowMs, scopePolicyCapabilities)),
      diagnostics: diagnostics
        .filter((record) => sameScope(record.scope, scope))
        .map((record) => record.diagnostic),
      observedAt: nowIso(clock),
    }
  }

  return Object.freeze({ discover, read })
}

function candidateFamilyLabel(candidate: unknown): string {
  const family = (candidate as { family?: unknown } | null)?.family
  if (typeof family === 'string' && family.length > 0) return family.slice(0, 128)
  return '*'
}

export type RuntimeConnectionInventory = ReturnType<typeof createRuntimeConnectionInventory>

/**
 * Project the exact `HarnessInstallation` DTO shape from an inventory entry —
 * the read model the Dev Runtime contract defines and #400 consumes.
 */
export function harnessInstallationOf(entry: RuntimeConnectionEntry): {
  id: string
  scope: DevScope
  executableIdentity: string
  executableLabel: string
  protocol: HarnessProtocol
  version?: string
  auth: HarnessAuthState
  health: HarnessHealth
  capabilities: readonly string[]
  models: readonly StoredHarnessModel[]
  observedAt: string
  generation: number
} {
  return {
    id: entry.id,
    scope: entry.scope,
    executableIdentity: entry.executableIdentity,
    executableLabel: entry.executableLabel,
    protocol: entry.protocol,
    ...(entry.version !== undefined ? { version: entry.version } : {}),
    auth: entry.auth,
    health: entry.health,
    capabilities: entry.capabilities,
    models: entry.models,
    observedAt: entry.observedAt,
    generation: entry.generation,
  }
}
