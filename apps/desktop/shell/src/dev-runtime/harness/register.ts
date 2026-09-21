// Harness runtime registration (#31/#32 substrate, #400 launch orchestration):
// wires the managed-Pi driver, the ACP lane adapter, and the canonical-session
// run operations onto the M10 command registry, and registers the
// `dev.session.events` runtime-events-v1 stream.
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
// - genuine host absence (no managed Pi toolchain/archive, no ACP harness,
//   no launchable default) surfaces as typed contract errors — never a
//   fabricated session or run.
//
// Ownership boundary: this slice owns launch orchestration, status, history,
// and the event stream — never the harness's internal loop. No prompt
// rewriting, no compaction, no tool interception; status transitions are
// applied only from OBSERVED facts carried by the gate or by this register's
// own launch/resume/cancel decisions.
import { randomUUID } from 'node:crypto'

import type { AuthorityAudit } from '../audit'
import { createRuntimeConnectionInventory } from '../discovery/inventory'
import type { ChannelAuthority, ChannelIdentity } from '../channel/authority'
import type { ChannelGateway, StreamProvider } from '../channel/server'
import type {
  AcpConnectionState,
  DevCommand,
  DevError,
  DevOperation,
  HarnessPreference,
  HarnessPreferenceMutableFields,
  HarnessRun,
  HarnessRunState,
  ManagedPiStatus,
  RuntimeEvent,
  RuntimeSession,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders, encodeCbor } from '../../../../../../packages/types/src/dev-runtime'
import {
  createAcpLane,
  type AcpLane,
  type AcpLaneDriver,
  type ResolvedHarnessInstallation,
} from './acp-lane'
import { createSessionEventLog, type SessionEventLog } from './events'
import { createManagedPiDriver, type ManagedPiDriver } from './managed-pi-driver'
import { createHarnessPreferenceAuthority, type HarnessPreferenceAuthority } from './preferences'
import { createRunHistoryStore, type RunHistoryStore } from './runs'
import { RUN_ACTIVE_STATES, RUN_TERMINAL_STATES, canTransitionRun, runEventKind } from './status'

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
  /** Full-duplex gateway; the runtime-events-v1 stream serves through it. */
  gateway?: ChannelGateway
  /** Overrides the managed Pi driver (tests inject scripted archives). */
  managedPi?: ManagedPiDriver
  /**
   * Overrides the DEFAULT managed Pi driver's source chain (tests script
   * archives without replacing the driver). Ignored when `managedPi` is
   * injected — the override belongs to the driver being constructed here.
   */
  managedPiArchiveResolver?: (version: string) => Promise<Uint8Array | null>
  /** Overrides the ACP lane driver (tests inject scripted handshakes). */
  acpDriver?: AcpLaneDriver
  /**
   * #400 residue: guarded PTY prompt delivery (the terminal runtime's input
   * authority). Absent on hosts without a terminal runtime — delivery then
   * records a typed non-delivery instead of pretending the prompt shipped.
   */
  deliverPrompt?: PromptDeliverySeam
  /**
   * #400 residue: harness-in-PTY spawn (the terminal runtime's spawn seam).
   * Spawns the host-resolved harness executable as the PTY child of a new
   * terminal bound to the runtime session and reports the binding. Absent on
   * hosts without a terminal runtime — an `attachTerminal` launch then
   * refuses typed before any run record exists.
   */
  spawnHarnessTerminal?: HarnessPtySpawnSeam
  /**
   * #400 residue: sidecar-OBSERVED terminal terminations. The register
   * derives bound-run status only from these observed facts — a signal is
   * never treated as an exit status, and the register never signals a
   * process the terminal runtime owns.
   */
  observeTerminalExit?: TerminalExitSubscription
  audit?: AuthorityAudit
  now?: () => number
}

/**
 * The terminal runtime's harness-in-PTY spawn verdict. `ok: true` binds the
 * run to the terminal id/generation; `ok: false` is the typed spawn refusal.
 */
export type HarnessPtySpawnResult =
  | Readonly<{ ok: true; terminalId: string; terminalGeneration: number }>
  | Readonly<{ ok: false; code: string; message: string }>

export type HarnessPtySpawnSeam = (request: {
  runtimeSessionId: string
  worktreeId: string
  /** Host-resolved harness executable identity; never renderer-supplied. */
  shell: string
}) => HarnessPtySpawnResult | Promise<HarnessPtySpawnResult>

/** One sidecar-observed terminal termination. `exitCode: null` is a signal. */
export type TerminalExitNotice = Readonly<{
  terminalId: string
  generation: number
  exitCode: number | null
}>

export type TerminalExitSubscription = (cb: (notice: TerminalExitNotice) => void) => () => void

/** A launch's initial-prompt delivery request into the session's PTY. */
export type PromptDeliveryRequest = Readonly<{
  runtimeSessionId: string
  harnessRunId: string
  prompt: string
}>

/**
 * The terminal runtime's delivery verdict (its guarded fenced-write result).
 * `ok: true` carries the fenced-write provenance; `ok: false` is a typed
 * non-delivery the launch transaction records. The register defers to a live
 * ACP lane BEFORE calling the seam — the explicit split: an ACP lane owns the
 * session's structured transport, so its lane adapter delivers the prompt and
 * the host never touches the PTY input stream.
 */
export type PromptDeliveryResult =
  | Readonly<{
      ok: true
      terminalId: string
      terminalGeneration: number
      chunks: number
      bytes: number
    }>
  | Readonly<{ ok: false; code: string; message: string }>

export type PromptDeliverySeam = (
  request: PromptDeliveryRequest
) => PromptDeliveryResult | Promise<PromptDeliveryResult>

export type HarnessRuntimeRegistration = Readonly<{
  commands: readonly DevOperation[]
  managedPi: ManagedPiDriver
  lane: AcpLane
  /** Canonical event log backing dev.session.events (test/ops seam). */
  events: SessionEventLog
  /** Preference authority implementing the root-default policy. */
  preferences: HarnessPreferenceAuthority
  /** Bounded run history store (test/ops seam). */
  history: RunHistoryStore
  /**
   * Ingests shell-bus session facts (dev.session.updated) into the canonical
   * event log so the stream carries the register's session lifecycle too.
   * Harness publishes are emitted, never re-ingested.
   */
  ingestSessionPublish(event: string, payload: unknown): void
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

/**
 * Resolves a harness installation from the substrate's authorities: the
 * managed Pi driver first, then the M10 #30 discovery inventory read (never
 * a re-probe — the inventory read is a pure projection of persisted facts).
 */
type InstallationResolution =
  | { kind: 'managed'; status: ManagedPiStatus }
  | { kind: 'connection'; installation: ResolvedHarnessInstallation }
  | undefined

type ProviderHandler = (
  command: DevCommand,
  identity?: ChannelIdentity
) => unknown | Promise<unknown>

export function registerHarnessRuntime(input: HarnessRuntimeInput): HarnessRuntimeRegistration {
  const now = input.now ?? Date.now
  const managedPi =
    input.managedPi ??
    createManagedPiDriver({
      scope: input.scope,
      dataDir: input.dataDir,
      ...(input.audit ? { audit: input.audit } : {}),
      ...(input.managedPiArchiveResolver
        ? { resolvePinnedArchive: input.managedPiArchiveResolver }
        : {}),
    })
  const lane = createAcpLane({
    scope: input.scope,
    dataDir: input.dataDir,
    driver: input.acpDriver ?? fallbackAcpDriver(),
    ...(input.audit ? { audit: input.audit } : {}),
  })
  // The M10 #30 inventory read is store-backed: read() never probes.
  const inventory = createRuntimeConnectionInventory({ dataDir: input.dataDir, sources: [] })
  const runs = createRunHistoryStore({ dataDir: input.dataDir, scope: input.scope })
  const events = createSessionEventLog({ dataDir: input.dataDir, scope: input.scope })
  const preferences = createHarnessPreferenceAuthority({
    dataDir: input.dataDir,
    scope: input.scope,
    // The root default anchors to the READY managed installation only; a
    // clean desktop without it has no auto-launch candidate at all.
    managedInstallationId: () => {
      const status = managedPi.status()
      return status.state === 'ready' ? status.installationId : undefined
    },
  })

  function iso(): string {
    return new Date(now()).toISOString()
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
        observedAt: iso(),
      } satisfies DevError
    }
    return resolution.installation
  }

  /** Auto-launch guard (spec: a missing, unauthenticated, incompatible, or
   * unhealthy installation is never auto-launched). Explicit selection
   * surfaces the same facts as typed launch refusals. */
  function requireAutoLaunchable(installation: ResolvedHarnessInstallation): void {
    if (installation.auth !== 'ready') {
      throw devError(
        'auth_required',
        `harness authentication is ${installation.auth}; it cannot launch until the owner authorizes it`
      )
    }
    if (installation.health !== 'healthy') {
      throw devError(
        'unavailable',
        `harness health is ${installation.health}; it is never auto-launched in that state`
      )
    }
  }

  function appendEventFact(event: {
    session: RuntimeSession
    harnessRunId?: string
    kind: RuntimeEvent['kind']
    payload?: unknown
    sourceEventId: string
    /** Defaults to workspace_metadata; user-content facts are workspace_private. */
    classification?: RuntimeEvent['classification']
  }): void {
    events.append({
      runtimeSessionId: event.session.id,
      generation: event.session.generation,
      ...(event.harnessRunId !== undefined ? { harnessRunId: event.harnessRunId } : {}),
      kind: event.kind,
      source: 'host',
      confidence: 'authoritative',
      classification: event.classification ?? 'workspace_metadata',
      payload: event.payload ?? {},
      sourceEventId: event.sourceEventId,
    })
  }

  function createRun(params: {
    session: RuntimeSession
    installationId: string
    agentProfileId: string
    agentProfileVersion: number
    modelId?: string
    state: HarnessRunState
    generation: number
    terminalId?: string
    terminalGeneration?: number
  }): HarnessRun {
    if (!Number.isSafeInteger(params.agentProfileVersion) || params.agentProfileVersion < 1) {
      throw devError('invalid_state', 'agentProfileVersion must be a positive version integer')
    }
    const at = iso()
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
      ...(params.terminalId !== undefined && params.terminalGeneration !== undefined
        ? { terminalId: params.terminalId, terminalGeneration: params.terminalGeneration }
        : {}),
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
      observedAt: iso(),
      ...detail,
    })
  }

  /**
   * #400 residue: initial-prompt delivery for a launched run (launch
   * transaction steps 6-7). The transport split is explicit:
   * - a live ACP lane owns the session's structured transport, so the host
   *   hands the prompt to the lane adapter through the typed handoff
   *   (`lane.deliverPrompt`). An accepted handoff records ONE host
   *   `turn.user_input` provenance fact — transport `acp`, the lane's
   *   connection identity/generation and byte count, never the prompt text,
   *   never a harness turn event over the lane's own tier (the harness
   *   fabricates nothing here and the host fabricates nothing there). A
   *   typed lane refusal appends `capability.degraded` naming the reason;
   * - otherwise a PTY-backed launch delivers through the terminal runtime's
   *   fenced input authority exactly once (dedupe key `host:prompt:<runId>`,
   *   and the idempotent-launch early return precedes delivery, so a retry
   *   never re-delivers). Delivery provenance lands as a canonical host
   *   event — `turn.user_input` for the delivered submit (the host performed
   *   this write; it never claims the harness consumed it), or
   *   `capability.degraded` naming the typed reason when nothing shipped.
   *   The prompt text itself stays in the control plane only — the event
   *   payload carries fenced-write provenance, never content.
   * A delivery failure does NOT fail the launch (partial failure retains the
   * terminal/worktree) and never retries blindly.
   */
  async function deliverInitialPrompt(params: {
    session: RuntimeSession
    run: HarnessRun
    prompt: string
  }): Promise<void> {
    const sourceEventId = `host:prompt:${params.run.id}`
    const liveLane = lane.readyFor(params.session.id)
    if (liveLane) {
      let result: Awaited<ReturnType<typeof lane.deliverPrompt>>
      try {
        result = await lane.deliverPrompt({
          acpConnectionId: liveLane.id,
          expectedGeneration: liveLane.generation,
          runtimeSessionId: params.session.id,
          harnessRunId: params.run.id,
          prompt: params.prompt,
        })
      } catch (error) {
        result = {
          ok: false,
          code: 'unavailable',
          message: error instanceof Error ? error.message : 'ACP prompt handoff failed',
        }
      }
      if (result.ok) {
        appendEventFact({
          session: params.session,
          harnessRunId: params.run.id,
          kind: 'turn.user_input',
          classification: 'workspace_private',
          payload: {
            harnessRunId: params.run.id,
            transport: 'acp',
            acpConnectionId: liveLane.id,
            acpConnectionGeneration: liveLane.generation,
            bytes: result.bytes,
            processIdentity: result.processIdentity,
          },
          sourceEventId,
        })
        return
      }
      appendEventFact({
        session: params.session,
        harnessRunId: params.run.id,
        kind: 'capability.degraded',
        payload: {
          harnessRunId: params.run.id,
          transport: 'acp',
          acpConnectionId: liveLane.id,
          reason: `${result.code}: ${result.message}`,
        },
        sourceEventId,
      })
      return
    }
    if (!input.deliverPrompt) {
      appendEventFact({
        session: params.session,
        harnessRunId: params.run.id,
        kind: 'capability.degraded',
        payload: {
          harnessRunId: params.run.id,
          transport: 'pty_input',
          reason: 'no terminal runtime is composed on this host',
        },
        sourceEventId,
      })
      return
    }
    let result: PromptDeliveryResult
    try {
      result = await input.deliverPrompt({
        runtimeSessionId: params.session.id,
        harnessRunId: params.run.id,
        prompt: params.prompt,
      })
    } catch (error) {
      result = {
        ok: false,
        code: 'invalid_state',
        message: error instanceof Error ? error.message : 'prompt delivery failed',
      }
    }
    if (result.ok) {
      appendEventFact({
        session: params.session,
        harnessRunId: params.run.id,
        kind: 'turn.user_input',
        classification: 'workspace_private',
        payload: {
          harnessRunId: params.run.id,
          transport: 'pty_input',
          terminalId: result.terminalId,
          terminalGeneration: result.terminalGeneration,
          chunks: result.chunks,
          bytes: result.bytes,
        },
        sourceEventId,
      })
      return
    }
    appendEventFact({
      session: params.session,
      harnessRunId: params.run.id,
      kind: 'capability.degraded',
      payload: {
        harnessRunId: params.run.id,
        transport: 'pty_input',
        reason: `${result.code}: ${result.message}`,
      },
      sourceEventId,
    })
  }

  /**
   * #400 residue: derives a bound run's status from a sidecar-OBSERVED
   * terminal termination. The first notice naming the bound terminal is the
   * consumed observation (a terminal exits exactly once); notices for other
   * terminals never move the run. The observation is applied only when it
   * carries the bound generation, and never overwrites a terminal state (a
   * cancelled run stays cancelled). The observed exit code maps through the
   * canonical machine: 0 → completed, non-zero → failed, null (signalled) →
   * disconnected — a signal is never treated as an exit status. A mapping
   * that would be an illegal edge (e.g. completed from `starting`) demotes
   * to the always-legal `disconnected`, with the observed code preserved in
   * the transition detail and event payload — never silently rewritten.
   */
  function observeBoundRunExit(run: HarnessRun, session: RuntimeSession): void {
    if (!input.observeTerminalExit || run.terminalId === undefined) return
    const unsubscribe = input.observeTerminalExit((notice: TerminalExitNotice) => {
      // A notice naming another terminal is not this run's process; keep
      // listening. The bound terminal exits exactly once, so the first
      // notice that names it is consumed.
      if (notice.terminalId !== run.terminalId) return
      unsubscribe()
      if (notice.generation !== run.terminalGeneration) return
      const current = runs.get(run.id)
      if (!current || RUN_TERMINAL_STATES.includes(current.state)) return
      const desired: HarnessRunState =
        notice.exitCode === 0 ? 'completed' : notice.exitCode !== null ? 'failed' : 'disconnected'
      const outcome: HarnessRunState = canTransitionRun(current.state, desired)
        ? desired
        : 'disconnected'
      const observedDetail =
        notice.exitCode === null
          ? 'terminal process ended by signal (no exit status observed)'
          : `terminal exit ${notice.exitCode}`
      const detail =
        outcome === desired ? observedDetail : `${observedDetail}; run demoted to disconnected`
      try {
        runs.observe({ runId: run.id, to: outcome, source: 'host', observedAt: iso(), detail })
      } catch {
        return // an illegal edge can no longer be applied; the record stays truthful
      }
      const live = input.resolveSession(session.id) ?? session
      appendEventFact({
        session: live,
        harnessRunId: run.id,
        kind: runEventKind(outcome) ?? 'run.disconnected',
        payload: {
          harnessRunId: run.id,
          terminalId: run.terminalId,
          terminalGeneration: run.terminalGeneration ?? notice.generation,
          exitCode: notice.exitCode,
          detail,
        },
        sourceEventId: `host:run-exit:${run.id}:${notice.generation}`,
      })
      const sessionKind = sessionKindFor(outcome)
      if (sessionKind) {
        appendEventFact({
          session: live,
          harnessRunId: run.id,
          kind: sessionKind,
          payload: { harnessRunId: run.id },
          sourceEventId: `host:session-exit:${run.id}:${notice.generation}`,
        })
      }
      publish('run.status', {
        harnessRunId: run.id,
        runtimeSessionId: session.id,
        from: current.state,
        to: outcome,
      })
    })
  }

  /** The shared launch transaction body for launchHarness/launchDefault:
   * idempotent on a live identical run, fenced to one active run, and
   * emitting the canonical created/starting facts. With the `attachTerminal`
   * intent the harness executable spawns into the session's terminal BEFORE
   * the run record exists (argv pre-`starting`): a failed spawn refuses the
   * launch typed without fabricating a run, and a successful spawn binds the
   * run to the terminal id/generation whose sidecar exit facts drive later
   * status. The optional initial prompt delivers exactly once per run, after
   * the run facts land. */
  async function launchRun(params: {
    session: RuntimeSession
    installationId: string
    agentProfileId: string
    agentProfileVersion: number
    modelId?: string
    initialPrompt?: string
    attachTerminal?: boolean
  }): Promise<HarnessRun> {
    const active = activeRunFor(params.session.id)
    if (
      active &&
      active.installationId === params.installationId &&
      active.agentProfile.id === params.agentProfileId &&
      active.agentProfile.version === params.agentProfileVersion
    ) {
      return active
    }
    if (active) {
      throw devError(
        'invalid_state',
        'a harness run is already active for this session; cancel it before launching another installation'
      )
    }
    const installation = requireLaunchInstallation(params.installationId)
    requireAutoLaunchable(installation)
    // #400 residue: harness-in-PTY spawn (pre-`starting`, pre-record). The
    // argv template is the host-resolved installation executable identity —
    // never renderer input. The terminal runtime owns the process: this
    // register only binds the terminal identity and OBSERVES its exit.
    let spawned: { terminalId: string; terminalGeneration: number } | undefined
    if (params.attachTerminal) {
      if (!input.spawnHarnessTerminal) {
        throw devError(
          'capability_unavailable',
          'no terminal runtime is composed on this host; the harness cannot launch into a terminal'
        )
      }
      const spawn = await input.spawnHarnessTerminal({
        runtimeSessionId: params.session.id,
        worktreeId: params.session.worktreeId,
        shell: installation.executableIdentity,
      })
      if (!spawn.ok) {
        throw devError('spawn_failed', `harness terminal spawn failed: ${spawn.message}`)
      }
      spawned = { terminalId: spawn.terminalId, terminalGeneration: spawn.terminalGeneration }
    }
    const run = createRun({
      session: params.session,
      installationId: params.installationId,
      agentProfileId: params.agentProfileId,
      agentProfileVersion: params.agentProfileVersion,
      ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
      ...(spawned
        ? { terminalId: spawned.terminalId, terminalGeneration: spawned.terminalGeneration }
        : {}),
      state: 'starting',
      generation: 1,
    })
    runs.append(run)
    if (spawned) observeBoundRunExit(run, params.session)
    const nextSession = applySession(params.session, {
      activeHarnessRunId: run.id,
      lifecycle: 'active',
    })
    appendEventFact({
      session: nextSession,
      harnessRunId: run.id,
      kind: 'run.created',
      payload: {
        harnessRunId: run.id,
        installationId: run.installationId,
        agentProfileId: run.agentProfile.id,
        agentProfileVersion: run.agentProfile.version,
        ...(run.modelId !== undefined ? { modelId: run.modelId } : {}),
        ...(spawned
          ? { terminalId: run.terminalId, terminalGeneration: run.terminalGeneration }
          : {}),
      },
      sourceEventId: `host:run-created:${run.id}`,
    })
    appendEventFact({
      session: nextSession,
      harnessRunId: run.id,
      kind: 'run.starting',
      payload: {
        harnessRunId: run.id,
        executableLabel: installation.executableLabel,
        ...(spawned
          ? {
              transport: 'pty_process',
              terminalId: run.terminalId,
              terminalGeneration: run.terminalGeneration,
            }
          : {}),
      },
      sourceEventId: `host:run-starting:${run.id}`,
    })
    appendEventFact({
      session: nextSession,
      harnessRunId: run.id,
      kind: 'session.starting',
      payload: { harnessRunId: run.id },
      sourceEventId: `host:session-starting:${run.id}`,
    })
    // Delivery runs after the run facts land and before the publish, so the
    // stream reads created → starting → (user_input | degraded) as one
    // transaction and Dev/Chat observe the delivery through the same channel.
    if (params.initialPrompt !== undefined && params.initialPrompt.length > 0) {
      await deliverInitialPrompt({ session: nextSession, run, prompt: params.initialPrompt })
    }
    publish('run.created', {
      harnessRunId: run.id,
      runtimeSessionId: nextSession.id,
      generation: nextSession.generation,
    })
    return run
  }

  // ── dev.session.events: the runtime-events-v1 stream ────────────────────
  //
  // The grant is minted through the channel authority against the CALLER'S
  // authenticated identity — bound to channel, scope, resource generation,
  // single-use at attach, and expiring (the browser-frames pattern). The
  // gateway handler replays the bounded window then streams live events;
  // a newer session generation closes the stream `stale_generation`.

  const serveRuntimeEvents: StreamProvider = (stream) => {
    const grant = stream.grant
    if (grant.resource.kind !== 'runtime_session') {
      stream.close('incompatible', 'runtime-events-v1 binds runtime_session resources')
      return
    }
    if (grant.direction !== 'read') {
      stream.close('incompatible', 'runtime-events-v1 is a read-only stream')
      return
    }
    const runtimeSessionId = grant.resource.id
    const generation = grant.resource.generation
    const sendEvent = (event: RuntimeEvent): void => {
      stream.send({
        type: 'data',
        sequence: event.seq,
        bytes: encodeCbor(event),
      })
    }
    // Bounded newest-frame replay: at most the newest 500 events of the
    // granted generation, never older than the requested fromSequence.
    const REPLAY_LIMIT = 500n
    const latest = BigInt(events.latestSequence(runtimeSessionId, generation))
    const requested = BigInt(grant.fromSequence)
    const windowStart = latest >= REPLAY_LIMIT ? (latest - REPLAY_LIMIT + 1n).toString() : '0'
    const from = requested > BigInt(windowStart) ? requested.toString() : windowStart
    for (const event of events.read(runtimeSessionId, {
      fromSequence: from,
      generation,
      limit: 500,
    })) {
      sendEvent(event)
    }
    const unsubscribe = events.subscribe(runtimeSessionId, (event) => {
      if (event.generation > generation) {
        // The session moved on (transfer/resume bumped the generation):
        // grants minted under the old generation are inert, never ambiguous.
        stream.close('stale_generation', 'the runtime session moved to a newer generation')
        return
      }
      if (event.generation < generation) return
      sendEvent(event)
    })
    stream.onClose = unsubscribe
    stream.onFrame = (frame) => {
      if (frame.type !== 'ack') {
        stream.close('incompatible', 'read streams accept only ack frames')
      }
    }
  }

  const providers: Partial<Record<DevOperation, ProviderHandler>> = {
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
      return { items, observedAt: iso() }
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

    // ── #400: harness preferences (root-default policy) ───────────────────
    'dev.harness.preferences': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.harness.preferences'].request(command.body)
      const items = preferences.effective(
        typeof body.projectId === 'string' ? (body.projectId as string) : undefined
      )
      return { items, observedAt: iso() }
    },
    'dev.harness.preferenceUpdate': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.harness.preferenceUpdate'].request(command.body)
      const installationId = body.installationId as string
      const projectId = typeof body.projectId === 'string' ? (body.projectId as string) : undefined
      const expectedVersion = body.expectedVersion as number
      const patch = body.patch as HarnessPreferenceMutableFields
      // The installation must exist on this node: the managed installation
      // once ready, or a discovered inventory entry. Credential values do not
      // exist in the model, so nothing secret can be persisted here.
      const resolution = resolveInstallation(installationId)
      if (!resolution) {
        throw devError('not_found', 'harness installation is not registered on this runtime node')
      }
      const stored = preferences
        .stored()
        .find(
          (record) =>
            record.harnessInstallationId === installationId &&
            (record.projectId ?? undefined) === projectId
        )
      if (stored && stored.version !== expectedVersion) {
        throw {
          code: 'stale_version',
          retryable: false,
          message: `harness preference moved on: version ${stored.version}`,
          currentVersion: stored.version,
        } satisfies DevError
      }
      if (!stored && expectedVersion !== 0) {
        throw {
          code: 'stale_version',
          retryable: false,
          message: 'harness preference does not exist yet; address it as version 0',
          currentVersion: 0,
        } satisfies DevError
      }
      const record: HarnessPreference = {
        scope: input.scope,
        harnessInstallationId: installationId,
        enabled: patch.enabled ?? stored?.enabled ?? true,
        // New records append to the ordering; updates keep their position
        // unless the patch moves them.
        sortKey:
          patch.sortKey ?? stored?.sortKey ?? String(preferences.stored().length).padStart(10, '0'),
        ...(projectId !== undefined ? { projectId } : {}),
        default: patch.default ?? stored?.default ?? false,
        ...(patch.agentProfileId !== undefined
          ? { agentProfileId: patch.agentProfileId }
          : stored?.agentProfileId !== undefined
            ? { agentProfileId: stored.agentProfileId }
            : {}),
        ...(patch.modelId !== undefined
          ? { modelId: patch.modelId }
          : stored?.modelId !== undefined
            ? { modelId: stored.modelId }
            : {}),
        version: (stored?.version ?? 0) + 1,
      }
      preferences.upsert(record)
      publish('preference.updated', {
        harnessInstallationId: installationId,
        ...(projectId !== undefined ? { projectId } : {}),
      })
      return record
    },
    'dev.harness.preferenceReset': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.harness.preferenceReset'].request(command.body)
      preferences.clear(typeof body.projectId === 'string' ? (body.projectId as string) : undefined)
      // Reset-to-discovered: the stored overlay is gone, so the effective
      // projection returns to managed-Pi-first on a clean machine.
      return { items: preferences.effective(), observedAt: iso() }
    },

    // ── Run status/history read model ─────────────────────────────────────
    'dev.harness.runs': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.harness.runs'].request(command.body)
      const limit = Math.min(typeof body.limit === 'number' ? (body.limit as number) : 100, 500)
      const itemsAll = runs
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
      const cursor = typeof body.cursor === 'string' ? (body.cursor as string) : undefined
      const seeked = cursor ? itemsAll.filter((run) => (run.startedAt ?? '') < cursor) : itemsAll
      const items = seeked.slice(0, limit)
      return {
        items,
        observedAt: iso(),
        ...(seeked.length > items.length && items.length > 0
          ? { nextCursor: items[items.length - 1]!.startedAt ?? '' }
          : {}),
      }
    },
    'dev.harness.runStatus': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.harness.runStatus'].request(command.body)
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
      const observedAt = iso()
      const next = runs.observe({
        runId: run.id,
        to: body.state as HarnessRunState,
        source: body.source as RuntimeEvent['source'],
        observedAt,
        ...(typeof body.detail === 'string' ? { detail: body.detail as string } : {}),
      })
      // An idempotent same-state re-observation changes nothing and appends
      // nothing; a real transition surfaces as canonical events so Dev and
      // Chat observe the same fact through the same stream, never through a
      // private side channel.
      if (next.version !== run.version) {
        const kind = runEventKind(next.state)
        if (kind) {
          appendEventFact({
            session,
            harnessRunId: next.id,
            kind,
            payload: {
              harnessRunId: next.id,
              from: run.state,
              to: next.state,
              source: body.source,
            },
            sourceEventId: `host:run-status:${next.id}:${next.version}:${next.state}`,
          })
          const sessionKind = sessionKindFor(next.state)
          if (sessionKind) {
            appendEventFact({
              session,
              harnessRunId: next.id,
              kind: sessionKind,
              payload: { harnessRunId: next.id },
              sourceEventId: `host:session-status:${next.id}:${next.version}:${next.state}`,
            })
          }
        }
        publish('run.status', {
          harnessRunId: next.id,
          runtimeSessionId: session.id,
          from: run.state,
          to: next.state,
        })
      }
      return next
    },

    // ── Canonical-session run operations (launch surface) ─────────────────
    'dev.session.launchHarness': async (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.session.launchHarness'].request(command.body)
      const session = resolveSessionOrThrow(body.runtimeSessionId as string)
      requireSessionResource(command, session)
      requireGeneration(command, session)
      requireLaunchableSession(session)
      return launchRun({
        session,
        installationId: body.harnessInstallationId as string,
        agentProfileId: body.agentProfileId as string,
        agentProfileVersion: body.agentProfileVersion as number,
        ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {}),
        ...(typeof body.initialPrompt === 'string' ? { initialPrompt: body.initialPrompt } : {}),
        ...(body.attachTerminal === true ? { attachTerminal: true } : {}),
      })
    },
    'dev.session.launchDefault': async (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.session.launchDefault'].request(command.body)
      const session = resolveSessionOrThrow(body.runtimeSessionId as string)
      requireSessionResource(command, session)
      requireGeneration(command, session)
      requireLaunchableSession(session)
      // Launch orchestration: project default → global default → managed-Pi
      // root default. An explicit default that names an unlaunchable
      // installation refuses with its typed reason (never silently launches
      // something else); with NO explicit default and no ready managed Pi the
      // typed gap carries the install remediation.
      const resolution = preferences.resolveDefault(session.projectId)
      if (!resolution) {
        throw {
          code: 'capability_unavailable',
          retryable: true,
          message: 'no launchable harness default exists on this runtime node',
          remediation: { action: 'dev.harness.managedPiInstall' },
          observedAt: iso(),
        } satisfies DevError
      }
      const installationId =
        resolution.kind === 'root_default'
          ? managedPi.status().installationId
          : resolution.preference.harnessInstallationId
      if (!installationId) {
        throw {
          code: 'capability_unavailable',
          retryable: true,
          message: 'the managed Pi installation is not ready on this host',
          remediation: { action: 'dev.harness.managedPiInstall' },
          observedAt: iso(),
        } satisfies DevError
      }
      return launchRun({
        session,
        installationId,
        agentProfileId: body.agentProfileId as string,
        agentProfileVersion: body.agentProfileVersion as number,
        // Model precedence: explicit body → preference default → harness's
        // own default (no modelId at all).
        ...((typeof body.modelId === 'string'
          ? { modelId: body.modelId as string }
          : resolution.kind === 'preference' && resolution.preference.modelId !== undefined
            ? { modelId: resolution.preference.modelId }
            : {}) as { modelId?: string }),
        ...(typeof body.initialPrompt === 'string' ? { initialPrompt: body.initialPrompt } : {}),
        ...(body.attachTerminal === true ? { attachTerminal: true } : {}),
      })
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
        runs.observe({
          runId: prior.id,
          to: 'disconnected',
          source: 'host',
          observedAt: iso(),
          detail: 'superseded by resume',
        })
        appendEventFact({
          session: { ...session, generation: session.generation },
          harnessRunId: prior.id,
          kind: 'run.disconnected',
          payload: { harnessRunId: prior.id, reason: 'superseded by resume' },
          sourceEventId: `host:run-resume-disconnect:${prior.id}`,
        })
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
      appendEventFact({
        session: nextSession,
        harnessRunId: run.id,
        kind: 'run.resumed',
        payload: { harnessRunId: run.id, resumedFrom: prior.id },
        sourceEventId: `host:run-resumed:${run.id}`,
      })
      appendEventFact({
        session: nextSession,
        harnessRunId: run.id,
        kind: 'session.resumed',
        payload: { harnessRunId: run.id },
        sourceEventId: `host:session-resumed:${run.id}`,
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
      const observedAt = iso()
      const next = runs.observe({
        runId: run.id,
        to: 'cancelled',
        source: 'host',
        observedAt,
        ...(typeof body.confirmationId === 'string'
          ? { detail: `confirmation ${body.confirmationId as string}` }
          : {}),
      })
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
      appendEventFact({
        session: nextSession,
        harnessRunId: next.id,
        kind: 'run.cancelled',
        payload: { harnessRunId: next.id },
        sourceEventId: `host:run-cancelled:${next.id}:${next.version}`,
      })
      appendEventFact({
        session: nextSession,
        harnessRunId: next.id,
        kind: 'session.cancelled',
        payload: { harnessRunId: next.id },
        sourceEventId: `host:session-cancelled:${next.id}:${next.version}`,
      })
      publish('run.cancelled', {
        harnessRunId: next.id,
        runtimeSessionId: nextSession.id,
        generation: nextSession.generation,
      })
      return next
    },

    // ── dev.session.events: grant minting (the stream attach path) ────────
    'dev.session.events': (command, identity) => {
      requireScope(command)
      const body = devOperationDecoders['dev.session.events'].request(command.body)
      const session = resolveSessionOrThrow(body.runtimeSessionId as string)
      requireSessionResource(command, session)
      // Archived sessions keep their history readable: events are records,
      // not live authority. Only the generation binding must hold.
      if (!identity) {
        throw devError('capability_unavailable', 'channel stream grant unavailable', true)
      }
      return input.authority.mintStreamGrant({
        identity,
        protocol: 'runtime-events-v1',
        scope: command.scope,
        resource: {
          kind: 'runtime_session',
          id: session.id,
          generation: session.generation,
        },
        direction: 'read',
        fromSequence:
          typeof body.fromSequence === 'string' ? (body.fromSequence as string) : undefined,
      })
    },
  }

  for (const [operation, provider] of Object.entries(providers)) {
    input.authority.registerCommandProvider(operation as DevOperation, provider!)
  }

  // The stream is registered only when a gateway can actually serve it:
  // grants are never minted for a stream no handler can attach.
  input.authority.registerStreamProvider('runtime-events-v1')
  input.gateway?.registerStreamHandler('runtime-events-v1', serveRuntimeEvents)

  function ingestSessionPublish(event: string, payload: unknown): void {
    if (event !== 'dev.session.updated') return
    const detail = payload as {
      kind?: string
      runtimeSessionId?: string
      generation?: number
      archived?: boolean
      observedAt?: string
    }
    if (!detail || typeof detail.runtimeSessionId !== 'string') return
    if (detail.kind !== 'session.created') return
    const session = input.resolveSession(detail.runtimeSessionId)
    if (!session || session.archived) return
    appendEventFact({
      session: { ...session, generation: detail.generation ?? session.generation },
      kind: 'session.created',
      payload: { runtimeSessionId: session.id, projectId: session.projectId },
      sourceEventId: `host:session-created:${session.id}`,
      ...(detail.observedAt !== undefined ? { occurredAt: detail.observedAt } : {}),
    })
  }

  return {
    commands: Object.keys(providers) as DevOperation[],
    managedPi,
    lane,
    events,
    preferences,
    history: runs,
    ingestSessionPublish,
  }
}

function sessionKindFor(state: HarnessRunState): RuntimeEvent['kind'] | undefined {
  switch (state) {
    case 'working':
      return 'session.ready'
    case 'completed':
      return 'session.completed'
    case 'failed':
      return 'session.failed'
    case 'cancelled':
      return 'session.cancelled'
    case 'disconnected':
      return 'session.disconnected'
    default:
      return undefined
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
