// Production registrar for the #424 runtime resource surface: process/port/
// metrics/retained-data/usage listing plus the SAFE stop path.
//
// Ownership bar (spec "Process, port, metrics, and usage"): a process is
// listed as Adea-owned — and therefore stoppable — only when a durable launch
// record exists AND the live supervision snapshot still matches it (component,
// generation, PID, PID start identity, executable identity). OS inspection
// never grants authority; unknown listeners are `unknown` and carry no stop
// path. Every destructive operation is a plan/commit pair bound to the
// envelope resource `{kind:'process', id: processRecordId, generation}`; the
// commit re-checks the binding, the live generation, and the plan digest, and
// then goes through the supervision engine's own public API — the engine
// re-proves the launch identity immediately before any signal (TM-004). This
// module never signals a PID directly and never inspects processes to decide
// ownership.
//
// The supervision engine is consumed read-only (snapshot + the shared durable
// record journal) through a narrow structural view; when no engine is bound
// the listing surfaces truthful emptiness and stop fails closed with
// `capability_unavailable`.
import { createHash, randomUUID } from 'node:crypto'

import type {
  DevCommand,
  DevError,
  DevOperation,
  DevRuntimePage,
  MutationPlan,
  PortRecord,
  ProcessRecord,
  ResourcePreferencesInput,
  RetainedDataRecord,
  ResourceSnapshot,
  Scope,
  UsageRecord,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import type { ChannelAuthority } from '../channel/authority'
import type { ExitedRecord, ProcessIdentity, SupervisionRecord } from '../../supervision/records'
import type {
  ComponentState,
  SupervisionResult,
  SupervisionSnapshot,
} from '../../supervision/supervisor'
import type { UsageService } from '../usage/service'
import type { ForeignStopAuthority } from './foreign-stop'
import type { MachineInventory } from './machine-inventory'
import { createMetricsHistory, type MetricsHistory, type ResourceSample } from './metrics'
import { createMemoryResourcePreferenceStore, type ResourcePreferenceStore } from './preferences'
import type { WorktreeStorage } from './worktree-storage'

const PLAN_TTL_MS = 10 * 60_000
/** Exited launch records stay visible (as `exited`) for this window. */
const EXITED_VISIBLE_MS = 60 * 60_000

/** Narrow read-only view of the supervision engine this registrar needs. The
 * production composition passes the real supervisor; tests script this. */
export type ResourcesSupervisionView = Readonly<{
  snapshot(): SupervisionSnapshot
  requestStop(
    componentId: string
  ): SupervisionResult<{ confirmationId: string; generation: number }>
  stop(
    componentId: string,
    opts?: { generation?: number; confirmationId?: string; escalate?: boolean }
  ): Promise<SupervisionResult<ExitedRecord>>
  /** Stops the component (re-proving its identity) and relaunches it from its
   * manifest command as a new generation. Absent: restart is unavailable. */
  restart?(componentId: string): Promise<SupervisionResult<unknown>>
}>

export type ResourceOwnerBinding = Readonly<{
  ownerKind: ProcessRecord['ownerKind']
  ownerId: string
  runtimeSessionId?: string
  worktreeId?: string
}>

/** Port-inventory seam (#422 surface, consumed read-only). */
export type ResourcePortSource = Readonly<{
  snapshot(): Promise<{
    ports: readonly PortRecord[]
    observedAt: string
  }>
}>

export type RegisterResourcesRuntimeInput = {
  authority: ChannelAuthority
  scope: Scope
  supervision?: ResourcesSupervisionView
  /** The same durable journal the supervision engine appends to; inventory
   * entries are proven from it (launch + exit records). */
  supervisionRecords?: { list(): readonly SupervisionRecord[] }
  /** Loopback port projection (the #422 inventory). */
  ports?: ResourcePortSource
  /** Retained-data breakdown source (terminal/checkpoint/template caches…);
   * absent stays an empty, truthful breakdown. */
  retainedData?: () => readonly RetainedDataRecord[]
  /** Usage adapter cache; absent stays an empty, truthful listing. */
  usage?: UsageService
  /** Maps a supervised component onto its project/session/worktree owner. */
  resolveOwner?: (componentId: string) => ResourceOwnerBinding | undefined
  /** Samples OS metrics for the given PIDs (bounded, pull-based). Failures
   * leave the metric history empty — never fabricated zeros. */
  sampleProcesses?: (
    pids: readonly number[]
  ) => Promise<readonly ResourceSample[]> | readonly ResourceSample[]
  metrics?: MetricsHistory
  /** Machine-wide foreign inventory (`machine` coverage); absent lists none. */
  machine?: MachineInventory
  /** The user-confirmed foreign stop path; absent fails closed. */
  foreignStop?: ForeignStopAuthority
  /** Lazy per-worktree disk measurement; absent lists nothing. */
  worktreeStorage?: WorktreeStorage
  /** Resource settings; absent keeps defaults and refuses updates. */
  preferences?: ResourcePreferenceStore
  now?: () => number
  randomId?: () => string
}

type SupervisionComponent = SupervisionSnapshot['components'][number]

type ProvenLaunch = {
  processRecordId: string
  componentId: string
  generation: number
  identity: ProcessIdentity
  processGroup: string
  startedAt: string
  exited: { at: string; expected: boolean } | undefined
}

type RestartPlanEntry = {
  plan: MutationPlan
  componentId: string
  processRecordId: string
  identity: ProcessIdentity
  boundGeneration: number
  expiresAt: number
}

type StopPlanEntry = {
  plan: MutationPlan
  componentId: string
  processRecordId: string
  identity: ProcessIdentity
  boundGeneration: number
  confirmationId: string
  reason: string
  escalate: boolean
  expiresAt: number
}

function devError(code: DevError['code'], message: string, retryable = false): DevError {
  return { code, retryable, message }
}

const SUPERVISION_ERROR_CODES: ReadonlyMap<string, DevError['code']> = new Map([
  ['not_found', 'not_found'],
  ['invalid_state', 'invalid_state'],
  ['capability_unavailable', 'capability_unavailable'],
  ['crash_loop', 'crash_loop'],
  ['ownership_unproven', 'ownership_unproven'],
  ['stale_generation', 'stale_generation'],
  ['already_completed', 'already_completed'],
  ['spawn_failed', 'spawn_failed'],
  ['sidecar_incompatible', 'sidecar_incompatible'],
  ['confirmation_required', 'auth_required'],
  // The engine's stop confirmation expired or was consumed: the plan is no
  // longer provable and the caller must re-plan.
  ['confirmation_invalid', 'plan_stale'],
  // The stop was signalled but exit was not observed inside the window; the
  // launch record is retained and a retry may escalate.
  ['stop_unconfirmed', 'timeout'],
])

function mapSupervisionError(failure: { code: string; message: string }): DevError {
  const code = SUPERVISION_ERROR_CODES.get(failure.code) ?? 'invalid_state'
  return devError(code, failure.message, code === 'timeout')
}

function page<T>(items: readonly T[], nextCursor?: string): DevRuntimePage<T> {
  return {
    items: [...items],
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    observedAt: new Date().toISOString(),
  }
}

function paginate<T>(items: readonly T[], cursor: string | undefined, limit: number | undefined) {
  const pageSize = limit ?? 100
  let start = 0
  if (cursor !== undefined) {
    const decoded = Number(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!Number.isSafeInteger(decoded) || decoded < 0) {
      throw devError('not_found', 'unknown listing cursor')
    }
    start = decoded
  }
  const slice = items.slice(start, start + pageSize)
  const nextCursor =
    start + pageSize < items.length
      ? Buffer.from(String(start + pageSize)).toString('base64url')
      : undefined
  return { slice, nextCursor }
}

function sameIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return (
    a.pid === b.pid &&
    a.pidStartIdentity === b.pidStartIdentity &&
    a.executableIdentity === b.executableIdentity
  )
}

/** Canonical plan digest: key order is sorted so the same facts always
 * produce the same digest across plan/commit. */
function digestPlan(facts: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(facts, Object.keys(facts).toSorted()))
    .digest('hex')
}

function processStateFromComponent(state: ComponentState): ProcessRecord['state'] {
  if (state === 'stopping') return 'stopping'
  if (state === 'running' || state === 'draining') return 'running'
  return 'unknown'
}

export function registerResourcesRuntime(input: RegisterResourcesRuntimeInput): {
  commands: readonly DevOperation[]
  registeredCommands: number
  metrics: MetricsHistory
  /** Live PIDs of proven, running Adea launches (never listed as foreign). */
  ownedPids(): ReadonlySet<number>
} {
  const now = input.now ?? Date.now
  const randomId = input.randomId ?? randomUUID
  const metrics = input.metrics ?? createMetricsHistory({ now })
  const stopPlans = new Map<string, StopPlanEntry>()
  const restartPlans = new Map<string, RestartPlanEntry>()
  /** Read-only defaults when no durable store is bound (updates refuse). */
  const defaultPreferences = createMemoryResourcePreferenceStore({ now })
  /** Stop attempts per component: the second plan for the same component
   * escalates to SIGKILL inside the engine's bounded window (explicit
   * escalation after a graceful window was already tried). */
  const stopAttempts = new Map<string, number>()

  function requireProcessResource(command: DevCommand, processRecordId: string): void {
    if (command.resource === undefined) {
      throw devError('identity_mismatch', 'operation requires a process resource binding')
    }
    if (command.resource.kind !== 'process') {
      throw devError('identity_mismatch', 'resource kind must be process')
    }
    if (command.resource.id !== processRecordId) {
      throw devError('identity_mismatch', 'resource id does not match the request body')
    }
  }

  /** Rebuild the proven launch inventory: durable journal records joined
   * against the live supervision snapshot. A launch whose journal identity no
   * longer matches the live snapshot (reused PID, replaced executable, stale
   * generation) is listed as `unknown` at best and never as stoppable.
   * `live` is the snapshot's component index, built once per inventory pass —
   * the join is linear in journal + components (#596), not quadratic. */
  function provenLaunches(live: ReadonlyMap<string, SupervisionComponent>): ProvenLaunch[] {
    if (!input.supervision || !input.supervisionRecords) return []
    const latest = new Map<string, ProvenLaunch>()
    for (const record of input.supervisionRecords.list()) {
      if (record.kind === 'launched') {
        latest.set(record.componentId, {
          processRecordId: record.processRecordId,
          componentId: record.componentId,
          generation: record.generation,
          identity: record.identity,
          processGroup: record.processGroup,
          startedAt: record.at,
          exited: undefined,
        })
        continue
      }
      const existing = latest.get(record.componentId)
      if (existing && existing.processRecordId === record.processRecordId) {
        existing.exited = { at: record.at, expected: record.expected }
      }
    }
    const horizon = now() - EXITED_VISIBLE_MS
    const proven: ProvenLaunch[] = []
    for (const launch of latest.values()) {
      const component = live.get(launch.componentId)
      if (launch.exited) {
        if (Date.parse(launch.exited.at) >= horizon) proven.push(launch)
        continue
      }
      if (
        component?.launch != null &&
        component.launch.identity.pid === launch.identity.pid &&
        component.launch.identity.pidStartIdentity === launch.identity.pidStartIdentity &&
        component.launch.identity.executableIdentity === launch.identity.executableIdentity &&
        component.generation === launch.generation
      ) {
        proven.push(launch)
        continue
      }
      // A launched record with no exit and no matching live process: the
      // engine owns the verdict — surface it as unproven (`unknown`), never
      // as running.
      proven.push(launch)
    }
    return proven
  }

  function toProcessRecord(
    launch: ProvenLaunch,
    live: ReadonlyMap<string, SupervisionComponent>
  ): ProcessRecord {
    const owner = input.resolveOwner?.(launch.componentId)
    const component = live.get(launch.componentId)
    let state: ProcessRecord['state']
    if (launch.exited) state = 'exited'
    else if (
      component?.launch != null &&
      component.launch.identity.pid === launch.identity.pid &&
      component.launch.identity.pidStartIdentity === launch.identity.pidStartIdentity &&
      component.launch.identity.executableIdentity === launch.identity.executableIdentity
    )
      state = processStateFromComponent(component.state)
    else state = 'unknown'
    return {
      id: launch.processRecordId,
      scope: input.scope,
      ...(owner?.runtimeSessionId !== undefined
        ? { runtimeSessionId: owner.runtimeSessionId }
        : {}),
      ...(owner?.worktreeId !== undefined ? { worktreeId: owner.worktreeId } : {}),
      ownerKind: owner?.ownerKind ?? 'bootstrap',
      ownerId: owner?.ownerId ?? launch.componentId,
      pid: launch.identity.pid,
      startIdentity: launch.identity.pidStartIdentity,
      executableIdentity: launch.identity.executableIdentity,
      processGroupIdentity: launch.processGroup,
      generation: launch.generation,
      state,
    }
  }

  function inventory(): { records: ProcessRecord[]; byId: Map<string, ProvenLaunch> } {
    if (!input.supervision || !input.supervisionRecords) {
      return { records: [], byId: new Map() }
    }
    // One live-component index per inventory pass; every launch projection
    // reads it instead of re-scanning the snapshot (#596: the per-launch
    // snapshot().components.find() scan made each pass quadratic).
    const live = new Map(input.supervision.snapshot().components.map((c) => [c.id, c]))
    const launches = provenLaunches(live)
    const byId = new Map(launches.map((launch) => [launch.processRecordId, launch]))
    const records = launches
      .map((launch) => toProcessRecord(launch, live))
      .toSorted((left, right) => left.id.localeCompare(right.id))
    return { records, byId }
  }

  async function portsForScope(): Promise<readonly PortRecord[]> {
    if (!input.ports) return []
    const snapshot = await input.ports.snapshot()
    return snapshot.ports.filter((record) => sameScope(record.scope))
  }

  function sameScope(candidate: Scope): boolean {
    return (
      candidate.accountId === input.scope.accountId &&
      candidate.workspaceId === input.scope.workspaceId &&
      candidate.runtimeNodeId === input.scope.runtimeNodeId
    )
  }

  async function sampleIntoHistory(): Promise<void> {
    if (!input.sampleProcesses) return
    const records = inventory().records.filter((record) => record.state === 'running')
    if (records.length === 0) return
    let samples: readonly ResourceSample[]
    try {
      samples = await input.sampleProcesses(records.map((record) => record.pid))
    } catch {
      // Sampling is best-effort observation; absence is truthful.
      return
    }
    const byPid = new Map(samples.map((sample) => [sample.pid, sample]))
    for (const record of records) {
      const sample = byPid.get(record.pid)
      if (!sample) continue
      metrics.recordSample(
        {
          ownerId: record.id,
          processRecordId: record.id,
          ...(record.runtimeSessionId !== undefined
            ? { runtimeSessionId: record.runtimeSessionId }
            : {}),
          ...(record.worktreeId !== undefined ? { worktreeId: record.worktreeId } : {}),
          generation: record.generation,
        },
        sample
      )
    }
  }

  const handlers: Partial<
    Record<DevOperation, (command: DevCommand) => Promise<unknown> | unknown>
  > = {
    'dev.resources.snapshot': async (command) => {
      devOperationDecoders['dev.resources.snapshot'].request(command.body)
      await sampleIntoHistory()
      const coverage = input.preferences?.current().coverage ?? 'machine'
      const machine =
        input.machine && coverage === 'machine' ? await input.machine.observe() : undefined
      const snapshot: ResourceSnapshot = {
        processes: inventory().records,
        ports: await portsForScope(),
        metrics: metrics.list(),
        retainedData: input.retainedData?.() ?? [],
        ...(machine ? { foreign: machine.foreign, machine: machine.machine } : {}),
        observedAt: new Date(now()).toISOString(),
      }
      return snapshot
    },

    'dev.resources.processes': (command) => {
      const body = devOperationDecoders['dev.resources.processes'].request(command.body)
      const records = inventory().records.filter(
        (record) =>
          (body.runtimeSessionId === undefined ||
            record.runtimeSessionId === (body.runtimeSessionId as string)) &&
          (body.worktreeId === undefined || record.worktreeId === (body.worktreeId as string))
      )
      const { slice, nextCursor } = paginate(
        records,
        body.cursor as string | undefined,
        body.limit as number | undefined
      )
      return page(slice, nextCursor)
    },

    'dev.resources.ports': (command) => {
      const body = devOperationDecoders['dev.resources.ports'].request(command.body)
      // The listing refreshes the #422 inventory lazily; failures of the
      // optional lsof scan are non-fatal there, so this only fails on a
      // broken seam, which surfaces as a typed error.
      return (async () => {
        const ports = await portsForScope()
        const records = ports.filter(
          (record) =>
            body.runtimeSessionId === undefined ||
            record.runtimeSessionId === (body.runtimeSessionId as string)
        )
        const { slice, nextCursor } = paginate(
          records,
          body.cursor as string | undefined,
          body.limit as number | undefined
        )
        return page(slice, nextCursor)
      })()
    },

    'dev.resources.metrics': (command) => {
      const body = devOperationDecoders['dev.resources.metrics'].request(command.body)
      const points = metrics.list({
        ...(body.runtimeSessionId !== undefined
          ? { runtimeSessionId: body.runtimeSessionId as string }
          : {}),
        ...(body.worktreeId !== undefined ? { worktreeId: body.worktreeId as string } : {}),
        ...(body.from !== undefined ? { fromMs: Date.parse(body.from as string) } : {}),
        ...(body.to !== undefined ? { toMs: Date.parse(body.to as string) } : {}),
      })
      const { slice, nextCursor } = paginate(
        points,
        body.cursor as string | undefined,
        body.limit as number | undefined
      )
      return page(slice, nextCursor)
    },

    'dev.resources.retainedData': (command) => {
      const body = devOperationDecoders['dev.resources.retainedData'].request(command.body)
      const records = (input.retainedData?.() ?? []).filter(
        (record) =>
          (body.worktreeId === undefined || record.ownerId === (body.worktreeId as string)) &&
          (body.runtimeSessionId === undefined ||
            record.scope === undefined ||
            sameScope(record.scope))
      )
      const { slice, nextCursor } = paginate(
        records,
        body.cursor as string | undefined,
        body.limit as number | undefined
      )
      return page(slice, nextCursor)
    },

    'dev.resources.usage': async (command) => {
      const body = devOperationDecoders['dev.resources.usage'].request(command.body)
      if (input.usage) await input.usage.refreshStale()
      const records: readonly UsageRecord[] =
        input.usage?.list(body.provider as string | undefined) ?? []
      const { slice, nextCursor } = paginate(
        records,
        body.cursor as string | undefined,
        body.limit as number | undefined
      )
      return page(slice, nextCursor)
    },

    'dev.resources.stopPlan': (command) => {
      const body = devOperationDecoders['dev.resources.stopPlan'].request(command.body)
      const processRecordId = body.processRecordId as string
      requireProcessResource(command, processRecordId)
      if (!input.supervision) {
        throw devError(
          'capability_unavailable',
          'no supervision engine is bound; process ownership cannot be proven'
        )
      }
      const launch = inventory().byId.get(processRecordId)
      if (!launch) throw devError('not_found', 'no proven launch record for this process id')
      if (launch.exited) {
        throw devError('already_completed', 'this launch record has already exited')
      }
      if (command.resource!.generation !== launch.generation) {
        throw devError('stale_generation', 'resource generation does not match the launch record')
      }
      const confirmation = input.supervision.requestStop(launch.componentId)
      if (!confirmation.ok) throw mapSupervisionError(confirmation)
      const reason = body.reason as string
      const digest = digestPlan({
        componentId: launch.componentId,
        confirmationId: confirmation.value.confirmationId,
        executableIdentity: launch.identity.executableIdentity,
        generation: launch.generation,
        pid: launch.identity.pid,
        pidStartIdentity: launch.identity.pidStartIdentity,
        processGroup: launch.processGroup,
        processRecordId,
        reason,
      })
      const attempts = stopAttempts.get(launch.componentId) ?? 0
      const plan: MutationPlan = {
        id: randomId(),
        operation: 'dev.resources.stopCommit',
        scope: input.scope,
        resource: {
          kind: 'process',
          id: processRecordId,
          generation: launch.generation,
        },
        factVersions: { launchDigest: digest },
        steps: [
          {
            id: 'stop',
            kind: 'stop_owned_resource',
            targetId: launch.componentId,
            dependsOn: [],
          },
        ],
        blockers: [],
        requiredApprovalIds: [],
        digest,
        expiresAt: new Date(now() + PLAN_TTL_MS).toISOString(),
      }
      stopPlans.set(plan.id, {
        plan,
        componentId: launch.componentId,
        processRecordId,
        identity: launch.identity,
        boundGeneration: launch.generation,
        confirmationId: confirmation.value.confirmationId,
        reason,
        // A previous unconfirmed stop means the graceful window already
        // failed once for this component: the retry escalates explicitly.
        escalate: attempts >= 1,
        expiresAt: now() + PLAN_TTL_MS,
      })
      return plan
    },

    'dev.resources.stopCommit': async (command) => {
      const body = devOperationDecoders['dev.resources.stopCommit'].request(command.body)
      if (command.resource === undefined) {
        throw devError('identity_mismatch', 'operation requires a process resource binding')
      }
      const entry = liveStopPlan(body.planId as string)
      requireProcessResource(command, entry.processRecordId)
      // The envelope resource generation MUST equal the plan's bound target
      // generation before the digest or any side effect is evaluated.
      if (entry.boundGeneration !== command.resource.generation) {
        throw devError('stale_generation', 'the plan is bound to another launch generation')
      }
      if ((body.planDigest as string) !== entry.plan.digest) {
        throw devError('invalid_state', 'the plan digest does not match the staged plan')
      }
      if (!input.supervision) {
        throw devError(
          'capability_unavailable',
          'no supervision engine is bound; process ownership cannot be proven'
        )
      }
      // Pre-flight: the launch this plan bound to must still be the proven
      // inventory entry (the engine re-proves again internally right before
      // any signal — this is defense in depth, not the ownership proof).
      const current = inventory().byId.get(entry.processRecordId)
      if (current?.exited) {
        stopPlans.delete(entry.plan.id)
        throw devError('already_completed', 'this launch record has already exited')
      }
      if (!current || !sameIdentity(current.identity, entry.identity)) {
        stopPlans.delete(entry.plan.id)
        throw devError('ownership_unproven', 'the launch record is no longer provably current')
      }
      const outcome = await input.supervision.stop(entry.componentId, {
        generation: entry.boundGeneration,
        confirmationId: entry.confirmationId,
        escalate: entry.escalate,
      })
      if (!outcome.ok) {
        // A grace window that expired without observed exit counts as an
        // attempt: the next plan for this component escalates explicitly.
        if (outcome.code === 'stop_unconfirmed') {
          stopAttempts.set(entry.componentId, (stopAttempts.get(entry.componentId) ?? 0) + 1)
        }
        throw mapSupervisionError(outcome)
      }
      stopPlans.delete(entry.plan.id)
      stopAttempts.set(entry.componentId, (stopAttempts.get(entry.componentId) ?? 0) + 1)
      const live = new Map(input.supervision.snapshot().components.map((c) => [c.id, c]))
      return toProcessRecord(
        {
          ...current,
          exited: { at: outcome.value.at, expected: outcome.value.expected },
        },
        live
      )
    },

    'dev.resources.restartPlan': (command) => {
      const body = devOperationDecoders['dev.resources.restartPlan'].request(command.body)
      const processRecordId = body.processRecordId as string
      requireProcessResource(command, processRecordId)
      if (!input.supervision?.restart) {
        throw devError(
          'capability_unavailable',
          'no supervision engine with restart is bound; this process cannot be restarted'
        )
      }
      const launch = inventory().byId.get(processRecordId)
      if (!launch) throw devError('not_found', 'no proven launch record for this process id')
      if (launch.exited) {
        throw devError('already_completed', 'this launch record has already exited')
      }
      if (command.resource!.generation !== launch.generation) {
        throw devError('stale_generation', 'resource generation does not match the launch record')
      }
      const digest = digestPlan({
        componentId: launch.componentId,
        executableIdentity: launch.identity.executableIdentity,
        generation: launch.generation,
        pid: launch.identity.pid,
        pidStartIdentity: launch.identity.pidStartIdentity,
        processGroup: launch.processGroup,
        processRecordId,
        reason: body.reason as string,
      })
      const plan: MutationPlan = {
        id: randomId(),
        operation: 'dev.resources.restartCommit',
        scope: input.scope,
        resource: { kind: 'process', id: processRecordId, generation: launch.generation },
        factVersions: { launchDigest: digest },
        steps: [
          { id: 'stop', kind: 'stop_owned_resource', targetId: launch.componentId, dependsOn: [] },
          {
            id: 'relaunch',
            kind: 'relaunch_owned_resource',
            targetId: launch.componentId,
            dependsOn: ['stop'],
          },
        ],
        blockers: [],
        requiredApprovalIds: [],
        digest,
        expiresAt: new Date(now() + PLAN_TTL_MS).toISOString(),
      }
      restartPlans.set(plan.id, {
        plan,
        componentId: launch.componentId,
        processRecordId,
        identity: launch.identity,
        boundGeneration: launch.generation,
        expiresAt: now() + PLAN_TTL_MS,
      })
      return plan
    },

    'dev.resources.restartCommit': async (command) => {
      const body = devOperationDecoders['dev.resources.restartCommit'].request(command.body)
      if (command.resource === undefined) {
        throw devError('identity_mismatch', 'operation requires a process resource binding')
      }
      const planId = body.planId as string
      const entry = restartPlans.get(planId)
      if (!entry || entry.expiresAt <= now()) {
        restartPlans.delete(planId)
        throw devError('plan_stale', 'the plan is unknown, expired, or already consumed')
      }
      requireProcessResource(command, entry.processRecordId)
      if (entry.boundGeneration !== command.resource.generation) {
        throw devError('stale_generation', 'the plan is bound to another launch generation')
      }
      if ((body.planDigest as string) !== entry.plan.digest) {
        throw devError('invalid_state', 'the plan digest does not match the staged plan')
      }
      restartPlans.delete(planId)
      if (!input.supervision?.restart) {
        throw devError(
          'capability_unavailable',
          'no supervision engine with restart is bound; this process cannot be restarted'
        )
      }
      // The engine restarts by component id without a generation fence, so the
      // fence is enforced here: the bound launch must still be the proven,
      // running entry with the same identity.
      const current = inventory().byId.get(entry.processRecordId)
      if (current?.exited) {
        throw devError('already_completed', 'this launch record has already exited')
      }
      if (
        !current ||
        current.generation !== entry.boundGeneration ||
        !sameIdentity(current.identity, entry.identity)
      ) {
        throw devError('ownership_unproven', 'the launch record is no longer provably current')
      }
      const outcome = await input.supervision.restart(entry.componentId)
      if (!outcome.ok) throw mapSupervisionError(outcome)
      const after = inventory()
      const relaunch = [...after.byId.values()].find(
        (launch) =>
          launch.componentId === entry.componentId &&
          launch.generation > entry.boundGeneration &&
          !launch.exited
      )
      const relaunched = relaunch
        ? after.records.find((record) => record.id === relaunch.processRecordId)
        : undefined
      if (!relaunched) {
        throw devError('invalid_state', 'the relaunched process is not yet in the proven inventory')
      }
      return relaunched
    },

    'dev.resources.foreignStopPlan': (command) => {
      const body = devOperationDecoders['dev.resources.foreignStopPlan'].request(command.body)
      if (!input.foreignStop) {
        throw devError(
          'capability_unavailable',
          'machine-wide process inventory is not available on this runtime node'
        )
      }
      return input.foreignStop.plan(command, body)
    },

    'dev.resources.foreignStopCommit': async (command) => {
      const body = devOperationDecoders['dev.resources.foreignStopCommit'].request(command.body)
      if (!input.foreignStop) {
        throw devError(
          'capability_unavailable',
          'machine-wide process inventory is not available on this runtime node'
        )
      }
      return input.foreignStop.commit(command, body)
    },

    'dev.resources.worktreeStorage': (command) => {
      const body = devOperationDecoders['dev.resources.worktreeStorage'].request(command.body)
      const records = input.worktreeStorage?.list(body.worktreeId as string | undefined) ?? []
      const { slice, nextCursor } = paginate(
        records,
        body.cursor as string | undefined,
        body.limit as number | undefined
      )
      return page(slice, nextCursor)
    },

    'dev.resources.preferences': (command) => {
      devOperationDecoders['dev.resources.preferences'].request(command.body)
      return preferenceStore().current()
    },

    'dev.resources.preferencesUpdate': (command) => {
      const body = devOperationDecoders['dev.resources.preferencesUpdate'].request(command.body)
      if (!input.preferences) {
        throw devError(
          'capability_unavailable',
          'resource settings cannot be stored on this runtime node'
        )
      }
      return input.preferences.update(
        body.expectedVersion as number,
        body.preferences as ResourcePreferencesInput
      )
    },
  }

  function preferenceStore(): ResourcePreferenceStore {
    return input.preferences ?? defaultPreferences
  }

  function liveStopPlan(planId: string): StopPlanEntry {
    const entry = stopPlans.get(planId)
    if (!entry || entry.expiresAt <= now()) {
      stopPlans.delete(planId)
      throw devError('plan_stale', 'the plan is unknown, expired, or already consumed')
    }
    return entry
  }

  function mapResourceError(error: unknown): unknown {
    if (error instanceof Error && !(error as { code?: unknown }).code) {
      return devError('invalid_state', error.message)
    }
    return error
  }

  function ownedPids(): ReadonlySet<number> {
    return new Set(
      inventory()
        .records.filter((record) => record.state === 'running' || record.state === 'stopping')
        .map((record) => record.pid)
    )
  }

  let registeredCommands = 0
  for (const [operation, handler] of Object.entries(handlers)) {
    if (!handler) continue
    input.authority.registerCommandProvider(operation as DevOperation, async (command) => {
      try {
        return await handler(command)
      } catch (error) {
        throw mapResourceError(error)
      }
    })
    registeredCommands += 1
  }
  return {
    commands: Object.keys(handlers) as DevOperation[],
    registeredCommands,
    metrics,
    ownedPids,
  }
}
