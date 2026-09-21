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
import type { LaunchedRecord, SupervisionRecord } from '../supervision/records'
import type { Supervisor } from '../supervision/supervisor'
import type { ShellSidecarPlan } from './boot-sidecar-plan'

/** The component the terminal lane runs on (the packaging lane's label). */
export const SIDECAR_COMPONENT_ID = 'dev-runtime-sidecar'

/** Bounded readiness window for the sidecar's endpoint file; a deadline
 *  poll, never a fixed attempt count sized for an idle machine. */
const SIDECAR_READY_TIMEOUT_MS = 20_000
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

/** Waits, inside a bounded deadline window, for the sidecar's endpoint file. */
async function waitForEndpoint(dataDir: string): Promise<boolean> {
  const deadline = Date.now() + SIDECAR_READY_TIMEOUT_MS
  for (;;) {
    if (readEndpointFile(dataDir) !== null) return true
    if (Date.now() >= deadline) return false
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

/**
 * Adopts (starting it when needed) the terminal sidecar for the shell's
 * terminal lane through the existing `adoptSidecar` seam. A packaged boot's
 * spawn belongs to the supervision engine (the packaged adapter command),
 * so the launch journal records it for the next boot's reconcile; a dev
 * run keeps the dev fallback spawn of the source-tree entry. Every failure
 * is typed, and a failed adoption never degrades into a fabricated
 * terminal lane.
 */
export async function adoptShellTerminalSidecar(input: {
  dataDir: string
  scope: SidecarScope
  /** The composed supervision engine; absent on a dev run (no manifest). */
  supervisor?: Supervisor
  /** The resolved sidecar plan (packaged identity, or the dev fallback). */
  plan: ShellSidecarPlan | undefined
}): Promise<ShellSidecarAdoption> {
  if (!input.plan) {
    return failure('unavailable', 'no terminal sidecar plan resolved for this boot')
  }
  let startedBySupervision = false
  if (input.supervisor) {
    const snapshot = input.supervisor
      .snapshot()
      .components.find((component) => component.id === SIDECAR_COMPONENT_ID)
    if (!snapshot) {
      return failure(
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
        return failure(
          started.code === 'crash_loop' ? 'crash_loop' : 'spawn_failed',
          `${SIDECAR_COMPONENT_ID} could not be started: ${started.message}`
        )
      }
      startedBySupervision = true
    }
  } else if (input.plan.mode === 'dev') {
    // Dev fallback: the source-tree entry on the repo toolchain. A packaged
    // boot never spawns here — its spawn is the engine's, and a packaged
    // boot without an engine has no plan to spawn at all.
    input.plan.start(input.dataDir)
  }
  if (!(await waitForEndpoint(input.dataDir))) {
    return failure('timeout', 'the terminal sidecar never published its endpoint file')
  }
  const adopted = await adoptSidecar({
    dataDir: input.dataDir,
    scope: input.scope,
    expectedExecutableIdentity: input.plan.executableIdentity,
    evaluateAdoption: verdictFor(input.supervisor),
    connect: (socketPath) => connectUnixByteDuplex(socketPath),
  })
  if (!adopted.ok) {
    return failure(
      adopted.code === 'sidecar_incompatible' || adopted.code === 'identity_mismatch'
        ? adopted.code
        : 'unavailable',
      adopted.message
    )
  }
  return { ok: true, client: adopted.client, startedBySupervision }
}

let startSequence = 0
