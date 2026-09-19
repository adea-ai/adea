// Harness runtime registration (issues #31/#32): wires the managed-Pi
// driver, the ACP lane adapter, and the canonical-session run operations
// onto the M10 command registry.
//
// Everything here runs behind the M10 gate — envelope, capability set,
// replay, expiry, and scope admission have passed before a handler runs.
// This module re-checks what it owns and fails closed:
// - every operation re-checks the authenticated scope;
// - every runtime_session-bound operation re-checks the envelope resource
//   binding (kind, id, generation) against the canonical RuntimeSession
//   record before dispatch — the dev.session.create/transferInput pattern;
// - runs and connections bind to the canonical RuntimeSession identity.
//   Dev and Chat share the same runtimeSessionId; this slice never invents
//   a second session type;
// - genuine host absence (no managed Pi toolchain/archive, no ACP harness)
//   surfaces as typed contract errors — never a fabricated session or run.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { AuthorityAudit } from '../audit'
import { createRuntimeConnectionInventory } from '../discovery/inventory'
import type {
  AcpConnectionState,
  DevCommand,
  DevError,
  DevOperation,
  HarnessRun,
  HarnessRunState,
  ManagedPiStatus,
  RuntimeSession,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import type { ChannelAuthority } from '../channel/authority'
import { createDurableJsonStore } from '../host-store'
import {
  createAcpLane,
  type AcpLane,
  type AcpLaneDriver,
  type ResolvedHarnessInstallation,
} from './acp-lane'
import { createManagedPiDriver, type ManagedPiDriver } from './managed-pi-driver'

const RUN_ACTIVE_STATES: readonly HarnessRunState[] = [
  'resolving',
  'starting',
  'working',
  'awaiting_input',
  'awaiting_approval',
]

const RUN_TERMINAL_STATES: readonly HarnessRunState[] = [
  'completed',
  'failed',
  'cancelled',
  'disconnected',
]

export type HarnessRuntimeInput = {
  authority: ChannelAuthority
  /** The verified local-lane scope; the shell IS the runtime node here. */
  scope: Scope
  dataDir: string
  /** Canonical RuntimeSession resolution (project/session projection). */
  resolveSession: (runtimeSessionId: string) => RuntimeSession | undefined
  /** Persists canonical session mutations so both views observe them. */
  persistSession: (session: RuntimeSession) => void
  /** Shell event bus; harness changes publish so Dev and Chat share them. */
  publish?: (event: string, payload: unknown) => void
  /** Overrides the managed Pi driver (tests inject scripted archives). */
  managedPi?: ManagedPiDriver
  /** Overrides the ACP lane driver (tests inject scripted handshakes). */
  acpDriver?: AcpLaneDriver
  audit?: AuthorityAudit
  now?: () => number
}

export type HarnessRuntimeRegistration = Readonly<{
  commands: readonly DevOperation[]
  managedPi: ManagedPiDriver
  lane: AcpLane
}>

function devError(code: DevError['code'], message: string, retryable = false): DevError {
  return { code, retryable, message }
}

function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

type StoredHarnessRun = HarnessRun

/**
 * Resolves a harness installation from the substrate's authorities: the
 * managed Pi driver first, then the M10 #30 discovery inventory read (never
 * a re-probe — the inventory read is a pure projection of persisted facts).
 */
type InstallationResolution =
  | { kind: 'managed'; status: ManagedPiStatus }
  | { kind: 'connection'; installation: ResolvedHarnessInstallation }
  | undefined

export function registerHarnessRuntime(input: HarnessRuntimeInput): HarnessRuntimeRegistration {
  const now = input.now ?? Date.now
  const managedPi =
    input.managedPi ??
    createManagedPiDriver({
      scope: input.scope,
      dataDir: input.dataDir,
      ...(input.audit ? { audit: input.audit } : {}),
    })
  const lane = createAcpLane({
    scope: input.scope,
    dataDir: input.dataDir,
    driver: input.acpDriver ?? fallbackAcpDriver(),
    ...(input.audit ? { audit: input.audit } : {}),
  })
  // The M10 #30 inventory read is store-backed: read() never probes.
  const inventory = createRuntimeConnectionInventory({ dataDir: input.dataDir, sources: [] })
  const runs = createRunStore()

  function createRunStore(): {
    list(): HarnessRun[]
    get(id: string): HarnessRun | undefined
    append(run: HarnessRun): void
    replace(run: HarnessRun): void
  } {
    const store = createDurableJsonStore<StoredHarnessRun>({
      file: join(input.dataDir, 'dev-runtime', 'harness', 'runs.json'),
      schemaVersion: 1,
      label: 'harness runs',
    })
    const all = () => store.load().records.filter((run) => sameScope(run.scope, input.scope))
    return {
      list: all,
      get: (id) => all().find((run) => run.id === id),
      append: (run) => store.save([...all(), run]),
      replace: (run) => store.save(all().map((entry) => (entry.id === run.id ? run : entry))),
    }
  }

  function requireScope(command: DevCommand): void {
    if (!sameScope(command.scope, input.scope)) {
      throw devError('channel_unauthorized', 'harness scope is not authorized')
    }
  }

  function resolveSessionOrThrow(runtimeSessionId: string): RuntimeSession {
    const session = input.resolveSession(runtimeSessionId)
    if (!session) throw devError('not_found', 'runtime session not found')
    if (!sameScope(session.scope, input.scope)) {
      throw devError('identity_mismatch', 'runtime session belongs to another scope')
    }
    return session
  }

  /** The envelope resource for runtime_session operations must name this
   * session at its current generation before the provider acts on it. */
  function requireSessionResource(command: DevCommand, session: RuntimeSession): void {
    const resource = command.resource
    if (resource === undefined) {
      throw devError('identity_mismatch', 'operation requires a runtime_session resource binding')
    }
    if (resource.kind !== 'runtime_session') {
      throw devError('identity_mismatch', 'resource kind must be runtime_session')
    }
    if (resource.id !== session.id) {
      throw devError('identity_mismatch', 'resource id does not match the request body')
    }
    if (resource.generation !== session.generation) {
      throw devError('stale_generation', 'resource generation does not match the session record')
    }
  }

  function requireGeneration(command: DevCommand, session: RuntimeSession): void {
    const body = devOperationDecoders[command.operation].request(command.body)
    if (session.generation !== (body.expectedGeneration as number)) {
      throw devError('stale_generation', 'runtime session generation conflict')
    }
  }

  function requireLaunchableSession(session: RuntimeSession): void {
    if (session.archived) {
      throw devError('invalid_state', 'an archived session launches no harness run')
    }
  }

  function resolveInstallation(id: string): InstallationResolution {
    const managedStatus = managedPi.status()
    if (managedStatus.installationId === id) {
      if (managedStatus.state !== 'ready' || !managedStatus.executableIdentity) {
        return { kind: 'managed', status: managedStatus }
      }
      return {
        kind: 'connection',
        installation: {
          id: managedStatus.installationId,
          executableIdentity: managedStatus.executableIdentity,
          executableLabel: managedStatus.executableLabel ?? 'managed Pi',
          acpAvailability: 'unavailable',
          version: managedStatus.resolvedVersion,
          auth: 'ready',
          health: 'healthy',
          capabilities: ['managed', 'resume'],
        },
      }
    }
    const entry = inventory.read(input.scope).connections.find((connection) => connection.id === id)
    if (!entry) return undefined
    return {
      kind: 'connection',
      installation: {
        id: entry.id,
        executableIdentity: entry.executableIdentity,
        executableLabel: entry.executableLabel,
        acpAvailability: entry.acpAvailability,
        ...(entry.acpVersion !== undefined ? { acpVersion: entry.acpVersion } : {}),
        ...(entry.version !== undefined ? { version: entry.version } : {}),
        auth: entry.auth,
        health: entry.health,
        capabilities: entry.capabilities,
      },
    }
  }

  /** Turns an installation resolution into a launch-eligible installation,
   * surfacing genuine absence as typed contract errors with remediation. */
  function requireLaunchInstallation(id: string): ResolvedHarnessInstallation {
    const resolution = resolveInstallation(id)
    if (!resolution) {
      throw devError('not_found', 'harness installation is not registered on this runtime node')
    }
    if (resolution.kind === 'managed') {
      throw {
        code: 'capability_unavailable',
        retryable: true,
        message: 'the managed Pi installation is not ready on this host',
        remediation: { action: 'dev.harness.managedPiInstall' },
        observedAt: new Date(now()).toISOString(),
      } satisfies DevError
    }
    return resolution.installation
  }

  function createRun(params: {
    session: RuntimeSession
    installationId: string
    agentProfileId: string
    agentProfileVersion: number
    modelId?: string
    state: HarnessRunState
    generation: number
  }): HarnessRun {
    if (!Number.isSafeInteger(params.agentProfileVersion) || params.agentProfileVersion < 1) {
      throw devError('invalid_state', 'agentProfileVersion must be a positive version integer')
    }
    const at = new Date(now()).toISOString()
    return {
      id: randomUUID(),
      scope: { ...input.scope },
      runtimeSessionId: params.session.id,
      installationId: params.installationId,
      agentProfile: {
        id: params.agentProfileId,
        version: params.agentProfileVersion,
        displayName: params.agentProfileId,
        capabilityPolicyVersion: params.agentProfileVersion,
      },
      ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
      state: params.state,
      generation: params.generation,
      startedAt: at,
      version: 1,
    }
  }

  function activeRunFor(sessionId: string): HarnessRun | undefined {
    return runs
      .list()
      .filter((run) => run.runtimeSessionId === sessionId && RUN_ACTIVE_STATES.includes(run.state))
      .toSorted((left, right) => (right.startedAt ?? '').localeCompare(left.startedAt ?? ''))[0]
  }

  function applySession(session: RuntimeSession, patch: Partial<RuntimeSession>): RuntimeSession {
    const next: RuntimeSession = {
      ...session,
      ...patch,
      generation: session.generation + 1,
      version: session.version + 1,
    }
    input.persistSession(next)
    return next
  }

  function publish(kind: string, detail: Record<string, unknown>): void {
    input.publish?.('dev.harness.updated', {
      kind,
      scope: input.scope,
      observedAt: new Date(now()).toISOString(),
      ...detail,
    })
  }

  const providers: Partial<
    Record<DevOperation, (command: DevCommand) => unknown | Promise<unknown>>
  > = {
    // ── #31: managed Pi installation lifecycle ────────────────────────────
    'dev.harness.managedPiStatus': (command) => {
      requireScope(command)
      devOperationDecoders['dev.harness.managedPiStatus'].request(command.body)
      return managedPi.status()
    },
    'dev.harness.managedPiInstall': async (command) => {
      requireScope(command)
      devOperationDecoders['dev.harness.managedPiInstall'].request(command.body)
      const status = await managedPi.ensureInstalled()
      publish('managedPi.installed', {
        state: status.state,
        version: status.resolvedVersion,
        installationId: status.installationId,
      })
      return status
    },

    // ── #32: ACP lane connections ─────────────────────────────────────────
    'dev.harness.acpConnect': async (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.harness.acpConnect'].request(command.body)
      const session = resolveSessionOrThrow(body.runtimeSessionId as string)
      requireSessionResource(command, session)
      requireGeneration(command, session)
      requireLaunchableSession(session)
      const installation = requireLaunchInstallation(body.harnessInstallationId as string)
      const connection = await lane.connect({
        runtimeSessionId: session.id,
        installation,
        ...(typeof body.protocolVersion === 'string'
          ? { protocolVersion: body.protocolVersion }
          : {}),
      })
      publish('acpConnection.ready', {
        acpConnectionId: connection.id,
        runtimeSessionId: session.id,
        history: connection.history,
      })
      return connection
    },
    'dev.harness.acpConnections': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.harness.acpConnections'].request(command.body)
      const items = lane.list({
        ...(typeof body.runtimeSessionId === 'string'
          ? { runtimeSessionId: body.runtimeSessionId }
          : {}),
        ...(typeof body.state === 'string' ? { state: body.state as AcpConnectionState } : {}),
      })
      return { items, observedAt: new Date(now()).toISOString() }
    },
    'dev.harness.acpClose': async (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.harness.acpClose'].request(command.body)
      const resource = command.resource
      if (resource === undefined || resource.kind !== 'acp_connection') {
        throw devError('identity_mismatch', 'operation requires an acp_connection resource binding')
      }
      if (resource.id !== (body.acpConnectionId as string)) {
        throw devError('identity_mismatch', 'resource id does not match the request body')
      }
      if (resource.generation !== (body.expectedGeneration as number)) {
        throw devError('stale_generation', 'resource generation does not match the request body')
      }
      const connection = await lane.close({
        acpConnectionId: body.acpConnectionId as string,
        expectedGeneration: body.expectedGeneration as number,
      })
      publish('acpConnection.closed', {
        acpConnectionId: connection.id,
        runtimeSessionId: connection.runtimeSessionId,
      })
      return connection
    },

    // ── Run status/history read model ─────────────────────────────────────
    'dev.harness.runs': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.harness.runs'].request(command.body)
      const items = runs
        .list()
        .filter((run) =>
          typeof body.runtimeSessionId === 'string'
            ? run.runtimeSessionId === body.runtimeSessionId
            : true
        )
        .filter((run) =>
          typeof body.installationId === 'string'
            ? run.installationId === body.installationId
            : true
        )
        .filter((run) => (typeof body.state === 'string' ? run.state === body.state : true))
        .toSorted((left, right) => (right.startedAt ?? '').localeCompare(left.startedAt ?? ''))
      return { items, observedAt: new Date(now()).toISOString() }
    },

    // ── Canonical-session run operations (#400's launch surface) ──────────
    'dev.session.launchHarness': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.session.launchHarness'].request(command.body)
      const session = resolveSessionOrThrow(body.runtimeSessionId as string)
      requireSessionResource(command, session)
      requireGeneration(command, session)
      requireLaunchableSession(session)
      const installationId = body.harnessInstallationId as string
      // Launch is idempotent: the same installation/profile/model on a live
      // run returns that run instead of duplicating a process decision.
      const active = activeRunFor(session.id)
      if (
        active &&
        active.installationId === installationId &&
        active.agentProfile.id === (body.agentProfileId as string) &&
        active.agentProfile.version === (body.agentProfileVersion as number)
      ) {
        return active
      }
      if (active) {
        throw devError(
          'invalid_state',
          'a harness run is already active for this session; cancel it before launching another installation'
        )
      }
      requireLaunchInstallation(installationId)
      const run = createRun({
        session,
        installationId,
        agentProfileId: body.agentProfileId as string,
        agentProfileVersion: body.agentProfileVersion as number,
        ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {}),
        state: 'starting',
        generation: 1,
      })
      runs.append(run)
      const nextSession = applySession(session, {
        activeHarnessRunId: run.id,
        lifecycle: 'active',
      })
      publish('run.created', {
        harnessRunId: run.id,
        runtimeSessionId: nextSession.id,
        generation: nextSession.generation,
      })
      return run
    },
    'dev.session.resumeHarness': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.session.resumeHarness'].request(command.body)
      const session = resolveSessionOrThrow(body.runtimeSessionId as string)
      requireSessionResource(command, session)
      requireGeneration(command, session)
      requireLaunchableSession(session)
      const prior = runs.get(body.harnessRunId as string)
      if (!prior) throw devError('not_found', 'harness run not found')
      if (prior.runtimeSessionId !== session.id) {
        throw devError('identity_mismatch', 'harness run belongs to another runtime session')
      }
      requireLaunchInstallation(prior.installationId)
      // Resume creates a new run generation under the SAME session; it never
      // reuses the stale run's write authority.
      if (RUN_ACTIVE_STATES.includes(prior.state)) {
        const ended: HarnessRun = { ...prior, state: 'disconnected', version: prior.version + 1 }
        runs.replace(ended)
      }
      const run = createRun({
        session,
        installationId: prior.installationId,
        agentProfileId: prior.agentProfile.id,
        agentProfileVersion: prior.agentProfile.version,
        ...(prior.modelId !== undefined ? { modelId: prior.modelId } : {}),
        state: 'working',
        generation: prior.generation + 1,
      })
      runs.append(run)
      const nextSession = applySession(session, {
        activeHarnessRunId: run.id,
        lifecycle: 'active',
      })
      publish('run.resumed', {
        harnessRunId: run.id,
        resumedFrom: prior.id,
        runtimeSessionId: nextSession.id,
        generation: nextSession.generation,
      })
      return run
    },
    'dev.session.cancelHarness': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.session.cancelHarness'].request(command.body)
      const session = resolveSessionOrThrow(body.runtimeSessionId as string)
      requireSessionResource(command, session)
      requireGeneration(command, session)
      const run = runs.get(body.harnessRunId as string)
      if (!run) throw devError('not_found', 'harness run not found')
      if (run.runtimeSessionId !== session.id) {
        throw devError('identity_mismatch', 'harness run belongs to another runtime session')
      }
      if (RUN_TERMINAL_STATES.includes(run.state)) {
        throw devError('already_completed', `harness run is already ${run.state}`)
      }
      const cancelled: HarnessRun = {
        ...run,
        state: 'cancelled',
        finishedAt: new Date(now()).toISOString(),
        version: run.version + 1,
      }
      runs.replace(cancelled)
      // A live ACP lane bound to this session loses its transport authority
      // with the run; close is best-effort and generation-fenced by the lane.
      const live = lane.readyFor(session.id)
      if (live) {
        void lane
          .close({ acpConnectionId: live.id, expectedGeneration: live.generation })
          .catch(() => undefined)
      }
      const nextSession = applySession(session, {
        activeHarnessRunId: undefined,
        lifecycle: 'disconnected',
      })
      publish('run.cancelled', {
        harnessRunId: cancelled.id,
        runtimeSessionId: nextSession.id,
        generation: nextSession.generation,
      })
      return cancelled
    },
  }

  for (const [operation, provider] of Object.entries(providers)) {
    input.authority.registerCommandProvider(operation as DevOperation, provider)
  }

  return {
    commands: Object.keys(providers) as DevOperation[],
    managedPi,
    lane,
  }
}

/** Scripted failure used when no ACP driver seam was provided. */
function fallbackAcpDriver(): AcpLaneDriver {
  return {
    driverId: 'acp-unavailable',
    driverVersion: '0',
    async spawn() {
      return {
        ok: false as const,
        code: 'capability_unavailable' as const,
        message: 'no ACP harness driver is installed on this host',
      }
    },
    async close() {
      return
    },
  }
}
