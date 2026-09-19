// The supervision engine for the bundled local stack (M10 #185). The desktop
// shell is the one supervisor: start/stop/restart/crash recovery with
// launch-record identity, dependency-aware readiness, health probes, and the
// adopt/drain/crash-loop lifecycle the Dev Runtime sidecar registers with.
// M12 must not add a second supervisor — terminal/worktree/harness adapters
// register their processes here instead of supervising their own.
//
// Semantics fixed by docs/specs/dev-runtime.md ("Sidecar adoption", state
// machines) and the Dev View threat model:
// - restart loops allow 5 failures in 10 minutes, then stop and surface
//   `crash_loop`; clearing it is an explicit operator restart;
// - a destructive signal requires the launch record plus PID start identity,
//   rechecked immediately before the signal (TM-004) — a PID reused by an
//   unrelated process is never signalled (`ownership_unproven`);
// - protocol version handshake chooses exactly one of `adopt`,
//   `drain_upgrade` (retain current sessions until detached), or
//   `sidecar_incompatible`; no PID/port adoption fallback exists.
//
// The engine is deterministic: the clock is injected and every process side
// effect goes through the `SupervisionAdapter` seam, so restart policy and
// PID-reuse races are unit-testable. The packaged lane wires a real adapter.
import { randomUUID } from 'node:crypto'

import type { ComponentId, ComponentManifest, ComponentSpec } from './component-manifest'
import {
  type ExitedRecord,
  type LaunchedRecord,
  type ProcessIdentity,
  type RecordStore,
} from './records'

/** Process states follow the spec's machine; health is orthogonal. */
export type ComponentState = 'idle' | 'running' | 'draining' | 'stopping' | 'exited' | 'crash_loop'
export type ComponentHealth = 'unknown' | 'healthy' | 'degraded' | 'unhealthy'

export type SupervisionErrorCode =
  | 'not_found'
  | 'invalid_state'
  | 'capability_unavailable'
  | 'crash_loop'
  | 'ownership_unproven'
  | 'stale_generation'
  | 'already_completed'
  | 'spawn_failed'
  | 'sidecar_incompatible'
  | 'confirmation_required'
  | 'confirmation_invalid'

export type SupervisionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SupervisionErrorCode; message: string }

export type SupervisionAdapter = {
  spawn(
    spec: ComponentSpec,
    generation: number
  ): Promise<{ identity: ProcessIdentity; processGroup: string }>
  /** Current OS identity for a PID, or null when nothing lives there. */
  currentIdentity(pid: number): Promise<ProcessIdentity | null>
  probe(spec: ComponentSpec, identity: ProcessIdentity): Promise<'responsive' | 'unresponsive'>
  signalIdentity(identity: ProcessIdentity, signalName: 'SIGTERM' | 'SIGKILL'): Promise<void>
}

export type LaunchRecordPublic = {
  processRecordId: string
  componentId: ComponentId
  generation: number
  identity: ProcessIdentity
  processGroup: string
  startedAt: string
}

export type AuditEvent = {
  at: string
  kind: 'spawn' | 'exit' | 'signal' | 'crash_loop' | 'adoption' | 'drain' | 'health'
  componentId: ComponentId
  generation: number | null
  detail: string
}

export type SupervisionSnapshot = {
  components: Array<{
    id: ComponentId
    state: ComponentState
    health: ComponentHealth
    generation: number
    launch: { identity: ProcessIdentity; processGroup: string; startedAt: string } | null
    /** Exact packaged version/digest for diagnostics (issue #185 acceptance). */
    manifest: { version: string; digestSha256: string }
  }>
}

const CRASH_LOOP_WINDOW_MS = 10 * 60_000
const CRASH_LOOP_MAX_FAILURES = 5
const AUDIT_RING_LIMIT = 500

type ComponentRuntime = {
  spec: ComponentSpec
  state: ComponentState
  health: ComponentHealth
  generation: number
  launch: LaunchRecordPublic | null
  lastHeartbeatAt: number
  /** Timestamps (ms) of unexpected exits inside the crash-loop window. */
  failures: number[]
  drainComplete: boolean
}

export type Supervisor = {
  start(args: {
    componentId: ComponentId
    idempotencyKey: string
  }): Promise<SupervisionResult<LaunchRecordPublic>>
  requestStop(
    componentId: ComponentId
  ): SupervisionResult<{ confirmationId: string; generation: number }>
  /** Reconciles persisted launch records against current executable identity. */
  reconcile(): Promise<void>
  stop(
    componentId: ComponentId,
    opts?: { generation?: number; confirmationId?: string; escalate?: boolean }
  ): Promise<SupervisionResult<ExitedRecord>>
  restart(componentId: ComponentId): Promise<SupervisionResult<LaunchRecordPublic>>
  /** The owned process exited unexpectedly (crash or external kill). */
  reportUnexpectedExit(
    componentId: ComponentId
  ): Promise<SupervisionResult<'restarted' | 'crash_loop'>>
  /** The owned process stopped responding; recheck, signal, recycle. */
  reportUnresponsive(
    componentId: ComponentId
  ): Promise<SupervisionResult<'restarted' | 'crash_loop'>>
  heartbeat(componentId: ComponentId): ComponentHealth
  health(componentId: ComponentId): ComponentHealth
  baselineReady(): { ready: boolean; missing: ComponentId[] }
  evaluateAdoption(args: {
    componentId: ComponentId
    protocol: { name: string; major: number; minor: number }
  }):
    | { decision: 'adopt' }
    | { decision: 'drain_upgrade' }
    | { decision: 'incompatible'; code: 'sidecar_incompatible' }
  drain(componentId: ComponentId): Promise<SupervisionResult<null>>
  sessionsDrained(componentId: ComponentId): Promise<SupervisionResult<null>>
  snapshot(): SupervisionSnapshot
  audit(): readonly AuditEvent[]
}

export function createSupervisor(input: {
  manifest: ComponentManifest
  adapter: SupervisionAdapter
  records?: RecordStore
  now?: () => number
}): Supervisor {
  const now = input.now ?? Date.now
  const records: RecordStore = input.records ?? createInMemoryRecords()
  const adapter = input.adapter

  const runtimes = new Map<ComponentId, ComponentRuntime>()
  for (const spec of input.manifest.components) {
    runtimes.set(spec.id, {
      spec,
      state: 'idle',
      health: 'unknown',
      generation: 0,
      launch: null,
      lastHeartbeatAt: 0,
      failures: [],
      drainComplete: false,
    })
  }
  const completedKeys = new Map<ComponentId, Map<string, LaunchRecordPublic>>()
  const confirmations = new Map<
    string,
    { componentId: ComponentId; generation: number; expiresAt: number }
  >()
  const auditRing: AuditEvent[] = []

  // Crash-loop history survives app restarts: unexpected exits journaled in
  // the durable records seed the failure window, and a window that is already
  // exhausted restores the crash_loop verdict instead of restarting blindly.
  for (const record of records.list()) {
    if (record.kind !== 'exited' || record.expected) continue
    const runtime = runtimes.get(record.componentId)
    if (!runtime) continue
    const at = Date.parse(record.at)
    if (Number.isFinite(at) && now() - at <= CRASH_LOOP_WINDOW_MS) runtime.failures.push(at)
  }
  for (const runtime of runtimes.values()) {
    pruneFailures(runtime)
    if (runtime.failures.length >= CRASH_LOOP_MAX_FAILURES) enterCrashLoop(runtime)
  }

  function audit(
    kind: AuditEvent['kind'],
    componentId: ComponentId,
    generation: number | null,
    detail: string
  ): void {
    auditRing.push({ at: new Date(now()).toISOString(), kind, componentId, generation, detail })
    if (auditRing.length > AUDIT_RING_LIMIT)
      auditRing.splice(0, auditRing.length - AUDIT_RING_LIMIT)
  }

  function pruneFailures(runtime: ComponentRuntime): void {
    const horizon = now() - CRASH_LOOP_WINDOW_MS
    runtime.failures = runtime.failures.filter((at) => at >= horizon)
  }

  function currentHealth(runtime: ComponentRuntime): ComponentHealth {
    if (!runtime.launch) {
      runtime.health = 'unknown'
      return runtime.health
    }
    const elapsed = now() - runtime.lastHeartbeatAt
    runtime.health =
      elapsed >= runtime.spec.healthProbe.unhealthyAfterMs
        ? 'unhealthy'
        : elapsed >= runtime.spec.healthProbe.intervalMs * 2
          ? 'degraded'
          : 'healthy'
    return runtime.health
  }

  function enterCrashLoop(runtime: ComponentRuntime): void {
    runtime.state = 'crash_loop'
    runtime.health = 'unknown'
    audit(
      'crash_loop',
      runtime.spec.id,
      runtime.generation,
      'restart policy exhausted; supervision stopped'
    )
  }

  /**
   * Shared exit path: journal the unexpected exit, count it against the
   * crash-loop window, and auto-restart unless the policy is exhausted.
   */
  async function recordUnexpectedExit(
    runtime: ComponentRuntime
  ): Promise<SupervisionResult<'restarted' | 'crash_loop'>> {
    const launch = runtime.launch
    runtime.state = 'exited'
    runtime.launch = null
    runtime.drainComplete = false
    runtime.health = 'unknown'
    if (launch) {
      const exited: ExitedRecord = {
        kind: 'exited',
        at: new Date(now()).toISOString(),
        componentId: runtime.spec.id,
        generation: launch.generation,
        processRecordId: launch.processRecordId,
        expected: false,
        exitDetail: 'unexpected exit',
      }
      records.append(exited)
      audit('exit', runtime.spec.id, launch.generation, 'unexpected exit')
    }
    runtime.failures.push(now())
    pruneFailures(runtime)
    if (runtime.failures.length >= CRASH_LOOP_MAX_FAILURES) {
      enterCrashLoop(runtime)
      return { ok: true, value: 'crash_loop' }
    }
    const restarted = await startRuntime(runtime, `auto-restart-${runtime.generation + 1}-${now()}`)
    if (!restarted.ok) return restarted
    return { ok: true, value: 'restarted' }
  }

  async function startRuntime(
    runtime: ComponentRuntime,
    idempotencyKey: string
  ): Promise<SupervisionResult<LaunchRecordPublic>> {
    if (runtime.state === 'crash_loop') {
      return fail(
        'crash_loop',
        `${runtime.spec.id} exhausted its restart budget; operator restart required`
      )
    }
    const completed = completedKeys.get(runtime.spec.id)?.get(idempotencyKey)
    if (completed) return { ok: true, value: completed }
    if (
      runtime.state === 'running' ||
      runtime.state === 'draining' ||
      runtime.state === 'stopping'
    ) {
      return fail('invalid_state', `${runtime.spec.id} is already ${runtime.state}`)
    }
    for (const dependencyId of runtime.spec.dependsOn) {
      const dependency = runtimes.get(dependencyId)
      if (
        !dependency ||
        dependency.state !== 'running' ||
        currentHealth(dependency) !== 'healthy'
      ) {
        return fail(
          'capability_unavailable',
          `${runtime.spec.id} cannot start before its dependency ${dependencyId} is running and healthy`
        )
      }
    }
    const generation = runtime.generation + 1
    let spawned: { identity: ProcessIdentity; processGroup: string }
    try {
      spawned = await adapter.spawn(runtime.spec, generation)
    } catch (error) {
      audit('spawn', runtime.spec.id, generation, `spawn failed: ${errorMessage(error)}`)
      return fail('spawn_failed', `${runtime.spec.id} could not start: ${errorMessage(error)}`)
    }
    const launch: LaunchRecordPublic = {
      processRecordId: randomUUID(),
      componentId: runtime.spec.id,
      generation,
      identity: spawned.identity,
      processGroup: spawned.processGroup,
      startedAt: new Date(now()).toISOString(),
    }
    runtime.generation = generation
    runtime.launch = launch
    runtime.state = 'running'
    runtime.drainComplete = false
    runtime.lastHeartbeatAt = now()
    runtime.health = 'healthy'
    records.append({
      kind: 'launched',
      at: launch.startedAt,
      componentId: launch.componentId,
      generation: launch.generation,
      processRecordId: launch.processRecordId,
      identity: launch.identity,
      processGroup: launch.processGroup,
    })
    audit(
      'spawn',
      runtime.spec.id,
      generation,
      `launched ${runtime.spec.product} ${runtime.spec.version}`
    )
    let keys = completedKeys.get(runtime.spec.id)
    if (!keys) {
      keys = new Map()
      completedKeys.set(runtime.spec.id, keys)
    }
    keys.set(idempotencyKey, launch)
    return { ok: true, value: launch }
  }

  /**
   * Recheck the recorded launch identity immediately before any destructive
   * action. Returns the result to surface when the process is gone or was
   * replaced; signals only the still-matching process otherwise.
   */
  async function signalOwnedProcess(
    runtime: ComponentRuntime,
    signalName: 'SIGTERM' | 'SIGKILL'
  ): Promise<SupervisionResult<'signalled' | 'already_gone'>> {
    const launch = runtime.launch
    if (!launch) return fail('invalid_state', `${runtime.spec.id} has no launch record`)
    const current = await adapter.currentIdentity(launch.identity.pid)
    if (!current) return { ok: true, value: 'already_gone' }
    if (!sameIdentity(current, launch.identity)) {
      // A reused PID belongs to someone else: never signal it (TM-004).
      audit(
        'signal',
        runtime.spec.id,
        launch.generation,
        'identity recheck failed; signal withheld'
      )
      return fail(
        'ownership_unproven',
        `${runtime.spec.id} launch identity no longer matches PID ${launch.identity.pid}`
      )
    }
    await adapter.signalIdentity(launch.identity, signalName)
    audit('signal', runtime.spec.id, launch.generation, signalName)
    return { ok: true, value: 'signalled' }
  }

  function completeStop(runtime: ComponentRuntime, detail: string): ExitedRecord {
    const launch = runtime.launch
    runtime.state = 'exited'
    runtime.launch = null
    runtime.drainComplete = false
    runtime.health = 'unknown'
    const exited: ExitedRecord = {
      kind: 'exited',
      at: new Date(now()).toISOString(),
      componentId: runtime.spec.id,
      generation: launch?.generation ?? runtime.generation,
      processRecordId: launch?.processRecordId ?? 'unknown',
      expected: true,
      exitDetail: detail,
    }
    records.append(exited)
    audit('exit', runtime.spec.id, exited.generation, detail)
    return exited
  }

  return {
    async start({ componentId, idempotencyKey }) {
      const runtime = runtimes.get(componentId)
      if (!runtime) return fail('not_found', `unknown component ${componentId}`)
      return startRuntime(runtime, idempotencyKey)
    },

    async reconcile() {
      const latest = new Map<ComponentId, LaunchedRecord>()
      for (const record of records.list()) {
        if (record.kind === 'launched') latest.set(record.componentId, record)
        if (record.kind === 'exited') latest.delete(record.componentId)
      }
      for (const [componentId, record] of latest) {
        const runtime = runtimes.get(componentId)
        if (!runtime) continue
        const current = await adapter.currentIdentity(record.identity.pid)
        if (!current || !sameIdentity(current, record.identity)) {
          audit('adoption', componentId, record.generation, 'persisted launch could not be adopted')
          continue
        }
        runtime.generation = record.generation
        runtime.launch = {
          processRecordId: record.processRecordId,
          componentId,
          generation: record.generation,
          identity: record.identity,
          processGroup: record.processGroup,
          startedAt: record.at,
        }
        runtime.state = 'running'
        runtime.health = 'unknown'
        runtime.lastHeartbeatAt = now()
        audit('adoption', componentId, record.generation, 'persisted launch adopted after restart')
      }
    },

    requestStop(componentId) {
      const runtime = runtimes.get(componentId)
      if (!runtime || !runtime.launch) return fail('not_found', `unknown component ${componentId}`)
      const confirmationId = randomUUID()
      confirmations.set(confirmationId, {
        componentId,
        generation: runtime.generation,
        expiresAt: now() + 60_000,
      })
      return { ok: true, value: { confirmationId, generation: runtime.generation } }
    },

    async stop(componentId, opts) {
      const runtime = runtimes.get(componentId)
      if (!runtime) return fail('not_found', `unknown component ${componentId}`)
      if (
        runtime.state === 'idle' ||
        runtime.state === 'exited' ||
        runtime.state === 'crash_loop'
      ) {
        return fail('already_completed', `${componentId} is not running`)
      }
      if (opts?.generation !== undefined && opts.generation !== runtime.generation) {
        return fail(
          'stale_generation',
          `${componentId} is at generation ${runtime.generation}, not ${opts.generation}`
        )
      }
      if (runtime.state === 'draining' && !runtime.drainComplete) {
        return fail('invalid_state', `${componentId} is draining; its sessions must detach first`)
      }
      if (opts?.confirmationId) {
        const confirmation = confirmations.get(opts.confirmationId)
        confirmations.delete(opts.confirmationId)
        if (
          !confirmation ||
          confirmation.componentId !== componentId ||
          confirmation.generation !== runtime.generation ||
          confirmation.expiresAt < now()
        )
          return fail(
            'confirmation_invalid',
            `${componentId} termination confirmation is invalid or expired`
          )
      }
      const signalled = await signalOwnedProcess(runtime, 'SIGTERM')
      if (signalled.ok && signalled.value === 'signalled' && opts?.escalate) {
        const escalated = await signalOwnedProcess(runtime, 'SIGKILL')
        if (!escalated.ok) return escalated
      }
      if (!signalled.ok) return signalled
      return {
        ok: true,
        value: completeStop(
          runtime,
          signalled.value === 'signalled' ? 'signalled' : 'already gone'
        ),
      }
    },

    async restart(componentId) {
      const runtime = runtimes.get(componentId)
      if (!runtime) return fail('not_found', `unknown component ${componentId}`)
      // An operator restart is the only way out of crash_loop: it keeps the
      // failure history but grants one fresh supervised run.
      runtime.state = runtime.state === 'crash_loop' ? 'exited' : runtime.state
      if (
        runtime.state === 'running' ||
        runtime.state === 'draining' ||
        runtime.state === 'stopping'
      ) {
        const signalled = await signalOwnedProcess(runtime, 'SIGTERM')
        if (!signalled.ok) return signalled
        completeStop(runtime, 'operator restart')
      }
      return startRuntime(runtime, `operator-restart-${now()}`)
    },

    async reportUnexpectedExit(componentId) {
      const runtime = runtimes.get(componentId)
      if (!runtime) return fail('not_found', `unknown component ${componentId}`)
      if (!runtime.launch) return fail('invalid_state', `${componentId} has no running process`)
      return recordUnexpectedExit(runtime)
    },

    async reportUnresponsive(componentId) {
      const runtime = runtimes.get(componentId)
      if (!runtime) return fail('not_found', `unknown component ${componentId}`)
      if (!runtime.launch) return fail('invalid_state', `${componentId} has no running process`)
      const signalled = await signalOwnedProcess(runtime, 'SIGTERM')
      if (signalled.ok && signalled.value === 'signalled') {
        return recordUnexpectedExit(runtime)
      }
      if (signalled.ok) return recordUnexpectedExit(runtime)
      return signalled
    },

    heartbeat(componentId) {
      const runtime = runtimes.get(componentId)
      if (!runtime) return 'unknown'
      runtime.lastHeartbeatAt = now()
      runtime.health = 'healthy'
      return runtime.health
    },

    health(componentId) {
      const runtime = runtimes.get(componentId)
      if (!runtime) return 'unknown'
      return currentHealth(runtime)
    },

    baselineReady() {
      const missing: ComponentId[] = []
      for (const runtime of runtimes.values()) {
        if (!runtime.spec.required) continue
        if (runtime.state !== 'running' || runtime.health === 'unhealthy')
          missing.push(runtime.spec.id)
      }
      return { ready: missing.length === 0, missing }
    },

    evaluateAdoption({ componentId, protocol }) {
      const runtime = runtimes.get(componentId)
      const expected = runtime?.spec.protocol
      if (!runtime || !expected || runtime.state !== 'running') {
        return { decision: 'incompatible', code: 'sidecar_incompatible' as const }
      }
      // The compatibility matrix is by protocol name and major; a same-major
      // difference is a compatible migration that drains, anything else is
      // `sidecar_incompatible` with user remediation (no PID/port fallback).
      if (protocol.name !== expected.name || protocol.major !== expected.major) {
        return { decision: 'incompatible', code: 'sidecar_incompatible' as const }
      }
      if (protocol.minor !== expected.minor) {
        audit('adoption', componentId, runtime.generation, 'protocol drift; drain_upgrade')
        return { decision: 'drain_upgrade' }
      }
      audit('adoption', componentId, runtime.generation, 'protocol match; adopt')
      return { decision: 'adopt' }
    },

    async drain(componentId) {
      const runtime = runtimes.get(componentId)
      if (!runtime) return fail('not_found', `unknown component ${componentId}`)
      if (runtime.state !== 'running') {
        return fail('invalid_state', `${componentId} must be running to enter a drain`)
      }
      runtime.state = 'draining'
      runtime.drainComplete = false
      audit(
        'drain',
        componentId,
        runtime.generation,
        'drain_upgrade: retaining sessions until detached'
      )
      return { ok: true, value: null }
    },

    async sessionsDrained(componentId) {
      const runtime = runtimes.get(componentId)
      if (!runtime) return fail('not_found', `unknown component ${componentId}`)
      if (runtime.state !== 'draining') {
        return fail('invalid_state', `${componentId} is not draining`)
      }
      runtime.drainComplete = true
      audit('drain', componentId, runtime.generation, 'sessions detached; ready for upgrade stop')
      return { ok: true, value: null }
    },

    snapshot() {
      return {
        components: [...runtimes.values()].map((runtime) => ({
          id: runtime.spec.id,
          state: runtime.state,
          health: runtime.health,
          generation: runtime.generation,
          launch: runtime.launch
            ? {
                identity: runtime.launch.identity,
                processGroup: runtime.launch.processGroup,
                startedAt: runtime.launch.startedAt,
              }
            : null,
          manifest: { version: runtime.spec.version, digestSha256: runtime.spec.digestSha256 },
        })),
      }
    },

    audit(): readonly AuditEvent[] {
      return auditRing
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fail<T>(code: SupervisionErrorCode, message: string): SupervisionResult<T> {
  return { ok: false, code, message }
}

function sameIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.pidStartIdentity === b.pidStartIdentity
}

function createInMemoryRecords(): RecordStore {
  const records: Array<LaunchedRecord | ExitedRecord> = []
  return {
    append(record) {
      records.push(record)
    },
    list() {
      return [...records]
    },
    corruptCount() {
      return 0
    },
  }
}
