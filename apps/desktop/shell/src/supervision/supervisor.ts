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
// The engine's exit/unhealthy observations also surface as typed
// `SupervisionEvent`s through an optional (late-attachable) sink — the live
// shell-event surface over the durable journal, bounded per component and
// kind so a crash storm cannot flood the event stream.
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
  | 'stop_unconfirmed'

export type SupervisionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SupervisionErrorCode; message: string }

/** What the OS reports for a PID right now. `processGroup` is optional
 *  because not every platform probe can observe group membership; when it is
 *  present it joins the ownership proof. */
export type CurrentProcessIdentity = ProcessIdentity & { processGroup?: string }

export type SupervisionAdapter = {
  spawn(
    spec: ComponentSpec,
    generation: number
  ): Promise<{ identity: ProcessIdentity; processGroup: string }>
  /** Current OS identity for a PID, or null when nothing lives there. */
  currentIdentity(pid: number): Promise<CurrentProcessIdentity | null>
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

/**
 * A live supervision observation: the typed shell-event surface over the
 * engine's exit/unhealthy decisions (issue #185 follow-up). Every field is an
 * engine-authored fact — component id, generation, PID, ISO timestamp, and
 * the same bounded detail strings the audit ring carries — so the payload is
 * secret-free by construction and safe on the wire. Events are the LIVE
 * surface only: the durable launch/exit journal and the audit ring record
 * every decision regardless of emission.
 *
 * `suppressed` is the crash-storm bound's coalescing counter: the number of
 * events of the same component AND kind that were dropped from this live
 * surface since the previous emitted one (see the emission bound below). A
 * consumer that receives `suppressed > 0` reconciles from the snapshot and
 * the journal, which never elide anything.
 */
export type SupervisionEvent =
  | {
      kind: 'exit'
      at: string
      componentId: ComponentId
      generation: number
      processRecordId: string
      /** false = crash or external kill; true = operator/upgrade stop or a
       *  persisted launch proven unadoptable at reconcile. */
      expected: boolean
      exitDetail: string
      suppressed: number
    }
  | {
      kind: 'start'
      at: string
      componentId: ComponentId
      generation: number
      pid: number
      processRecordId: string
      /** `start` = boot/explicit start, `restart` = operator restart,
       *  `auto-restart` = the engine's crash-policy replacement. */
      cause: 'start' | 'restart' | 'auto-restart'
      suppressed: number
    }
  | {
      kind: 'crash_loop'
      at: string
      componentId: ComponentId
      generation: number
      failuresInWindow: number
      suppressed: number
    }
  | {
      kind: 'unhealthy'
      at: string
      componentId: ComponentId
      generation: number
      detail: string
      suppressed: number
    }

/**
 * The crash-storm bound on the LIVE event surface (issue #185 follow-up; the
 * durable journal and audit ring are unaffected). Per component AND per event
 * kind, at most `SUPERVISION_EVENT_MAX_PER_KIND` emissions per sliding
 * `SUPERVISION_EVENT_WINDOW_MS`; anything beyond is coalesced — dropped from
 * the live surface, counted, and surfaced as `suppressed` on that component
 * and kind's next emitted event. The numbers are aligned with the engine's
 * own restart policy (5 failures / 10 minutes bounds one crash episode to 5
 * exits + 5 replacement starts), so an engine-native crash storm is never
 * coalesced; any emission source FASTER than the policy — a watcher hammering
 * unresponsive recycles, a scripted operator restart loop — is capped at the
 * numbers below per component and kind, and can never flood the event stream.
 */
export const SUPERVISION_EVENT_WINDOW_MS = 60_000
export const SUPERVISION_EVENT_MAX_PER_KIND = 5

/** How the launched generation came about (the `start` event's `cause`). */
export type SupervisionStartCause = 'start' | 'restart' | 'auto-restart'

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
  /**
   * Attaches (or with `undefined` detaches) the live-event sink. The sink is
   * called synchronously inside engine decisions with a typed
   * {@link SupervisionEvent}; it must never throw (a throwing sink is the
   * caller's bug and would surface inside the engine action) and it must not
   * re-enter the engine. Production attaches the shell event bus after the
   * composition holds the engine; before any sink is attached events are
   * simply not emitted (the journal and audit ring still record everything).
   */
  setEventSink(sink: ((event: SupervisionEvent) => void) | undefined): void
}

export function createSupervisor(input: {
  manifest: ComponentManifest
  adapter: SupervisionAdapter
  records?: RecordStore
  now?: () => number
  /** Grace window after SIGTERM before escalation is considered (deterministic
   *  against the injected clock; production uses the real clock). */
  stopGraceMs?: number
  /** Grace window after SIGKILL before the stop is reported unconfirmed. */
  killGraceMs?: number
  /** Delay between termination observation probes. */
  terminationProbeDelayMs?: number
  /** Test seam for the probe delay; production sleeps for real. */
  delay?: (ms: number) => Promise<void>
  /** Live-event sink (see `setEventSink`); absent constructs the engine
   *  without emission until a sink is attached. */
  onEvent?: (event: SupervisionEvent) => void
}): Supervisor {
  const now = input.now ?? Date.now
  const records: RecordStore = input.records ?? createInMemoryRecords()
  const adapter = input.adapter
  const stopGraceMs = input.stopGraceMs ?? 5_000
  const killGraceMs = input.killGraceMs ?? 2_000
  const probeDelayMs = input.terminationProbeDelayMs ?? 100
  const delay =
    input.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

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

  // Live-event surface (issue #185 follow-up): the sink is optional and
  // late-attachable (the composition attaches the shell event bus after the
  // host construction returns). Emission is bounded per component and kind —
  // SUPERVISION_EVENT_MAX_PER_KIND per SUPERVISION_EVENT_WINDOW_MS on the
  // injected clock — with the coalesced count surfaced on the next emitted
  // event. The journal and audit ring never see this bound.
  let eventSink: ((event: SupervisionEvent) => void) | undefined = input.onEvent
  const eventWindows = new Map<string, number[]>()
  const eventSuppressed = new Map<string, number>()

  function emitEvent(event: SupervisionEvent): void {
    const sink = eventSink
    if (!sink) return
    const key = `${event.componentId}\u0000${event.kind}`
    const horizon = now() - SUPERVISION_EVENT_WINDOW_MS
    const window = (eventWindows.get(key) ?? []).filter((at) => at >= horizon)
    if (window.length >= SUPERVISION_EVENT_MAX_PER_KIND) {
      eventSuppressed.set(key, (eventSuppressed.get(key) ?? 0) + 1)
      return
    }
    window.push(now())
    eventWindows.set(key, window)
    const suppressed = eventSuppressed.get(key) ?? 0
    eventSuppressed.set(key, 0)
    sink(suppressed > 0 ? { ...event, suppressed } : event)
  }

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
    emitEvent({
      kind: 'crash_loop',
      at: new Date(now()).toISOString(),
      componentId: runtime.spec.id,
      generation: runtime.generation,
      failuresInWindow: runtime.failures.length,
      suppressed: 0,
    })
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
      emitEvent({
        kind: 'exit',
        at: exited.at,
        componentId: runtime.spec.id,
        generation: exited.generation,
        processRecordId: exited.processRecordId,
        expected: false,
        exitDetail: exited.exitDetail,
        suppressed: 0,
      })
    }
    runtime.failures.push(now())
    pruneFailures(runtime)
    if (runtime.failures.length >= CRASH_LOOP_MAX_FAILURES) {
      enterCrashLoop(runtime)
      return { ok: true, value: 'crash_loop' }
    }
    const restarted = await startRuntime(
      runtime,
      `auto-restart-${runtime.generation + 1}-${now()}`,
      'auto-restart'
    )
    if (!restarted.ok) return restarted
    return { ok: true, value: 'restarted' }
  }

  async function startRuntime(
    runtime: ComponentRuntime,
    idempotencyKey: string,
    cause: SupervisionStartCause
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
    emitEvent({
      kind: 'start',
      at: launch.startedAt,
      componentId: launch.componentId,
      generation: launch.generation,
      pid: launch.identity.pid,
      processRecordId: launch.processRecordId,
      cause,
      suppressed: 0,
    })
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
    if (!launchIdentityMatches(current, launch)) {
      // A reused PID or a replaced executable belongs to someone else: never
      // signal it (TM-004).
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

  /**
   * Bounded wait for OBSERVED termination: the PID either holds nothing or
   * holds a different identity (ours exited, the PID moved on). A deadline on
   * the injected clock keeps this deterministic; the probe delay is a real
   * (injectable) sleep so a dead process needs no wait at all.
   */
  async function awaitObservedExit(
    launch: LaunchRecordPublic,
    graceMs: number
  ): Promise<'gone' | 'alive'> {
    const deadline = now() + graceMs
    for (;;) {
      const current = await adapter.currentIdentity(launch.identity.pid)
      if (!current || !launchIdentityMatches(current, launch)) return 'gone'
      if (now() >= deadline) return 'alive'
      await delay(probeDelayMs)
    }
  }

  /**
   * Signal, then wait for observed termination inside a bounded window,
   * escalating to SIGKILL when the graceful window expires. The launch record
   * and `stopping` state survive until termination is observed: a process is
   * never declared exited (and no replacement is ever started) while it may
   * still be alive. An unconfirmed stop returns `stop_unconfirmed` with the
   * record intact so a later exit event or operator retry reconciles truth.
   */
  async function terminateAndObserve(
    runtime: ComponentRuntime,
    opts?: { escalate?: boolean }
  ): Promise<SupervisionResult<{ escalated: boolean; alreadyGone: boolean }>> {
    const signalled = await signalOwnedProcess(runtime, 'SIGTERM')
    if (!signalled.ok) return signalled
    const launch = runtime.launch
    if (!launch) return fail('invalid_state', `${runtime.spec.id} has no launch record`)
    if (signalled.value === 'already_gone') {
      return { ok: true, value: { escalated: false, alreadyGone: true } }
    }
    runtime.state = 'stopping'
    if ((await awaitObservedExit(launch, stopGraceMs)) === 'gone') {
      return sameLaunch(runtime, launch)
        ? { ok: true, value: { escalated: false, alreadyGone: false } }
        : fail('invalid_state', `${runtime.spec.id} launch moved while the stop was observed`)
    }
    if (opts?.escalate) {
      const killed = await signalOwnedProcess(runtime, 'SIGKILL')
      if (!killed.ok) return killed
      if (
        killed.value === 'already_gone' ||
        (await awaitObservedExit(launch, killGraceMs)) === 'gone'
      ) {
        return sameLaunch(runtime, launch)
          ? { ok: true, value: { escalated: true, alreadyGone: false } }
          : fail('invalid_state', `${runtime.spec.id} launch moved while the stop was observed`)
      }
    }
    return {
      ok: false,
      code: 'stop_unconfirmed',
      message: `${runtime.spec.id} did not exit within the termination window; the launch record is retained and the component stays stopping`,
    }
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
    emitEvent({
      kind: 'exit',
      at: exited.at,
      componentId: runtime.spec.id,
      generation: exited.generation,
      processRecordId: exited.processRecordId,
      expected: true,
      exitDetail: detail,
      suppressed: 0,
    })
    return exited
  }

  return {
    async start({ componentId, idempotencyKey }) {
      const runtime = runtimes.get(componentId)
      if (!runtime) return fail('not_found', `unknown component ${componentId}`)
      return startRuntime(runtime, idempotencyKey, 'start')
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
        // Never clobber a launch this supervisor already owns (an eager
        // restart may have raced the reconciliation).
        if (runtime.state !== 'idle' || runtime.launch) {
          audit(
            'adoption',
            componentId,
            record.generation,
            'adoption skipped: a live launch record is already owned'
          )
          continue
        }
        const current = await adapter.currentIdentity(record.identity.pid)
        if (!current || !launchIdentityMatches(current, record)) {
          // The persisted process is provably gone: journal the exit so the
          // launch record cannot dangle as adoptable forever. `expected`
          // keeps an app restart from counting as a component crash.
          records.append({
            kind: 'exited',
            at: new Date(now()).toISOString(),
            componentId,
            generation: record.generation,
            processRecordId: record.processRecordId,
            expected: true,
            exitDetail: 'not observable after supervisor restart',
          })
          audit('adoption', componentId, record.generation, 'persisted launch could not be adopted')
          emitEvent({
            kind: 'exit',
            at: new Date(now()).toISOString(),
            componentId,
            generation: record.generation,
            processRecordId: record.processRecordId,
            expected: true,
            exitDetail: 'not observable after supervisor restart',
            suppressed: 0,
          })
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
      // Termination is observed, not assumed: the exit record is written only
      // after the PID provably no longer holds our identity, with SIGKILL
      // escalation inside the bounded window when `escalate` is set.
      const outcome = await terminateAndObserve(runtime, { escalate: opts?.escalate })
      if (!outcome.ok) {
        audit(
          'signal',
          runtime.spec.id,
          runtime.generation,
          'stop unconfirmed; launch record retained'
        )
        return outcome
      }
      return {
        ok: true,
        value: completeStop(
          runtime,
          outcome.value.alreadyGone
            ? 'already gone'
            : outcome.value.escalated
              ? 'signalled (SIGTERM + SIGKILL); exit observed'
              : 'signalled; exit observed'
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
        // The replacement starts only after the old process is observed gone;
        // an unconfirmed stop refuses the restart instead of overlapping.
        const outcome = await terminateAndObserve(runtime, { escalate: true })
        if (!outcome.ok) return outcome
        completeStop(
          runtime,
          outcome.value.alreadyGone ? 'already gone' : 'signalled; exit observed (operator restart)'
        )
      }
      return startRuntime(runtime, `operator-restart-${now()}`, 'restart')
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
      // The unhealthy observation is itself an event: consumers see the
      // recycle decision before the exit it produces (signal, escalate inside
      // the bounded window, count the failure once the process provably
      // exited).
      emitEvent({
        kind: 'unhealthy',
        at: new Date(now()).toISOString(),
        componentId: runtime.spec.id,
        generation: runtime.generation,
        detail: 'unresponsive observation; recycle scheduled',
        suppressed: 0,
      })
      const outcome = await terminateAndObserve(runtime, { escalate: true })
      if (!outcome.ok) return outcome
      return recordUnexpectedExit(runtime)
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
        // Readiness derives health from the probe window at decision time; a
        // stored 'healthy' from an earlier heartbeat never satisfies it.
        if (runtime.state !== 'running' || currentHealth(runtime) === 'unhealthy')
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
          // Derived at read time so a snapshot never reports a stale probe.
          health: currentHealth(runtime),
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

    setEventSink(sink) {
      eventSink = sink
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

/** The observation is only valid for the launch it waited on: an exit event
 *  or adoption that replaced the launch mid-stop invalidates it. */
function sameLaunch(runtime: ComponentRuntime, launch: LaunchRecordPublic): boolean {
  return runtime.launch === launch
}

/**
 * Full ownership proof before a signal or an adoption: PID start identity
 * rules out a reused PID, the executable identity rules out a replaced
 * artifact at the same start identity, and an observable process group must
 * still be the launched group.
 */
function launchIdentityMatches(
  current: CurrentProcessIdentity,
  expected: { identity: ProcessIdentity; processGroup: string }
): boolean {
  if (!sameIdentity(current, expected.identity)) return false
  if (current.executableIdentity !== expected.identity.executableIdentity) return false
  if (current.processGroup !== undefined && current.processGroup !== expected.processGroup)
    return false
  return true
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
