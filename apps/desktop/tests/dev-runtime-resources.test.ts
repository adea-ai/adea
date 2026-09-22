// #424 runtime resources, usage, activity, and safe cleanup — focused host
// tests. These exercise the resources registrar, the usage service/adapters/
// fetch policy, and the cleanup-policy authority directly with scripted
// seams (the full channel graph is covered by dev-runtime-composition.test).
//
// The safety bar under test: inventory entries exist only when a durable
// launch record plus live supervision snapshot prove them; every destructive
// operation is an envelope-bound, generation-fenced plan/commit pair whose
// commit delegates the side effect to the supervision engine's public API —
// which re-proves identity immediately before any signal — and failures fail
// closed.
import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'

import type { DevCommand, DevOperation, Scope } from '../../../packages/types/src/dev-runtime'
import type { SupervisionRecord } from '../shell/src/supervision/records'
import type { SupervisionSnapshot } from '../shell/src/supervision/supervisor'
import { registerResourcesRuntime } from '../shell/src/dev-runtime/resources/register'
import {
  createMetricsHistory,
  MAX_POINTS_PER_OWNER,
} from '../shell/src/dev-runtime/resources/metrics'
import {
  createProcessSampler,
  SAMPLE_MAX_PIDS,
} from '../shell/src/dev-runtime/resources/sample-processes'
import {
  createCleanupPolicyAuthority,
  evaluatePredicates,
} from '../shell/src/dev-runtime/resources/policy'
import {
  createLocalEstimateAdapter,
  createOfficialApiUsageAdapter,
  parseUsagePayload,
} from '../shell/src/dev-runtime/usage/adapters'
import { createUsageService, MANUAL_REFRESH_FLOOR_MS } from '../shell/src/dev-runtime/usage/service'
import { admitUsageEndpoint, isDeniedAddress } from '../shell/src/dev-runtime/usage/fetch-policy'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

type ProviderMap = Partial<Record<DevOperation, (command: DevCommand) => unknown>>

function stubAuthority() {
  const providers: ProviderMap = {}
  return {
    providers,
    registerCommandProvider(operation: DevOperation, handler: (command: DevCommand) => unknown) {
      providers[operation] = handler
    },
  }
}

function command(
  operation: DevOperation,
  body: Record<string, unknown>,
  resource?: { kind: string; id: string; generation: number }
): DevCommand {
  return {
    schemaVersion: 1,
    operation,
    requestId: randomUUID(),
    nonce: 'A'.repeat(22),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    scope: SCOPE,
    capabilities: [],
    ...(resource ? { resource } : {}),
    body,
  } as DevCommand
}

const LAUNCH_A = {
  pid: 4100,
  pidStartIdentity: 'start-a',
  executableIdentity: '/exe/a',
}

function launchedRecord(
  componentId: string,
  overrides: Partial<Extract<SupervisionRecord, { kind: 'launched' }>> = {}
): SupervisionRecord {
  return {
    kind: 'launched',
    at: new Date(1_000).toISOString(),
    componentId,
    generation: 1,
    processRecordId: `record-${componentId}`,
    identity: { ...LAUNCH_A },
    processGroup: 'grp-a',
    ...overrides,
  }
}

function snapshotComponent(
  componentId: string,
  opts: {
    state?: string
    generation?: number
    launch?: { identity: typeof LAUNCH_A; processGroup: string; startedAt: string } | null
  } = {}
) {
  return {
    id: componentId,
    state: opts.state ?? 'running',
    health: 'healthy',
    generation: opts.generation ?? 1,
    launch:
      opts.launch === undefined
        ? {
            identity: { ...LAUNCH_A },
            processGroup: 'grp-a',
            startedAt: new Date(1_000).toISOString(),
          }
        : opts.launch,
    manifest: { version: '1.0.0', digestSha256: 'd'.repeat(64) },
  } as SupervisionSnapshot['components'][number]
}

type ScriptedStopCall = {
  componentId: string
  opts: { generation?: number; confirmationId?: string; escalate?: boolean } | undefined
}

function scriptedSupervision(options: {
  components: SupervisionSnapshot['components']
  stopResults:
    | Array<{ ok: true; value: Extract<SupervisionRecord, { kind: 'exited' }> }>
    | Array<{ ok: false; code: string; message: string }>
  confirmations?: string[]
}) {
  const stops: ScriptedStopCall[] = []
  let stopIndex = 0
  return {
    stops,
    view: {
      snapshot: () => ({ components: options.components }) as SupervisionSnapshot,
      requestStop(componentId: string) {
        const confirmationId = options.confirmations?.[0] ?? `confirm-${componentId}`
        return { ok: true as const, value: { confirmationId, generation: 1 } }
      },
      async stop(
        componentId: string,
        opts?: { generation?: number; confirmationId?: string; escalate?: boolean }
      ) {
        stops.push({ componentId, opts })
        const result = options.stopResults[Math.min(stopIndex, options.stopResults.length - 1)]!
        stopIndex += 1
        return result
      },
    },
  }
}

function journal(...records: SupervisionRecord[]) {
  return { list: () => records }
}

/** Every registered handler is wrapped async, so a typed refusal is a
 * rejected promise; this awaits it and returns the error envelope. */
async function errorOf(operation: () => unknown): Promise<{ code: string; message: string }> {
  try {
    await operation()
  } catch (error) {
    return error as { code: string; message: string }
  }
  throw new Error('expected the handler to fail closed')
}

describe('runtime resources inventory', () => {
  test('lists only journal-proven launches; PID-replaced and exited records are explicit', async () => {
    const authority = stubAuthority()
    const supervision = scriptedSupervision({
      components: [
        // Live and matching: owned and stoppable.
        snapshotComponent('comp-a'),
        // The PID was reused by another process: the snapshot identity no
        // longer matches the journal — never owned, never stoppable.
        snapshotComponent('comp-b', {
          launch: {
            identity: { pid: 4200, pidStartIdentity: 'reused-start', executableIdentity: '/exe/a' },
            processGroup: 'grp-b',
            startedAt: new Date(2_000).toISOString(),
          },
        }),
        snapshotComponent('comp-c', { state: 'exited', launch: null }),
      ],
      stopResults: [],
    })
    const { providers } = authority
    registerResourcesRuntime({
      authority: authority as never,
      scope: SCOPE,
      supervision: supervision.view,
      supervisionRecords: journal(
        launchedRecord('comp-a'),
        launchedRecord('comp-b', {
          processRecordId: 'record-comp-b',
          identity: { pid: 4200, pidStartIdentity: 'original-start', executableIdentity: '/exe/a' },
          processGroup: 'grp-b',
        }),
        launchedRecord('comp-c', {
          processRecordId: 'record-comp-c',
          identity: { pid: 4300, pidStartIdentity: 'start-c', executableIdentity: '/exe/c' },
          processGroup: 'grp-c',
        }),
        {
          kind: 'exited',
          at: new Date(3_000).toISOString(),
          componentId: 'comp-c',
          generation: 1,
          processRecordId: 'record-comp-c',
          expected: true,
          exitDetail: 'operator stop',
        }
      ),
      now: () => 4_000,
      randomId: () => randomUUID(),
    })
    const handler = providers['dev.resources.processes']!
    const reply = (await handler(command('dev.resources.processes', {}))) as {
      items: Array<{ id: string; state: string; pid: number }>
    }
    const byId = new Map(reply.items.map((item) => [item.id, item]))
    expect(byId.get('record-comp-a')?.state).toBe('running')
    // The PID-replaced launch is visible as unproven (`unknown`), not as an
    // owned running process.
    expect(byId.get('record-comp-b')?.state).toBe('unknown')
    expect(byId.get('record-comp-c')?.state).toBe('exited')
  })

  test('stopPlan refuses unknown, exited, stale-generation, and engineless targets', async () => {
    const authority = stubAuthority()
    const supervision = scriptedSupervision({
      components: [snapshotComponent('comp-a')],
      stopResults: [],
    })
    registerResourcesRuntime({
      authority: authority as never,
      scope: SCOPE,
      supervision: supervision.view,
      supervisionRecords: journal(launchedRecord('comp-a')),
      now: () => 4_000,
    })
    const stopPlan = authority.providers['dev.resources.stopPlan']!
    const plan =
      (
        body: Record<string, unknown>,
        resource?: { kind: string; id: string; generation: number }
      ) =>
      () =>
        stopPlan(command('dev.resources.stopPlan', body, resource))
    // The valid, proven, generation-matched target plans successfully.
    const minted = (await plan(
      { processRecordId: 'record-comp-a', expectedGeneration: 1, reason: 'done' },
      { kind: 'process', id: 'record-comp-a', generation: 1 }
    )()) as {
      id: string
      resource: { kind: string; id: string; generation: number }
      digest: string
    }
    expect(minted.resource).toEqual({ kind: 'process', id: 'record-comp-a', generation: 1 })
    expect(minted.digest).toMatch(/^[0-9a-f]{64}$/)
    // Missing envelope binding at all:
    expect(
      await errorOf(() =>
        plan({ processRecordId: 'record-comp-a', expectedGeneration: 1, reason: 'done' })()
      )
    ).toMatchObject({ code: 'identity_mismatch' })
    // Unknown process id:
    expect(
      await errorOf(() =>
        plan(
          { processRecordId: 'record-nope', expectedGeneration: 1, reason: 'done' },
          { kind: 'process', id: 'record-nope', generation: 1 }
        )()
      )
    ).toMatchObject({ code: 'not_found' })
    // Stale generation:
    expect(
      await errorOf(() =>
        plan(
          { processRecordId: 'record-comp-a', expectedGeneration: 1, reason: 'done' },
          { kind: 'process', id: 'record-comp-a', generation: 2 }
        )()
      )
    ).toMatchObject({ code: 'stale_generation' })
  })

  test('stopPlan fails closed when no supervision engine is bound', async () => {
    const authority = stubAuthority()
    registerResourcesRuntime({
      authority: authority as never,
      scope: SCOPE,
      supervisionRecords: journal(launchedRecord('comp-a')),
      now: () => 4_000,
    })
    const error = await errorOf(() =>
      authority.providers['dev.resources.stopPlan']!(
        command(
          'dev.resources.stopPlan',
          { processRecordId: 'record-comp-a', expectedGeneration: 1, reason: 'done' },
          { kind: 'process', id: 'record-comp-a', generation: 1 }
        )
      )
    )
    expect(error.code).toBe('capability_unavailable')
  })
})

describe('safe stop plan/commit', () => {
  function boot(stopResults: Parameters<typeof scriptedSupervision>[0]['stopResults']) {
    const authority = stubAuthority()
    const supervision = scriptedSupervision({
      components: [snapshotComponent('comp-a')],
      stopResults,
      confirmations: ['confirm-1'],
    })
    registerResourcesRuntime({
      authority: authority as never,
      scope: SCOPE,
      supervision: supervision.view,
      supervisionRecords: journal(launchedRecord('comp-a')),
      now: () => 4_000,
    })
    return { authority, supervision }
  }

  test('commit signals only through the engine with generation, confirmation, and digest', async () => {
    const { authority, supervision } = boot([
      {
        ok: true,
        value: {
          kind: 'exited',
          at: new Date(5_000).toISOString(),
          componentId: 'comp-a',
          generation: 1,
          processRecordId: 'record-comp-a',
          expected: true,
          exitDetail: 'signalled; exit observed',
        },
      },
    ])
    const plan = (await authority.providers['dev.resources.stopPlan']!(
      command(
        'dev.resources.stopPlan',
        { processRecordId: 'record-comp-a', expectedGeneration: 1, reason: 'session done' },
        { kind: 'process', id: 'record-comp-a', generation: 1 }
      )
    )) as { id: string; digest: string; resource: { generation: number } }
    expect(plan.resource.generation).toBe(1)
    const reply = (await authority.providers['dev.resources.stopCommit']!(
      command(
        'dev.resources.stopCommit',
        { planId: plan.id, planDigest: plan.digest },
        { kind: 'process', id: 'record-comp-a', generation: 1 }
      )
    )) as { id: string; state: string }
    expect(reply.state).toBe('exited')
    // The side effect went through the engine's public API with the fenced
    // generation and single-use confirmation; escalate is false on the
    // first, graceful attempt.
    expect(supervision.stops).toEqual([
      {
        componentId: 'comp-a',
        opts: { generation: 1, confirmationId: 'confirm-1', escalate: false },
      },
    ])
    // The plan is consumed: a replay fails closed.
    expect(
      await errorOf(() =>
        authority.providers['dev.resources.stopCommit']!(
          command(
            'dev.resources.stopCommit',
            { planId: plan.id, planDigest: plan.digest },
            { kind: 'process', id: 'record-comp-a', generation: 1 }
          )
        )
      )
    ).toMatchObject({ code: 'plan_stale' })
  })

  test('commit rejects a digest mismatch and a stale envelope generation', async () => {
    const { authority } = boot([])
    const plan = (await authority.providers['dev.resources.stopPlan']!(
      command(
        'dev.resources.stopPlan',
        { processRecordId: 'record-comp-a', expectedGeneration: 1, reason: 'session done' },
        { kind: 'process', id: 'record-comp-a', generation: 1 }
      )
    )) as { id: string; digest: string }
    expect(
      await errorOf(() =>
        authority.providers['dev.resources.stopCommit']!(
          command(
            'dev.resources.stopCommit',
            { planId: plan.id, planDigest: 'f'.repeat(64) },
            { kind: 'process', id: 'record-comp-a', generation: 1 }
          )
        )
      )
    ).toMatchObject({ code: 'invalid_state' })
    expect(
      await errorOf(() =>
        authority.providers['dev.resources.stopCommit']!(
          command(
            'dev.resources.stopCommit',
            { planId: plan.id, planDigest: plan.digest },
            { kind: 'process', id: 'record-comp-a', generation: 2 }
          )
        )
      )
    ).toMatchObject({ code: 'stale_generation' })
  })

  test('an engine-withheld signal surfaces as ownership_unproven and never signals', async () => {
    const { authority, supervision } = boot([
      { ok: false, code: 'ownership_unproven', message: 'identity recheck failed' },
    ])
    const plan = (await authority.providers['dev.resources.stopPlan']!(
      command(
        'dev.resources.stopPlan',
        { processRecordId: 'record-comp-a', expectedGeneration: 1, reason: 'session done' },
        { kind: 'process', id: 'record-comp-a', generation: 1 }
      )
    )) as { id: string; digest: string }
    const error = await (async () => {
      try {
        await authority.providers['dev.resources.stopCommit']!(
          command(
            'dev.resources.stopCommit',
            { planId: plan.id, planDigest: plan.digest },
            { kind: 'process', id: 'record-comp-a', generation: 1 }
          )
        )
      } catch (caught) {
        return caught as { code: string }
      }
    })()
    expect(error?.code).toBe('ownership_unproven')
    // The registrar itself holds no signaling path: only the engine could
    // have signalled, and it withheld.
    expect(supervision.stops).toHaveLength(1)
  })

  test('a second plan after an unconfirmed stop escalates explicitly', async () => {
    const { authority, supervision } = boot([
      { ok: false, code: 'stop_unconfirmed', message: 'did not exit within the window' },
      {
        ok: true,
        value: {
          kind: 'exited',
          at: new Date(9_000).toISOString(),
          componentId: 'comp-a',
          generation: 1,
          processRecordId: 'record-comp-a',
          expected: true,
          exitDetail: 'signalled (SIGTERM + SIGKILL); exit observed',
        },
      },
    ])
    const planOnce = async () =>
      (await authority.providers['dev.resources.stopPlan']!(
        command(
          'dev.resources.stopPlan',
          { processRecordId: 'record-comp-a', expectedGeneration: 1, reason: 'retry' },
          { kind: 'process', id: 'record-comp-a', generation: 1 }
        )
      )) as { id: string; digest: string }
    const first = await planOnce()
    await authority.providers['dev.resources.stopCommit']!(
      command(
        'dev.resources.stopCommit',
        { planId: first.id, planDigest: first.digest },
        { kind: 'process', id: 'record-comp-a', generation: 1 }
      )
    ).catch((error: { code: string }) => {
      expect(error.code).toBe('timeout')
    })
    const second = await planOnce()
    await authority.providers['dev.resources.stopCommit']!(
      command(
        'dev.resources.stopCommit',
        { planId: second.id, planDigest: second.digest },
        { kind: 'process', id: 'record-comp-a', generation: 1 }
      )
    )
    expect(supervision.stops[1]?.opts?.escalate).toBe(true)
  })
})

describe('metric history', () => {
  test('cpu needs two samples, unknowns stay absent, and history is bounded', () => {
    let clock = 1_000
    const history = createMetricsHistory({ now: () => clock, maxPointsPerOwner: 2 })
    history.recordSample(
      { ownerId: 'p1', processRecordId: 'p1' },
      { pid: 1, cpuSeconds: 1.0, residentBytes: 1024 }
    )
    const first = history.list()[0]!
    expect(first.cpuPercent).toBeUndefined()
    expect(first.residentBytes).toBe('1024')
    clock += 2_000
    history.recordSample(
      { ownerId: 'p1', processRecordId: 'p1' },
      { pid: 1, cpuSeconds: 3.0, residentBytes: 2048 }
    )
    const second = history.list().at(-1)!
    expect(second.cpuPercent).toBeCloseTo(100)
    clock += 2_000
    history.recordSample({ ownerId: 'p1', processRecordId: 'p1' }, { pid: 1, cpuSeconds: 4.0 })
    expect(history.list()).toHaveLength(2)
    expect(history.list().every((point) => point.confidence === 'measured')).toBe(true)
  })

  test('the default 720-point cap binds when a single owner is sampled past it', () => {
    let clock = 1_000
    const history = createMetricsHistory({ now: () => clock })
    for (let sample = 0; sample < MAX_POINTS_PER_OWNER + 10; sample += 1) {
      clock += 1_000
      history.recordSample(
        { ownerId: 'p1', processRecordId: 'p1', runtimeSessionId: 'session-000' },
        { pid: 1, cpuSeconds: 1 + sample * 0.5, residentBytes: 1024 }
      )
    }
    expect(history.list()).toHaveLength(MAX_POINTS_PER_OWNER)
  })

  test('the full listing stays globally ordered and exact while owners are appended and evicted (#596)', () => {
    let clock = 1_000
    const history = createMetricsHistory({ now: () => clock, maxPointsPerOwner: 4 })
    // Three owners interleaved: the listing must stay sorted by observedAt
    // across appends, per-owner cap evictions, and repeated reads, and it
    // must always equal the union of the per-owner histories.
    for (let round = 0; round < 10; round += 1) {
      for (const ownerId of ['p1', 'p2', 'p3']) {
        clock += 500
        history.recordSample({ ownerId, processRecordId: ownerId }, { pid: 1, cpuSeconds: 1 })
        expect(history.list({ processRecordId: ownerId }).length).toBeLessThanOrEqual(4)
      }
      const listing = history.list()
      for (let index = 1; index < listing.length; index += 1) {
        expect(listing[index - 1]!.observedAt <= listing[index]!.observedAt).toBe(true)
      }
      const union = ['p1', 'p2', 'p3'].flatMap((ownerId) =>
        history.list({ processRecordId: ownerId })
      )
      expect([...listing].toSorted((a, b) => a.observedAt.localeCompare(b.observedAt))).toEqual(
        [...union].toSorted((a, b) => a.observedAt.localeCompare(b.observedAt))
      )
    }
    // Cap eviction binds per owner in the full listing too: 10 rounds × 3
    // owners with a 4-point cap leaves exactly 12 points, the newest 4 each.
    expect(history.list()).toHaveLength(12)
    const oldestKept = history
      .list({ processRecordId: 'p1' })
      .map((point) => point.observedAt)
      .at(0)
    expect(oldestKept).toBeDefined()
    clock += 500
    history.recordSample({ ownerId: 'p1', processRecordId: 'p1' }, { pid: 1, cpuSeconds: 1 })
    expect(
      history.list({ processRecordId: 'p1' }).some((point) => point.observedAt === oldestKept)
    ).toBe(false)
  })

  test('reads never observe the store mutate a listing handed out earlier (#596)', () => {
    let clock = 1_000
    const history = createMetricsHistory({ now: () => clock })
    history.recordSample({ ownerId: 'p1', processRecordId: 'p1' }, { pid: 1, cpuSeconds: 1 })
    const first = history.list()
    expect(first).toHaveLength(1)
    clock += 1_000
    history.recordSample({ ownerId: 'p1', processRecordId: 'p1' }, { pid: 1, cpuSeconds: 2 })
    // Appends and evictions rebind the maintained listing; the array a caller
    // already holds stays frozen at what it observed.
    expect(first).toHaveLength(1)
    expect(history.list()).toHaveLength(2)
    clock += 1_000
    history.recordSample({ ownerId: 'p2', processRecordId: 'p2' }, { pid: 2, cpuSeconds: 1 })
    expect(first).toHaveLength(1)
    expect(history.list().map((point) => point.ownerId)).toEqual(['p1', 'p1', 'p2'])
  })

  test('same-millisecond points keep the legacy listing order (owner creation, then record order)', () => {
    let clock = 1_000
    const history = createMetricsHistory({ now: () => clock })
    // One pull samples many processes at one clock value: all points share an
    // observedAt. The listing must order them by owner creation order, then
    // record order — exactly the legacy owner-major stable sort.
    clock = 5_000
    for (const ownerId of ['o-b', 'o-a', 'o-c', 'o-a']) {
      history.recordSample({ ownerId, processRecordId: ownerId }, { pid: 1, cpuSeconds: 1 })
    }
    expect(history.list().map((point) => point.ownerId)).toEqual(['o-b', 'o-a', 'o-a', 'o-c'])
    // The order survives a read between appends (the boundary fold), too.
    clock = 6_000
    history.recordSample({ ownerId: 'o-d', processRecordId: 'o-d' }, { pid: 1, cpuSeconds: 1 })
    expect(history.list().map((point) => point.ownerId)).toEqual([
      'o-b',
      'o-a',
      'o-a',
      'o-c',
      'o-d',
    ])
    clock = 6_000
    history.recordSample({ ownerId: 'o-e', processRecordId: 'o-e' }, { pid: 1, cpuSeconds: 1 })
    history.recordSample({ ownerId: 'o-b2', processRecordId: 'o-b2' }, { pid: 1, cpuSeconds: 1 })
    expect(history.list().map((point) => point.ownerId)).toEqual([
      'o-b',
      'o-a',
      'o-a',
      'o-c',
      'o-d',
      'o-e',
      'o-b2',
    ])
  })

  test('a non-monotonic clock still yields the exact sorted listing (rebuild path)', () => {
    let clock = 5_000
    const history = createMetricsHistory({ now: () => clock })
    for (const step of [1_000, 1_000, -2_500, 3_000, -1_000, 2_500]) {
      clock += step
      history.recordSample({ ownerId: 'p1', processRecordId: 'p1' }, { pid: 1, cpuSeconds: 1 })
      history.recordSample({ ownerId: 'p2', processRecordId: 'p2' }, { pid: 2, cpuSeconds: 1 })
    }
    const listing = history.list()
    expect(listing).toHaveLength(12)
    for (let index = 1; index < listing.length; index += 1) {
      expect(listing[index - 1]!.observedAt <= listing[index]!.observedAt).toBe(true)
    }
    expect(new Set(listing.map((point) => point.ownerId))).toEqual(new Set(['p1', 'p2']))
  })
})

describe('resource scale seams (100 sessions / 1,000 processes)', () => {
  // The #424 scale budget at unit size: the production seams — durable launch
  // journal joined against the live snapshot, the bounded rotating ps
  // sampler, and the returned metrics history — must carry 1,000 processes
  // across 100 sessions with exactly one bounded `ps` observation per pull
  // and history that stays inside the named caps. The measured scale lane
  // (scripts/test-dev-runtime-scale.mjs) pins the latency budgets on top.
  const PROCESSES = 1_000
  const SESSIONS = 100

  function scaleInventory() {
    const records: Array<Extract<SupervisionRecord, { kind: 'launched' }>> = []
    const components: Array<SupervisionSnapshot['components'][number]> = []
    for (let index = 0; index < PROCESSES; index += 1) {
      const componentId = `comp-${String(index).padStart(4, '0')}`
      records.push(
        launchedRecord(componentId, {
          processRecordId: `record-${componentId}`,
          identity: {
            pid: 10_000 + index,
            pidStartIdentity: `start-${index}`,
            executableIdentity: `/exe/${index}`,
          },
          processGroup: `grp-${index}`,
        })
      )
      components.push(
        snapshotComponent(componentId, {
          launch: {
            identity: {
              pid: 10_000 + index,
              pidStartIdentity: `start-${index}`,
              executableIdentity: `/exe/${index}`,
            },
            processGroup: `grp-${index}`,
            startedAt: new Date(1_000).toISOString(),
          },
        })
      )
    }
    const sessionOf = (componentId: string) => {
      const index = Number(componentId.slice(5))
      return `session-${String(Math.floor(index / (PROCESSES / SESSIONS))).padStart(3, '0')}`
    }
    return { records, components, sessionOf }
  }

  function bootScaleSeams(inventory: ReturnType<typeof scaleInventory>) {
    let clock = 1_000_000
    const authority = stubAuthority()
    let psCalls = 0
    let maxPidsPerCall = 0
    const sampler = createProcessSampler({
      runPs: async (args) => {
        psCalls += 1
        const selected = args[3].split(',').map(Number)
        maxPidsPerCall = Math.max(maxPidsPerCall, selected.length)
        return {
          exitCode: 0,
          stdout: selected.map((pid) => `${pid} 0:01 1024`).join('\n'),
          stderr: '',
        }
      },
    })
    const registered = registerResourcesRuntime({
      authority: authority as never,
      scope: SCOPE,
      supervision: {
        snapshot: () => ({ components: inventory.components }) as SupervisionSnapshot,
        requestStop: () => ({ ok: true as const, value: { confirmationId: 'c', generation: 1 } }),
        stop: async () => ({ ok: false as const, code: 'invalid_state', message: 'unused' }),
      },
      supervisionRecords: { list: () => inventory.records },
      resolveOwner: (componentId) => ({
        ownerKind: 'harness' as const,
        ownerId: inventory.sessionOf(componentId),
        runtimeSessionId: inventory.sessionOf(componentId),
      }),
      sampleProcesses: sampler,
      now: () => clock,
    })
    const pull = async () => {
      clock += 2_000
      return (await authority.providers['dev.resources.snapshot']!(
        command('dev.resources.snapshot', {})
      )) as { processes: unknown[]; metrics: Array<{ ownerId: string; runtimeSessionId?: string }> }
    }
    return {
      registered,
      authority,
      pull,
      psCalls: () => psCalls,
      maxPidsPerCall: () => maxPidsPerCall,
    }
  }

  test('one bounded ps observation per pull covers the full rotating inventory', async () => {
    const inventory = scaleInventory()
    const seams = bootScaleSeams(inventory)
    await seams.pull() // warm-up
    const pulls = 25 // 25 × 64-PID windows ≥ 1,000: full coverage
    for (let index = 0; index < pulls; index += 1) await seams.pull()
    expect(seams.psCalls()).toBe(pulls + 1)
    expect(seams.maxPidsPerCall()).toBe(SAMPLE_MAX_PIDS)
    const points = seams.registered.metrics.list()
    const owners = new Set(points.map((point) => point.ownerId))
    const sessions = new Set(
      points.map((point) => point.runtimeSessionId).filter((id) => id !== undefined)
    )
    expect(owners.size).toBe(PROCESSES)
    expect(sessions.size).toBe(SESSIONS)
    expect(points.every((point) => point.confidence === 'measured')).toBe(true)
  })

  test('process pagination stays correct at 1,000 rows', async () => {
    const inventory = scaleInventory()
    const seams = bootScaleSeams(inventory)
    const authority = seams.authority
    const seen = new Set<string>()
    let cursor: string | undefined
    let pages = 0
    do {
      const page = (await authority.providers['dev.resources.processes']!(
        command('dev.resources.processes', {
          limit: 100,
          ...(cursor !== undefined ? { cursor } : {}),
        })
      )) as { items: Array<{ id: string }>; nextCursor?: string }
      for (const item of page.items) seen.add(item.id)
      cursor = page.nextCursor
      pages += 1
    } while (cursor !== undefined)
    expect(pages).toBe(PROCESSES / 100)
    expect(seen.size).toBe(PROCESSES)
  })
})

describe('usage adapters and cache', () => {
  const USAGE_BODY = {
    period: { from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' },
    usage: [{ modelId: 'claude-sonnet', quantity: '1200', unit: 'requests', costMicros: '500' }],
  }

  test('official adapter gates credentials, maps typed failures, and never breaks the caller', async () => {
    let fetchCalls = 0
    const fetchImpl = (async () => {
      fetchCalls += 1
      return new Response(JSON.stringify(USAGE_BODY), { status: 200 })
    }) as typeof fetch
    const withoutCredential = createOfficialApiUsageAdapter({
      provider: 'claude',
      ownerId: 'usage:claude',
      endpoint: 'https://api.example.com/usage',
      parseResponse: parseUsagePayload,
      fetchImpl,
    })
    const gated = await withoutCredential.fetchUsage({ now: () => 0 })
    expect(gated).toMatchObject({ ok: false, code: 'auth_required' })
    expect(fetchCalls).toBe(0)
    const success = await createOfficialApiUsageAdapter({
      provider: 'claude',
      accountLabel: 'Team seat',
      ownerId: 'usage:claude',
      endpoint: 'https://api.example.com/usage',
      credential: 'secret-token',
      parseResponse: parseUsagePayload,
      fetchImpl,
    }).fetchUsage({ now: () => 0 })
    expect(success).toMatchObject({ ok: true })
    if (success.ok) {
      expect(success.observations[0]).toMatchObject({
        provider: 'claude',
        quantity: '1200',
        confidence: 'authoritative',
        accountLabel: 'Team seat',
      })
    }
    const unauthorized = await createOfficialApiUsageAdapter({
      provider: 'claude',
      ownerId: 'usage:claude',
      endpoint: 'https://api.example.com/usage',
      credential: 'secret-token',
      parseResponse: parseUsagePayload,
      fetchImpl: (async () => new Response('nope', { status: 401 })) as typeof fetch,
    }).fetchUsage({ now: () => 0 })
    expect(unauthorized).toMatchObject({ ok: false, code: 'auth_required' })
    const rateLimited = await createOfficialApiUsageAdapter({
      provider: 'claude',
      ownerId: 'usage:claude',
      endpoint: 'https://api.example.com/usage',
      credential: 'secret-token',
      parseResponse: parseUsagePayload,
      fetchImpl: (async () =>
        new Response('{}', { status: 429, headers: { 'retry-after': '30' } })) as typeof fetch,
    }).fetchUsage({ now: () => 0 })
    expect(rateLimited).toMatchObject({ ok: false, code: 'rate_limited', retryAfterSeconds: 30 })
    const schemaDrift = await createOfficialApiUsageAdapter({
      provider: 'claude',
      ownerId: 'usage:claude',
      endpoint: 'https://api.example.com/usage',
      credential: 'secret-token',
      parseResponse: parseUsagePayload,
      fetchImpl: (async () => new Response('{"usage":"half"}', { status: 200 })) as typeof fetch,
    }).fetchUsage({ now: () => 0 })
    expect(schemaDrift).toMatchObject({ ok: false, code: 'unavailable' })
  })

  test('service caches, honors the manual-refresh floor, and stores typed failure rows', async () => {
    let clock = 100_000
    let polls = 0
    const failing = createOfficialApiUsageAdapter({
      provider: 'codex',
      ownerId: 'usage:codex',
      endpoint: 'https://api.example.com/usage',
      credential: 'token',
      fetchImpl: (async () => new Response('nope', { status: 401 })) as typeof fetch,
    })
    const estimate = createLocalEstimateAdapter({
      provider: 'estimate',
      ownerId: 'usage:estimate',
      estimate: () => [
        {
          ownerId: 'session-1',
          provider: 'estimate',
          quantity: '4021',
          unit: 'tokens',
          confidence: 'estimated',
        },
      ],
    })
    const service = createUsageService({
      adapters: [failing, estimate],
      now: () => clock,
      randomId: () => randomUUID(),
      jitter: () => 0,
    })
    await service.refreshStale()
    polls += 2
    const codexRows = service.list('codex')
    expect(codexRows).toHaveLength(1)
    expect(codexRows[0]).toMatchObject({
      provider: 'codex',
      quantity: 'unknown',
      source: 'official_api',
    })
    expect(codexRows[0]?.failure).toMatchObject({ code: 'auth_required' })
    // The estimate rows are labeled estimates and never billing truth.
    expect(service.list('estimate')[0]).toMatchObject({
      source: 'local_transcript_estimate',
      confidence: 'estimated',
    })
    // Manual refresh inside the floor is served from cache (no new polls).
    clock += 1_000
    await service.manualRefresh()
    expect(polls).toBe(2)
    // After the floor the buckets refresh again.
    clock += MANUAL_REFRESH_FLOOR_MS + 1_000
    await service.refreshStale()
    expect(polls).toBeGreaterThanOrEqual(2)
  })

  test('fetch policy refuses non-HTTPS, unlisted hosts, and private DNS results', async () => {
    expect(
      admitUsageEndpoint('http://api.example.com/usage', { allowedHosts: ['api.example.com'] })
    ).toMatchObject({ ok: false, code: 'ssrf_blocked' })
    expect(
      admitUsageEndpoint('https://evil.example.com/usage', { allowedHosts: ['api.example.com'] })
    ).toMatchObject({ ok: false, code: 'remote_host_untrusted' })
    expect(
      admitUsageEndpoint('https://api.example.com/usage', {
        fixedEndpoint: 'https://api.example.com/usage',
      })
    ).toMatchObject({ ok: true })
    expect(
      admitUsageEndpoint(
        'https://api.example.com/usage',
        { fixedEndpoint: 'https://api.example.com/usage' },
        [{ address: '10.1.2.3', family: 4 }]
      )
    ).toMatchObject({ ok: false, code: 'ssrf_blocked' })
    expect(
      admitUsageEndpoint(
        'https://api.example.com/usage',
        { fixedEndpoint: 'https://api.example.com/usage' },
        []
      )
    ).toMatchObject({ ok: false, code: 'ssrf_blocked' })
    expect(isDeniedAddress('169.254.169.254')).toBe(true)
    expect(isDeniedAddress('8.8.8.8')).toBe(false)
  })
})

describe('cleanup policies', () => {
  const PREDICATES = [{ kind: 'clean' }, { kind: 'pushed' }, { kind: 'no_active_leases' }] as const

  function boot(options: {
    approvalVerifier?: Parameters<typeof createCleanupPolicyAuthority>[0]['approvalVerifier']
    worktreeFacts?: Parameters<typeof createCleanupPolicyAuthority>[0]['worktreeFacts']
  }) {
    const authority = stubAuthority()
    const created = createCleanupPolicyAuthority({
      authority: authority as never,
      dataDir: `/tmp/adea-resources-test-${randomUUID()}`,
      scope: SCOPE,
      ...(options.approvalVerifier ? { approvalVerifier: options.approvalVerifier } : {}),
      ...(options.worktreeFacts ? { worktreeFacts: options.worktreeFacts } : {}),
      randomId: () => randomUUID(),
    })
    return { authority, created }
  }

  test('approve fails closed without a proven owner approval; evaluation executes nothing', async () => {
    const { authority, created } = boot({
      worktreeFacts: () => ({ clean: 'true', pushed: 'true', active_leases: '0' }),
    })
    const policy = authority.providers['dev.cleanupPolicy.createDraft']!(
      command('dev.cleanupPolicy.createDraft', {
        projectId: 'proj-1',
        name: 'auto-clean merged',
        predicates: [...PREDICATES],
        allowedSteps: ['stop_owned_resource', 'prune_retained_data'],
      })
    ) as { id: string; version: number; state: string }
    expect(policy.state).toBe('draft')
    // No approval authority wired: approval must fail closed.
    expect(
      await errorOf(() =>
        authority.providers['dev.cleanupPolicy.approve']!(
          command(
            'dev.cleanupPolicy.approve',
            { cleanupPolicyId: policy.id, expectedVersion: 1, approvalId: 'approval-1' },
            { kind: 'cleanup_policy', id: policy.id, generation: 1 }
          )
        )
      )
    ).toMatchObject({ code: 'auth_required' })
    // A draft policy cannot be evaluated for execution.
    expect(
      await errorOf(() =>
        authority.providers['dev.cleanupPolicy.evaluate']!(
          command(
            'dev.cleanupPolicy.evaluate',
            {
              cleanupPolicyId: policy.id,
              expectedVersion: 1,
              worktreeId: 'wt-1',
              expectedGeneration: 1,
            },
            { kind: 'cleanup_policy', id: policy.id, generation: 1 }
          )
        )
      )
    ).toMatchObject({ code: 'invalid_state' })
    expect(created.policies()).toHaveLength(1)
  })

  test('an approved policy matches provable facts and fails closed on missing facts', async () => {
    let consumed = 0
    const approvalVerifier = {
      recordIssuance: () => undefined,
      consume: () => {
        consumed += 1
      },
    }
    const { authority } = boot({
      approvalVerifier,
      worktreeFacts: (worktreeId) =>
        worktreeId === 'wt-clean'
          ? { clean: 'true', pushed: 'true', active_leases: '0' }
          : undefined,
    })
    const policy = authority.providers['dev.cleanupPolicy.createDraft']!(
      command('dev.cleanupPolicy.createDraft', {
        projectId: 'proj-1',
        name: 'auto-clean merged',
        predicates: [...PREDICATES],
        allowedSteps: ['prune_retained_data'],
      })
    ) as { id: string; version: number }
    const approved = authority.providers['dev.cleanupPolicy.approve']!(
      command(
        'dev.cleanupPolicy.approve',
        { cleanupPolicyId: policy.id, expectedVersion: 1, approvalId: 'approval-1' },
        { kind: 'cleanup_policy', id: policy.id, generation: 1 }
      )
    ) as { state: string; version: number }
    expect(approved.state).toBe('approved')
    expect(approved.version).toBe(2)
    expect(consumed).toBe(1)
    const matched = (await authority.providers['dev.cleanupPolicy.evaluate']!(
      command(
        'dev.cleanupPolicy.evaluate',
        {
          cleanupPolicyId: policy.id,
          expectedVersion: 2,
          worktreeId: 'wt-clean',
          expectedGeneration: 1,
        },
        { kind: 'cleanup_policy', id: policy.id, generation: 2 }
      )
    )) as { matched: boolean; executesNothing: boolean; blockers: unknown[] }
    expect(matched.matched).toBe(true)
    expect(matched.executesNothing).toBe(true)
    // Unprovable facts block automatic cleanup (fail closed).
    const unmatched = (await authority.providers['dev.cleanupPolicy.evaluate']!(
      command(
        'dev.cleanupPolicy.evaluate',
        {
          cleanupPolicyId: policy.id,
          expectedVersion: 2,
          worktreeId: 'wt-dirty',
          expectedGeneration: 1,
        },
        { kind: 'cleanup_policy', id: policy.id, generation: 2 }
      )
    )) as { matched: boolean; blockers: Array<{ code: string }> }
    expect(unmatched.matched).toBe(false)
    expect(unmatched.blockers[0]).toMatchObject({ code: 'capability_unavailable' })
    // A stale policy version refuses evaluation.
    expect(
      await errorOf(() =>
        authority.providers['dev.cleanupPolicy.evaluate']!(
          command(
            'dev.cleanupPolicy.evaluate',
            {
              cleanupPolicyId: policy.id,
              expectedVersion: 1,
              worktreeId: 'wt-clean',
              expectedGeneration: 1,
            },
            { kind: 'cleanup_policy', id: policy.id, generation: 2 }
          )
        )
      )
    ).toMatchObject({ code: 'stale_version' })
  })

  test('predicate evaluation maps failed facts to typed blockers', async () => {
    const { matched, blockers } = evaluatePredicates([...PREDICATES], {
      clean: 'false',
      pushed: 'true',
      active_leases: '2',
    })
    expect(matched).toBe(false)
    expect(blockers.map((blocker) => blocker.code)).toEqual(['dirty', 'leased'])
    const allMatched = evaluatePredicates([{ kind: 'archived_for', seconds: 60 }], {
      archived_seconds: '61',
    })
    expect(allMatched.matched).toBe(true)
  })
})
