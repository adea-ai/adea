// ACP lane adapter (issue #32): the substrate that connects a supported
// local harness speaking ACP and maps that connection onto the canonical
// `RuntimeSession` identity.
//
// Boundaries this module enforces (spec "Harness registry and launch" and
// issue #32):
// - Agent HQ product clients never speak ACP; only this host adapter does,
//   and only behind the M10 gate.
// - Connection setup negotiates protocol version, capabilities, session
//   operations, and limitations. A REQUIRED capability the harness does not
//   advertise makes the connection ineligible (typed `incompatible`); an
//   OPTIONAL capability's absence only degrades the record explicitly.
// - Native history/load/replay is a separately negotiated capability and is
//   never fabricated: absent negotiation reports `history: 'unavailable'`
//   and never implies session-history replay.
// - Native authentication, tools, and configuration stay with the external
//   harness; this adapter never mutates harness configuration.
// - Every connection is bound to one canonical RuntimeSession id and a
//   generation; close bumps the generation so stale bindings are inert.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { nowIso, sameScope, type DevScope } from '../authority'
import type { AuthorityAudit } from '../audit'
import { createDurableJsonStore } from '../host-store'
import type {
  AcpConnection,
  AcpConnectionState,
  AcpHistoryCapability,
  DevErrorCode,
} from '../../../../../../packages/types/src/dev-runtime'

export const ACP_DRIVER_ID = 'acp-process'
export const ACP_DRIVER_VERSION = '1'
/** The ACP protocol version this adapter negotiates. */
export const ACP_PROTOCOL_VERSION = '1'
/**
 * Capabilities an ACP harness MUST advertise for the lane to serve #400 as
 * the structured-events authority. Anything else is optional and only
 * degrades explicitly.
 */
export const ACP_REQUIRED_CAPABILITIES: readonly string[] = ['session']
/** Optional capability names the adapter understands but never requires. */
export const ACP_OPTIONAL_CAPABILITIES: readonly string[] = ['history', 'models', 'tools']

export type AcpHandshake = Readonly<{
  protocolVersion: string
  capabilities: readonly string[]
  sessionOperations: readonly string[]
  history: AcpHistoryCapability
  processIdentity: string
}>

export type ResolvedHarnessInstallation = Readonly<{
  id: string
  executableIdentity: string
  executableLabel: string
  acpAvailability: 'available' | 'adapter_required' | 'unavailable'
  acpVersion?: string
  version?: string
  auth: 'ready' | 'required' | 'expired' | 'unknown'
  health: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  capabilities: readonly string[]
}>

export type AcpSpawnFailure = { ok: false; code: DevErrorCode; message: string }
export type AcpSpawnSuccess = { ok: true; handshake: AcpHandshake }

/**
 * The driver seam: one ACP-compatible harness connection. The production
 * driver spawns the harness executable (fixed argv) and performs the
 * initialize handshake; tests inject scripted drivers. The driver receives
 * only host-resolved installation facts — never renderer-supplied argv.
 */
export type AcpLaneDriver = Readonly<{
  driverId: string
  driverVersion: string
  spawn(input: {
    connectionId: string
    runtimeSessionId: string
    installation: ResolvedHarnessInstallation
  }): Promise<AcpSpawnSuccess | AcpSpawnFailure>
  close(input: { connectionId: string; processIdentity: string }): Promise<void>
}>

export type StoredAcpConnection = Readonly<{
  id: string
  scope: DevScope
  runtimeSessionId: string
  harnessInstallationId: string
  driverId: string
  driverVersion: string
  negotiatedProtocolVersion: string
  requiredCapabilities: readonly string[]
  negotiatedCapabilities: readonly string[]
  missingRequiredCapabilities: readonly string[]
  sessionOperations: readonly string[]
  limitations: readonly string[]
  history: AcpHistoryCapability
  state: AcpConnectionState
  closeReason?: string
  processIdentity?: string
  observedAt: string
  generation: number
}>

export type AcpLaneInput = {
  scope: DevScope
  dataDir: string
  driver: AcpLaneDriver
  audit?: AuthorityAudit
  now?: () => number
  /** Overrides the required-capability policy (tests only). */
  requiredCapabilities?: readonly string[]
}

export type AcpLaneConnectInput = {
  runtimeSessionId: string
  installation: ResolvedHarnessInstallation
  /** Requested protocol version; defaults to the adapter's own. */
  protocolVersion?: string
}

export type AcpLane = Readonly<{
  list(filter?: { runtimeSessionId?: string; state?: AcpConnectionState }): readonly AcpConnection[]
  readyFor(runtimeSessionId: string): AcpConnection | undefined
  connect(input: AcpLaneConnectInput): Promise<AcpConnection>
  close(input: { acpConnectionId: string; expectedGeneration: number }): Promise<AcpConnection>
}>

export type AcpLaneFailure = Readonly<{
  code: DevErrorCode
  retryable: boolean
  message: string
}>

function projectConnection(record: StoredAcpConnection): AcpConnection {
  return {
    id: record.id,
    scope: record.scope,
    runtimeSessionId: record.runtimeSessionId,
    harnessInstallationId: record.harnessInstallationId,
    driverId: record.driverId,
    driverVersion: record.driverVersion,
    negotiatedProtocolVersion: record.negotiatedProtocolVersion,
    requiredCapabilities: record.requiredCapabilities,
    negotiatedCapabilities: record.negotiatedCapabilities,
    missingRequiredCapabilities: record.missingRequiredCapabilities,
    sessionOperations: record.sessionOperations,
    limitations: record.limitations,
    history: record.history,
    state: record.state,
    ...(record.closeReason !== undefined ? { closeReason: record.closeReason } : {}),
    observedAt: record.observedAt,
    generation: record.generation,
  }
}

/**
 * The production driver: spawns the installation's executable with a fixed
 * argv template (never renderer input) and performs a bounded newline-
 * delimited JSON initialize handshake over stdio. The spawn function is
 * injectable so tests script every byte without a real process.
 */
export function createAcpProcessDriver(
  input: {
    spawn?: (argv: readonly string[]) => Promise<{
      ok: boolean
      stdout: string
      message?: string
    }>
    handshakeTimeoutMs?: number
    maxHandshakeBytes?: number
    protocolVersion?: string
  } = {}
): AcpLaneDriver {
  const timeoutMs = input.handshakeTimeoutMs ?? 5_000
  const maxBytes = input.maxHandshakeBytes ?? 64 * 1024
  const protocolVersion = input.protocolVersion ?? ACP_PROTOCOL_VERSION
  return {
    driverId: ACP_DRIVER_ID,
    driverVersion: ACP_DRIVER_VERSION,
    async spawn({ connectionId, installation }) {
      // Fixed argv template: <executableIdentity> --acp. The executable
      // identity comes from the host-resolved installation record only.
      const argv = [installation.executableIdentity, '--acp']
      let result: { ok: boolean; stdout: string; message?: string }
      try {
        const spawnFn =
          input.spawn ??
          (async () => ({
            ok: false,
            stdout: '',
            message: 'no ACP transport is wired on this host',
          }))
        result = await Promise.race([
          spawnFn(argv),
          new Promise<{ ok: boolean; stdout: string; message: string }>((resolve) => {
            setTimeout(
              () => resolve({ ok: false, stdout: '', message: 'ACP handshake timed out' }),
              timeoutMs
            )
          }),
        ])
      } catch (error) {
        return {
          ok: false,
          code: 'spawn_failed',
          message: error instanceof Error ? error.message : 'ACP spawn failed',
        }
      }
      if (!result.ok) {
        return { ok: false, code: 'spawn_failed', message: result.message ?? 'ACP spawn failed' }
      }
      if (result.stdout.length > maxBytes) {
        return {
          ok: false,
          code: 'limit_exceeded',
          message: 'ACP handshake exceeded the bounded reply size',
        }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(result.stdout)
      } catch {
        return { ok: false, code: 'incompatible', message: 'ACP handshake was not valid JSON' }
      }
      const reply = parsed as Record<string, unknown> | null
      if (!reply || typeof reply !== 'object') {
        return { ok: false, code: 'incompatible', message: 'ACP handshake reply was not an object' }
      }
      const processIdentity =
        typeof reply.processIdentity === 'string' ? reply.processIdentity : connectionId
      if (typeof reply.protocolVersion !== 'string' || reply.protocolVersion.length === 0) {
        return {
          ok: false,
          code: 'unsupported_version',
          message: 'ACP handshake did not report a protocol version',
        }
      }
      if (!reply.protocolVersion.startsWith(protocolVersion)) {
        return {
          ok: false,
          code: 'unsupported_version',
          message: `ACP harness speaks protocol ${reply.protocolVersion}; this adapter requires ${protocolVersion}`,
        }
      }
      const capabilities = Array.isArray(reply.capabilities)
        ? reply.capabilities.filter(
            (capability): capability is string =>
              typeof capability === 'string' && capability.length > 0
          )
        : []
      const sessionOperations = Array.isArray(reply.sessionOperations)
        ? reply.sessionOperations.filter(
            (operation): operation is string =>
              typeof operation === 'string' && operation.length > 0
          )
        : []
      return {
        ok: true,
        handshake: {
          protocolVersion: reply.protocolVersion,
          capabilities,
          sessionOperations,
          history: reply.history === 'available' ? 'available' : 'unavailable',
          processIdentity,
        },
      }
    },
    async close() {
      // The process seam's teardown is best-effort: the connection record is
      // the authority for lane state, and the harness owns its process.
    },
  }
}

function isLive(record: StoredAcpConnection): boolean {
  return record.state === 'connecting' || record.state === 'ready'
}

export function createAcpLane(input: AcpLaneInput): AcpLane {
  const now = input.now ?? Date.now
  const required = input.requiredCapabilities ?? ACP_REQUIRED_CAPABILITIES
  const store = createDurableJsonStore<StoredAcpConnection>({
    file: join(input.dataDir, 'dev-runtime', 'harness', 'acp-connections.json'),
    schemaVersion: 1,
    label: 'ACP lane connections',
  })
  const limit = 500

  function load(): StoredAcpConnection[] {
    const records = store.load().records
    return records.filter((record) => sameScope(record.scope, input.scope))
  }

  function save(records: readonly StoredAcpConnection[]): void {
    store.save([...records])
  }

  function upsert(record: StoredAcpConnection): void {
    save([...load().filter((entry) => entry.id !== record.id), record])
  }

  async function connect(connectInput: AcpLaneConnectInput): Promise<AcpConnection> {
    const installation = connectInput.installation
    if (installation.acpAvailability === 'unavailable') {
      throw {
        code: 'unsupported_capability',
        retryable: false,
        message: 'this installation does not advertise an ACP-compatible connection',
      }
    }
    const connectionId = randomUUID()
    const observedAt = nowIso(() => new Date(now()))
    const spawned = await input.driver.spawn({
      connectionId,
      runtimeSessionId: connectInput.runtimeSessionId,
      installation,
    })
    if (!spawned.ok) {
      const failed: StoredAcpConnection = {
        id: connectionId,
        scope: input.scope,
        runtimeSessionId: connectInput.runtimeSessionId,
        harnessInstallationId: installation.id,
        driverId: input.driver.driverId,
        driverVersion: input.driver.driverVersion,
        negotiatedProtocolVersion: connectInput.protocolVersion ?? ACP_PROTOCOL_VERSION,
        requiredCapabilities: [...required],
        negotiatedCapabilities: [],
        missingRequiredCapabilities: [...required],
        sessionOperations: [],
        limitations: ['connection_failed'],
        history: 'unavailable',
        state: 'failed',
        closeReason: spawned.message.slice(0, 512),
        observedAt,
        generation: 1,
      }
      upsert(failed)
      input.audit?.append({
        action: 'harness.acp.connect_failed',
        subjectId: connectionId,
        outcome: 'failed',
        detail: { code: spawned.code },
      })
      throw { code: spawned.code, retryable: true, message: spawned.message }
    }
    const handshake = spawned.handshake
    const missing = [...required].filter(
      (capability) => !handshake.capabilities.includes(capability)
    )
    if (missing.length > 0) {
      // A required unsupported capability makes the connection ineligible:
      // record the evidence truthfully, then refuse with the contract code.
      const ineligible: StoredAcpConnection = {
        id: connectionId,
        scope: input.scope,
        runtimeSessionId: connectInput.runtimeSessionId,
        harnessInstallationId: installation.id,
        driverId: input.driver.driverId,
        driverVersion: input.driver.driverVersion,
        negotiatedProtocolVersion: handshake.protocolVersion,
        requiredCapabilities: [...required],
        negotiatedCapabilities: [...handshake.capabilities],
        missingRequiredCapabilities: missing,
        sessionOperations: [...handshake.sessionOperations],
        limitations: ['required_capabilities_unsupported'],
        history: handshake.history,
        state: 'failed',
        closeReason: 'required capabilities were not negotiated',
        processIdentity: handshake.processIdentity,
        observedAt,
        generation: 1,
      }
      upsert(ineligible)
      input.audit?.append({
        action: 'harness.acp.connect_ineligible',
        subjectId: connectionId,
        outcome: 'denied',
        detail: { missing: String(missing.length) },
      })
      throw {
        code: 'incompatible',
        retryable: false,
        message: `the harness did not negotiate required ACP capabilities: ${missing.join(', ')}`,
      }
    }
    if (
      connectInput.protocolVersion !== undefined &&
      !handshake.protocolVersion.startsWith(connectInput.protocolVersion)
    ) {
      throw {
        code: 'unsupported_version',
        retryable: false,
        message: `the harness negotiated protocol ${handshake.protocolVersion}, not the requested ${connectInput.protocolVersion}`,
      }
    }
    const limitations = [...handshake.capabilities]
      .filter((capability) => !ACP_OPTIONAL_CAPABILITIES.includes(capability))
      .map((capability) => `unmodeled_capability:${capability}`)
    const ready: StoredAcpConnection = {
      id: connectionId,
      scope: input.scope,
      runtimeSessionId: connectInput.runtimeSessionId,
      harnessInstallationId: installation.id,
      driverId: input.driver.driverId,
      driverVersion: input.driver.driverVersion,
      negotiatedProtocolVersion: handshake.protocolVersion,
      requiredCapabilities: [...required],
      negotiatedCapabilities: [...handshake.capabilities],
      missingRequiredCapabilities: [],
      sessionOperations: [...handshake.sessionOperations],
      limitations,
      history: handshake.history,
      state: 'ready',
      processIdentity: handshake.processIdentity,
      observedAt,
      generation: 1,
    }
    upsert(ready)
    input.audit?.append({
      action: 'harness.acp.connected',
      subjectId: connectionId,
      outcome: 'granted',
      detail: { runtimeSessionId: connectInput.runtimeSessionId },
    })
    return projectConnection(ready)
  }

  async function close(closeInput: {
    acpConnectionId: string
    expectedGeneration: number
  }): Promise<AcpConnection> {
    const record = load().find((entry) => entry.id === closeInput.acpConnectionId)
    if (!record) {
      throw {
        code: 'not_found',
        retryable: false,
        message: 'ACP connection is not registered on this runtime node',
      }
    }
    if (record.generation !== closeInput.expectedGeneration) {
      throw {
        code: 'stale_generation',
        retryable: false,
        message: 'ACP connection generation conflict',
      }
    }
    if (!isLive(record)) {
      throw {
        code: 'invalid_state',
        retryable: false,
        message: `ACP connection is already ${record.state}`,
      }
    }
    await input.driver.close({
      connectionId: record.id,
      processIdentity: record.processIdentity ?? record.id,
    })
    const closed: StoredAcpConnection = {
      ...record,
      state: 'closed',
      closeReason: 'closed by owner',
      generation: record.generation + 1,
      observedAt: nowIso(() => new Date(now())),
    }
    upsert(closed)
    input.audit?.append({
      action: 'harness.acp.closed',
      subjectId: record.id,
      outcome: 'granted',
    })
    return projectConnection(closed)
  }

  function list(filter?: {
    runtimeSessionId?: string
    state?: AcpConnectionState
  }): AcpConnection[] {
    return load()
      .filter((record) =>
        filter?.runtimeSessionId ? record.runtimeSessionId === filter.runtimeSessionId : true
      )
      .filter((record) => (filter?.state ? record.state === filter.state : true))
      .toSorted((left, right) => left.observedAt.localeCompare(right.observedAt))
      .slice(0, limit)
      .map(projectConnection)
  }

  function readyFor(runtimeSessionId: string): AcpConnection | undefined {
    const found = load()
      .filter((record) => record.runtimeSessionId === runtimeSessionId && record.state === 'ready')
      .toSorted((left, right) => right.observedAt.localeCompare(left.observedAt))[0]
    return found ? projectConnection(found) : undefined
  }

  return Object.freeze({ list, readyFor, connect, close })
}
