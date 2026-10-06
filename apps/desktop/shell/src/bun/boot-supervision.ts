// Boot-time supervision adoption and the shell terminal lane's sidecar
// adoption (M10 #185 / issue #396). Extracted from the shell entry so the
// boot behaviors stay unit-testable: `bun/index.ts` opens the Electrobun
// window as a constructor side effect and cannot be imported by a test.
//
// Two boot steps, in order:
//  1. `reconcileSupervisionAtBoot` — after the composition holds the one
//     supervision engine, reconcile the durable launch journal: a sidecar
//     launch persisted by a previous app run is ADOPTED through the full
//     ownership re-proof (PID start identity + executable identity + the
//     observable process group; the engine never clobbers a launch it
//     already owns), or journaled as an UNADOPTABLE expected exit so no
//     launch record dangles adoptable forever (spec "Local stack
//     supervision"). A composition without an engine (no component
//     manifest, or no verified scope yet) reconciles nothing.
//  2. `adoptShellTerminalSidecar` — the terminal lane's sidecar through the
//     existing adoption seam: a packaged boot starts the sidecar through
//     the supervision engine (so the launch journal records the spawn) or
//     connects to the launch reconcile just proved; a dev run keeps the dev
//     fallback (the source-tree entry on the repo toolchain). Failure is
//     typed and truthful: the terminal lane stays typed-unavailable, never
//     fabricated.
import type { DevRuntimeHost } from '../dev-runtime'
import type { SidecarClient } from '../dev-runtime/terminal/sidecar/client'
import { readEndpointFile } from '../dev-runtime/terminal/sidecar/endpoint-file'
import {
  SIDECAR_PROTOCOL,
  type SidecarProtocol,
  type SidecarScope,
} from '../dev-runtime/terminal/sidecar/protocol'
import { adoptSidecar, type AdoptionDecision } from '../dev-runtime/terminal/sidecar/adoption'
import { connectUnixByteDuplex } from '../dev-runtime/terminal/sidecar/socket-writer'
import {
  createBootAdoptionJournal,
  type BootAdoptionJournal,
} from '../supervision/boot-diagnostics'
import { observeIdentity } from '../supervision/process-adapter'
import type { LaunchedRecord, SupervisionRecord } from '../supervision/records'
import type { Supervisor } from '../supervision/supervisor'
import type { ShellSidecarPlan } from './boot-sidecar-plan'

/** The component the terminal lane runs on (the packaging lane's label). */
export const SIDECAR_COMPONENT_ID = 'dev-runtime-sidecar'

/**
 * Bounded readiness window for the sidecar's endpoint file; a deadline poll,
 * never a fixed attempt count sized for an idle machine.
 *
 * Sized from measurement (issue #1039 acceptance: "bounded but sufficient for
 * a cold first boot on a loaded host"): the packaged sidecar's publish is
 * process start + a unix bind + one owner-only file write. The startup
 * measurement lane (`apps/desktop/scripts/measure-sidecar-startup.mjs`,
 * darwin-arm64, Bun 1.4.0) puts a cold bundled-entry publish at a ~23ms
 * median, so the 20s window carries ~three orders of magnitude of headroom
 * for a loaded host (page cache misses, first-launch Gatekeeper work) while
 * still bounding how long an unadoptable boot blocks the lane's availability
 * verdict. The window is a bound, not the wait mechanism: the spawn happens
 * after composition, so the wait covers publish latency only.
 */
export const SIDECAR_READY_TIMEOUT_MS = 20_000
const SIDECAR_POLL_STEP_MS = 100

export type BootReconcileComponent = Readonly<{
  componentId: string
  processRecordId: string
  generation: number
  pid: number
}>

export type BootReconcileOutcome =
  | { attempted: false }
  | {
      attempted: true
      /** Persisted launches the engine adopted (ownership re-proven). */
      adopted: readonly BootReconcileComponent[]
      /** Persisted launches journaled as unadoptable expected exits. */
      unadoptable: readonly BootReconcileComponent[]
      /** Persisted launches reconcile skipped (a live launch is already
       *  owned, or the component is not in this bundle's manifest). */
      skipped: readonly string[]
      /** Set when reconciliation itself failed; boot continues truthfully. */
      error?: string
    }

/** The latest launch per component with no later exit (the adoptable set). */
function latestLaunches(records: readonly SupervisionRecord[]): Map<string, LaunchedRecord> {
  const latest = new Map<string, LaunchedRecord>()
  for (const record of records) {
    if (record.kind === 'launched') latest.set(record.componentId, record)
    else latest.delete(record.componentId)
  }
  return latest
}

/**
 * The production boot reconcile (#185): reconciles the composed engine
 * against the persisted launch journal and reports, from durable facts
 * only, which launches were adopted, which were journaled unadoptable, and
 * which reconcile skipped. Never throws — a boot that cannot reconcile logs
 * and continues with the engine's own (unchanged) state.
 */
export async function reconcileSupervisionAtBoot(
  host: Pick<DevRuntimeHost, 'supervision' | 'supervisionRecords'>
): Promise<BootReconcileOutcome> {
  const supervisor = host.supervision
  if (!supervisor) return { attempted: false }
  let before: Map<string, LaunchedRecord>
  try {
    before = latestLaunches(host.supervisionRecords?.list() ?? [])
    await supervisor.reconcile()
  } catch (error) {
    return {
      attempted: true,
      adopted: [],
      unadoptable: [],
      skipped: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const after = host.supervisionRecords?.list() ?? []
  // The snapshot's launch view carries no processRecordId, so the outcome is
  // derived from the engine's own adoption audit (exact reconcile details)
  // joined against the journal — durable facts only.
  const adoptionAudit = supervisor
    .audit()
    .filter((event) => event.kind === 'adoption' && event.generation !== null)
  const adopted: BootReconcileComponent[] = []
  const unadoptable: BootReconcileComponent[] = []
  const skipped: string[] = []
  for (const [componentId, record] of before) {
    const snapshot = supervisor
      .snapshot()
      .components.find((component) => component.id === componentId)
    const engineAdopted = adoptionAudit.some(
      (event) =>
        event.componentId === componentId &&
        event.generation === record.generation &&
        event.detail === 'persisted launch adopted after restart'
    )
    if (
      engineAdopted &&
      snapshot?.state === 'running' &&
      snapshot.launch?.identity.pid === record.identity.pid
    ) {
      adopted.push({
        componentId,
        processRecordId: record.processRecordId,
        generation: record.generation,
        pid: record.identity.pid,
      })
      continue
    }
    const journaledExit = after.some(
      (entry) =>
        entry.kind === 'exited' &&
        entry.componentId === componentId &&
        entry.processRecordId === record.processRecordId &&
        entry.expected
    )
    if (journaledExit) {
      unadoptable.push({
        componentId,
        processRecordId: record.processRecordId,
        generation: record.generation,
        pid: record.identity.pid,
      })
      continue
    }
    skipped.push(componentId)
  }
  return { attempted: true, adopted, unadoptable, skipped }
}

export type ShellSidecarAdoption =
  | { ok: true; client: SidecarClient; startedBySupervision: boolean }
  | {
      ok: false
      code:
        | 'spawn_failed'
        | 'crash_loop'
        | 'sidecar_incompatible'
        | 'identity_mismatch'
        | 'unavailable'
        | 'timeout'
      message: string
    }

/** Waits, inside a bounded deadline window, for the sidecar's endpoint file.
 *  Returns the observed wait in milliseconds, or null when the deadline
 *  passed unpublished (the adoption journal records the real cost). */
async function waitForEndpoint(dataDir: string, timeoutMs: number): Promise<number | null> {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  for (;;) {
    if (readEndpointFile(dataDir) !== null) return Date.now() - startedAt
    if (Date.now() >= deadline) return null
    await new Promise<void>((resolve) => setTimeout(resolve, SIDECAR_POLL_STEP_MS))
  }
}

/** The adoption verdict source: the composed engine owns it (#185); a dev
 *  fallback applies the same name-and-major gate against the sidecar's wire
 *  protocol constant. */
function verdictFor(
  supervisor: Supervisor | undefined
): (protocol: SidecarProtocol) => AdoptionDecision {
  if (!supervisor) {
    return (protocol) =>
      protocol.name === SIDECAR_PROTOCOL.name && protocol.major === SIDECAR_PROTOCOL.major
        ? 'adopt'
        : 'incompatible'
  }
  return (protocol) => {
    const verdict = supervisor.evaluateAdoption({
      componentId: SIDECAR_COMPONENT_ID,
      protocol,
    })
    return verdict.decision === 'incompatible' ? 'incompatible' : verdict.decision
  }
}

function failure(
  code:
    | 'spawn_failed'
    | 'crash_loop'
    | 'sidecar_incompatible'
    | 'identity_mismatch'
    | 'unavailable'
    | 'timeout',
  message: string
): ShellSidecarAdoption {
  return { ok: false, code, message }
}

/** The sidecar child's fate when the endpoint never published — the fact
 *  that names the failing step (#1039). A dev-fallback child reports its
 *  exit code (Bun exits 1 immediately on an unloadable entry); an
 *  engine-spawned child reports its OS observability. */
function unpublishedChildFate(
  child: Bun.Subprocess | undefined,
  supervisor: Supervisor | undefined
): string {
  if (child) {
    if (child.exitCode !== null) {
      return `the spawn (pid ${child.pid}) exited with code ${child.exitCode} before publishing`
    }
    if (child.signalCode !== null) {
      return `the spawn (pid ${child.pid}) was killed by signal ${child.signalCode} before publishing`
    }
    return `the spawn (pid ${child.pid}) is still running without publishing`
  }
  if (supervisor) {
    const snapshot = supervisor
      .snapshot()
      .components.find((component) => component.id === SIDECAR_COMPONENT_ID)
    const pid = snapshot?.launch?.identity.pid
    if (pid === undefined) return 'the engine holds no launch record for the sidecar'
    return observeIdentity(pid) === null
      ? `the engine-spawned sidecar (pid ${pid}) is no longer observable — it exited`
      : `the engine-spawned sidecar (pid ${pid}) is observable but never published`
  }
  return 'no spawn was attempted'
}

/**
 * Adopts (starting it when needed) the terminal sidecar for the shell's
 * terminal lane through the existing `adoptSidecar` seam. A packaged boot's
 * spawn belongs to the supervision engine (the packaged adapter command),
 * so the launch journal records it for the next boot's reconcile; a dev
 * run keeps the dev fallback spawn of the source-tree entry. Every failure
 * is typed, and a failed adoption never degrades into a fabricated
 * terminal lane.
 *
 * #1039: every attempt is recorded in the durable boot-adoption journal
 * (`<dataDir>/dev-runtime/supervision/boot-adoption.jsonl`) — the spawn's
 * argv/environment keys/cwd/pid, the child's exit, the publish watch, and
 * the outcome — and a publish timeout names the failing step in its
 * message, because a GUI launch surfaces no console output at all.
 */
export async function adoptShellTerminalSidecar(input: {
  dataDir: string
  scope: SidecarScope
  /** The composed supervision engine; absent on a dev run (no manifest). */
  supervisor?: Supervisor
  /** The resolved sidecar plan (packaged identity, or the dev fallback). */
  plan: ShellSidecarPlan | undefined
  /** Test/ops override of the bounded readiness window; production uses
   *  the measured `SIDECAR_READY_TIMEOUT_MS`. */
  readyTimeoutMs?: number
}): Promise<ShellSidecarAdoption> {
  const journal: BootAdoptionJournal = createBootAdoptionJournal(input.dataDir)
  const readyTimeoutMs = input.readyTimeoutMs ?? SIDECAR_READY_TIMEOUT_MS
  if (!input.plan) {
    journal.append({
      kind: 'adoption-outcome',
      at: new Date().toISOString(),
      ok: false,
      code: 'unavailable',
      detail: 'no terminal sidecar plan resolved for this boot',
    })
    return failure('unavailable', 'no terminal sidecar plan resolved for this boot')
  }
  journal.append({
    kind: 'adoption-attempt',
    at: new Date().toISOString(),
    mode: input.plan.mode,
    supervisorPresent: Boolean(input.supervisor),
    executableIdentity: input.plan.executableIdentity,
  })
  let startedBySupervision = false
  let devChild: Bun.Subprocess | undefined
  if (input.supervisor) {
    const snapshot = input.supervisor
      .snapshot()
      .components.find((component) => component.id === SIDECAR_COMPONENT_ID)
    if (!snapshot) {
      return journaledFailure(
        journal,
        'unavailable',
        `${SIDECAR_COMPONENT_ID} is not in the composed component manifest`
      )
    }
    if (snapshot.state !== 'running') {
      // The engine spawns the packaged sidecar through its process adapter
      // and journals the launch; the endpoint file is its readiness marker.
      const started = await input.supervisor.start({
        componentId: SIDECAR_COMPONENT_ID,
        idempotencyKey: `shell-boot-${Date.now()}-${(startSequence += 1)}`,
      })
      if (!started.ok) {
        return journaledFailure(
          journal,
          started.code === 'crash_loop' ? 'crash_loop' : 'spawn_failed',
          `${SIDECAR_COMPONENT_ID} could not be started: ${started.message}`
        )
      }
      startedBySupervision = true
    }
  } else if (input.plan.mode === 'dev') {
    // Dev fallback: the source-tree entry on the repo toolchain. A packaged
    // boot never spawns here — its spawn is the engine's, and a packaged
    // boot without an engine has no plan to spawn at all. The seam journals
    // the spawn (facts declared by the plan) and the child's exit; the
    // engine-spawned path is journaled by the process adapter the same way.
    const facts = input.plan.spawnFacts(input.dataDir)
    const child = input.plan.start(input.dataDir)
    if (child) {
      devChild = child
      const spawnedAt = Date.now()
      journal.append({
        kind: 'spawn',
        at: new Date(spawnedAt).toISOString(),
        mode: 'dev-fallback',
        pid: child.pid,
        argv: facts.argv,
        envKeys: facts.envKeys,
        cwd: facts.cwd,
      })
      const exited: Promise<number> | undefined = (child as { exited?: Promise<number> }).exited
      if (exited) {
        void exited
          .then((exitCode) => {
            journal.append({
              kind: 'spawn-exit',
              at: new Date().toISOString(),
              pid: child.pid,
              exitCode: typeof exitCode === 'number' ? exitCode : null,
              afterMs: Date.now() - spawnedAt,
            })
          })
          .catch(() => {})
      }
    }
  }
  const waitedMs = await waitForEndpoint(input.dataDir, readyTimeoutMs)
  if (waitedMs === null) {
    const fate = unpublishedChildFate(devChild, input.supervisor)
    journal.append({
      kind: 'endpoint-watch',
      at: new Date().toISOString(),
      found: false,
      waitedMs: readyTimeoutMs,
      detail: fate,
    })
    return failure(
      'timeout',
      `the terminal sidecar never published its endpoint file (watched ${(
        readyTimeoutMs / 1000
      ).toFixed(1)}s; ${fate}; adoption journal: ${journal.path()})`
    )
  }
  journal.append({
    kind: 'endpoint-watch',
    at: new Date().toISOString(),
    found: true,
    waitedMs,
  })
  const adopted = await adoptSidecar({
    dataDir: input.dataDir,
    scope: input.scope,
    expectedExecutableIdentity: input.plan.executableIdentity,
    evaluateAdoption: verdictFor(input.supervisor),
    connect: (socketPath) => connectUnixByteDuplex(socketPath),
  })
  if (!adopted.ok) {
    return journaledFailure(
      journal,
      adopted.code === 'sidecar_incompatible' || adopted.code === 'identity_mismatch'
        ? adopted.code
        : 'unavailable',
      adopted.message
    )
  }
  journal.append({
    kind: 'adoption-outcome',
    at: new Date().toISOString(),
    ok: true,
    detail: `adopted the ${input.plan.mode} sidecar after a ${waitedMs}ms publish wait`,
  })
  return { ok: true, client: adopted.client, startedBySupervision }
}

/** Records a failed outcome in the boot-adoption journal, then returns it. */
function journaledFailure(
  journal: BootAdoptionJournal,
  code:
    | 'spawn_failed'
    | 'crash_loop'
    | 'sidecar_incompatible'
    | 'identity_mismatch'
    | 'unavailable',
  message: string
): ShellSidecarAdoption {
  journal.append({
    kind: 'adoption-outcome',
    at: new Date().toISOString(),
    ok: false,
    code,
    detail: message,
  })
  return failure(code, message)
}

let startSequence = 0
