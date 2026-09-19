// The supervision engine (M10 #185): start/stop/restart with launch-record
// identity, the adopt/drain/crash-loop lifecycle the Dev Runtime sidecar
// registers with, dependency-aware readiness, and a secret-free audit ring.
// All decisions run against an injected clock and a fake process adapter, so
// restart policy and PID-reuse races are deterministic (TM-004).
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decodeComponentManifest,
  type ComponentManifest,
} from '../shell/src/supervision/component-manifest'
import { createSupervisor, type SupervisionAdapter } from '../shell/src/supervision/supervisor'
import { createRecordStore } from '../shell/src/supervision/records'

function manifestWith(...ids: string[]): ComponentManifest {
  const decoded = decodeComponentManifest({
    schemaVersion: 1,
    components: ids.map((id) => ({
      id,
      product: `Product ${id}`,
      version: '1.0.0',
      platform: 'universal',
      arch: 'universal',
      digestSha256: 'a'.repeat(64),
      signature: 'c2ln',
      compatibility: { minAppVersion: '0.1.0', maxAppVersion: '99.0.0' },
      installLocation: `components/${id}`,
      dataLocation: `components/${id}`,
      startupPhase: 0,
      dependsOn: [],
      healthProbe: { kind: 'process', intervalMs: 15_000, unhealthyAfterMs: 45_000 },
      protocol: null,
      rollbackTargetVersion: null,
      required: true,
    })),
  })
  if (!decoded.ok) throw new Error(`fixture manifest rejected: ${decoded.reason}`)
  return decoded.manifest
}

/** Fake adapter: processes live until the test exits or rekeys them. A
 *  well-behaved process dies on any signal; `diesOnlyOnKill` ignores SIGTERM;
 *  `unkillable` ignores every signal so stop stays unconfirmed. */
function fakeAdapter(mode: 'term' | 'kill-only' | 'never' = 'term') {
  let nextPid = 100
  const spawns: Array<{ componentId: string; generation: number }> = []
  const signals: Array<{ pid: number; signalName: string }> = []
  const live = new Map<number, { pidStartIdentity: string; executableIdentity: string }>()
  const groups = new Map<number, string>()
  const adapter = {
    async spawn(spec: { id: string }, generation: number) {
      const pid = ++nextPid
      spawns.push({ componentId: spec.id, generation })
      const identity = {
        pid,
        pidStartIdentity: `start-${pid}`,
        executableIdentity: `bundle://${spec.id}@1.0.0`,
      }
      live.set(pid, identity)
      groups.set(pid, `pgid-${pid}`)
      return { identity, processGroup: `pgid-${pid}` }
    },
    async currentIdentity(pid: number) {
      const identity = live.get(pid)
      if (!identity) return null
      // Group membership is observable in this fixture; a regrouped PID
      // betrays it through the ownership proof.
      return { ...identity, processGroup: groups.get(pid) ?? `pgid-${pid}` }
    },
    async probe() {
      return 'responsive' as const
    },
    async signalIdentity(identity: { pid: number }, signalName: string) {
      signals.push({ pid: identity.pid, signalName })
      const lethal = mode === 'term' || (mode === 'kill-only' && signalName === 'SIGKILL')
      if (lethal) {
        live.delete(identity.pid)
        groups.delete(identity.pid)
      }
    },
    /** The owned process died unexpectedly (crash or external kill). */
    exit(pid: number) {
      live.delete(pid)
      groups.delete(pid)
    },
    /** Simulates PID reuse by an unrelated process between scan and signal. */
    rekey(pid: number) {
      live.set(pid, { pidStartIdentity: `reused-${pid}`, executableIdentity: 'attacker' })
    },
    /** Same PID and start identity, but a replaced executable artifact. */
    swapExecutable(pid: number) {
      const identity = live.get(pid)
      if (identity) live.set(pid, { ...identity, executableIdentity: 'replaced-binary' })
    },
    /** The live process was moved into a foreign process group. */
    regroup(pid: number, group: string) {
      groups.set(pid, group)
    },
  }
  return {
    adapter: adapter as SupervisionAdapter,
    spawns,
    signals,
    rekey: adapter.rekey,
    exit: adapter.exit,
    swapExecutable: adapter.swapExecutable,
    regroup: adapter.regroup,
  }
}

function tickClock() {
  let now = 1_000_000
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
    },
  }
}

async function runningSupervisor(componentIds = ['cp']) {
  const fake = fakeAdapter()
  const clock = tickClock()
  const supervisor = createSupervisor({
    manifest: manifestWith(...componentIds),
    adapter: fake.adapter,
    now: clock.now,
  })
  for (const id of componentIds) {
    const started = await supervisor.start({ componentId: id, idempotencyKey: `key-${id}` })
    if (!started.ok) throw new Error(`fixture start failed: ${started.code}`)
  }
  return { supervisor, ...fake, ...clock }
}

describe('start and idempotency', () => {
  test('starts a component, records launch identity, and reports running', async () => {
    const { supervisor, spawns } = await runningSupervisor()
    const snapshot = supervisor.snapshot().components[0]
    expect(snapshot.state).toBe('running')
    expect(snapshot.generation).toBe(1)
    expect(snapshot.launch?.identity.pid).toBe(101)
    expect(snapshot.launch?.identity.pidStartIdentity).toBe('start-101')
    expect(spawns).toEqual([{ componentId: 'cp', generation: 1 }])
  })

  test('a repeated idempotency key resumes instead of spawning a second process', async () => {
    const { supervisor, spawns } = await runningSupervisor()
    const again = await supervisor.start({ componentId: 'cp', idempotencyKey: 'key-cp' })
    expect(again.ok).toBe(true)
    expect(spawns).toHaveLength(1)
  })

  test('restart starts a new generation and retires the old launch record', async () => {
    const { supervisor, spawns } = await runningSupervisor()
    const restarted = await supervisor.restart('cp')
    expect(restarted.ok).toBe(true)
    expect(spawns).toEqual([
      { componentId: 'cp', generation: 1 },
      { componentId: 'cp', generation: 2 },
    ])
    expect(supervisor.snapshot().components[0]).toMatchObject({ state: 'running', generation: 2 })
  })
})

describe('dependency-aware readiness', () => {
  test('a component refuses to start before its required dependency is healthy', async () => {
    const manifest = manifestWith('cp', 'pi')
    manifest.components[1].dependsOn = ['cp']
    const fake = fakeAdapter()
    const clock = tickClock()
    const supervisor = createSupervisor({ manifest, adapter: fake.adapter, now: clock.now })

    const blocked = await supervisor.start({ componentId: 'pi', idempotencyKey: 'pi-1' })
    expect(blocked).toMatchObject({ ok: false, code: 'capability_unavailable' })

    await supervisor.start({ componentId: 'cp', idempotencyKey: 'cp-1' })
    clock.advance(30_000)
    const degradedDependency = await supervisor.start({
      componentId: 'pi',
      idempotencyKey: 'pi-degraded',
    })
    expect(degradedDependency).toMatchObject({ ok: false, code: 'capability_unavailable' })

    clock.advance(15_000)
    const unhealthyDependency = await supervisor.start({
      componentId: 'pi',
      idempotencyKey: 'pi-unhealthy',
    })
    expect(unhealthyDependency).toMatchObject({ ok: false, code: 'capability_unavailable' })

    supervisor.heartbeat('cp')
    const ready = await supervisor.start({ componentId: 'pi', idempotencyKey: 'pi-healthy' })
    expect(ready.ok).toBe(true)
  })

  test('optional components stay out of baseline readiness without blocking it', async () => {
    const { supervisor } = await runningSupervisor(['cp'])
    expect(supervisor.baselineReady()).toEqual({ ready: true, missing: [] })
  })

  test('baseline readiness derives health at decision time, not from stored state', async () => {
    const { supervisor, advance } = await runningSupervisor()
    expect(supervisor.baselineReady()).toEqual({ ready: true, missing: [] })
    // Past unhealthyAfterMs with no heartbeat, and no health() call in
    // between: a stored 'healthy' flag alone would still report ready.
    advance(50_000)
    expect(supervisor.baselineReady()).toEqual({ ready: false, missing: ['cp'] })
  })
})

describe('stop and identity recheck (TM-004)', () => {
  test('operator stop confirmations are single-use and generation-bound', async () => {
    const { supervisor } = await runningSupervisor()
    const confirmation = supervisor.requestStop('cp')
    expect(confirmation.ok).toBe(true)
    if (!confirmation.ok) return
    const stopped = await supervisor.stop('cp', {
      confirmationId: confirmation.value.confirmationId,
    })
    expect(stopped.ok).toBe(true)
    const replay = await supervisor.stop('cp', {
      confirmationId: confirmation.value.confirmationId,
    })
    expect(replay.ok).toBe(false)
    expect(replay.ok ? '' : replay.code).toBe('already_completed')
  })

  test('reconciliation adopts only a still-owned persisted launch', async () => {
    const fake = fakeAdapter()
    const clock = tickClock()
    const recordsRoot = mkdtempSync(join(tmpdir(), 'adea-supervisor-'))
    const records = createRecordStore(recordsRoot)
    const first = createSupervisor({
      manifest: manifestWith('cp'),
      adapter: fake.adapter,
      records,
      now: clock.now,
    })
    await first.start({ componentId: 'cp', idempotencyKey: 'initial' })
    const revived = createSupervisor({
      manifest: manifestWith('cp'),
      adapter: fake.adapter,
      records,
      now: clock.now,
    })
    await revived.reconcile()
    expect(revived.snapshot().components[0]?.state).toBe('running')
    fake.rekey(101)
    const refused = createSupervisor({
      manifest: manifestWith('cp'),
      adapter: fake.adapter,
      records,
      now: clock.now,
    })
    await refused.reconcile()
    expect(refused.snapshot().components[0]?.state).toBe('idle')
    // A launch nobody could adopt is journaled exited, never left dangling.
    const journaled = records
      .list()
      .filter(
        (record) =>
          record.kind === 'exited' &&
          record.exitDetail === 'not observable after supervisor restart'
      )
    expect(journaled).toHaveLength(1)
    expect(journaled[0]?.expected).toBe(true)
    rmSync(recordsRoot, { recursive: true, force: true })
  })

  test('reconciliation never clobbers a launch this supervisor already owns', async () => {
    const fake = fakeAdapter()
    const clock = tickClock()
    const recordsRoot = mkdtempSync(join(tmpdir(), 'adea-supervisor-own-'))
    const records = createRecordStore(recordsRoot)
    const supervisor = createSupervisor({
      manifest: manifestWith('cp'),
      adapter: fake.adapter,
      records,
      now: clock.now,
    })
    await supervisor.start({ componentId: 'cp', idempotencyKey: 'own' })
    // A stale persisted record appears after this supervisor already started
    // its own process (an app-level race between start and reconcile).
    records.append({
      kind: 'launched',
      at: clock.now().toString(),
      componentId: 'cp',
      generation: 99,
      processRecordId: 'stale-record',
      identity: { pid: 555, pidStartIdentity: 'start-555', executableIdentity: 'stale' },
      processGroup: 'pgid-555',
    })
    await supervisor.reconcile()
    const component = supervisor.snapshot().components[0]
    expect(component.launch?.identity.pid).toBe(101)
    expect(component.generation).toBe(1)
    rmSync(recordsRoot, { recursive: true, force: true })
  })

  test('stop signals the recorded identity only after an immediate recheck', async () => {
    const { supervisor, signals } = await runningSupervisor()
    const stopped = await supervisor.stop('cp')
    expect(stopped.ok).toBe(true)
    expect(signals).toEqual([{ pid: 101, signalName: 'SIGTERM' }])
    expect(supervisor.snapshot().components[0].state).toBe('exited')
  })

  test('a PID reused by an unrelated process survives a stop command', async () => {
    const { supervisor, adapter, signals } = await runningSupervisor()
    adapter.rekey(101)
    const stopped = await supervisor.stop('cp')
    expect(stopped).toMatchObject({ ok: false, code: 'ownership_unproven' })
    expect(signals).toEqual([])
  })

  test('stopping under a stale generation is refused', async () => {
    const { supervisor } = await runningSupervisor()
    await supervisor.restart('cp')
    const stale = await supervisor.stop('cp', { generation: 1 })
    expect(stale).toMatchObject({ ok: false, code: 'stale_generation' })
  })

  test('stopping an already-exited component reports already_completed', async () => {
    const { supervisor } = await runningSupervisor()
    await supervisor.stop('cp')
    const again = await supervisor.stop('cp')
    expect(again).toMatchObject({ ok: false, code: 'already_completed' })
  })

  test('a replaced executable at the same PID start identity is never signalled', async () => {
    const { supervisor, adapter, signals } = await runningSupervisor()
    adapter.swapExecutable(101)
    const stopped = await supervisor.stop('cp')
    expect(stopped).toMatchObject({ ok: false, code: 'ownership_unproven' })
    expect(signals).toEqual([])
  })

  test('a process moved into a foreign process group is never signalled', async () => {
    const { supervisor, adapter, signals } = await runningSupervisor()
    adapter.regroup(101, 'attacker-pgid')
    const stopped = await supervisor.stop('cp')
    expect(stopped).toMatchObject({ ok: false, code: 'ownership_unproven' })
    expect(signals).toEqual([])
  })
})

describe('observed termination and escalation', () => {
  test('stop waits for observed termination and escalates to SIGKILL inside the window', async () => {
    const fake = fakeAdapter('kill-only')
    const clock = tickClock()
    const supervisor = createSupervisor({
      manifest: manifestWith('cp'),
      adapter: fake.adapter,
      now: clock.now,
      // The probe delay advances the injected clock instead of sleeping.
      delay: async () => clock.advance(250),
    })
    await supervisor.start({ componentId: 'cp', idempotencyKey: 'cp' })
    const stopped = await supervisor.stop('cp', { escalate: true })
    expect(stopped.ok).toBe(true)
    expect(fake.signals).toEqual([
      { pid: 101, signalName: 'SIGTERM' },
      { pid: 101, signalName: 'SIGKILL' },
    ])
    expect(supervisor.snapshot().components[0].state).toBe('exited')
  })

  test('a stop is never confirmed while the process may still be alive', async () => {
    const fake = fakeAdapter('never')
    const clock = tickClock()
    const recordsRoot = mkdtempSync(join(tmpdir(), 'adea-supervisor-unconfirmed-'))
    try {
      const supervisor = createSupervisor({
        manifest: manifestWith('cp'),
        adapter: fake.adapter,
        records: createRecordStore(recordsRoot),
        now: clock.now,
        stopGraceMs: 1_000,
        killGraceMs: 1_000,
        delay: async () => clock.advance(500),
      })
      await supervisor.start({ componentId: 'cp', idempotencyKey: 'cp' })
      const stopped = await supervisor.stop('cp', { escalate: true })
      expect(stopped).toMatchObject({ ok: false, code: 'stop_unconfirmed' })
      // The launch record and stopping state survive: the truth is not fabricated.
      const component = supervisor.snapshot().components[0]
      expect(component.state).toBe('stopping')
      expect(component.launch?.identity.pid).toBe(101)
      // No exit event was recorded for a process nobody observed exiting.
      expect(supervisor.audit().filter((event) => event.kind === 'exit')).toEqual([])
      // A late real exit reconciles: counted failure, supervised restart.
      fake.exit(101)
      const recycled = await supervisor.reportUnexpectedExit('cp')
      expect(recycled).toMatchObject({ ok: true, value: 'restarted' })
      expect(supervisor.snapshot().components[0]).toMatchObject({
        state: 'running',
        generation: 2,
      })
    } finally {
      rmSync(recordsRoot, { recursive: true, force: true })
    }
  })

  test('a restart never starts a replacement while the old process may live', async () => {
    const fake = fakeAdapter('never')
    const clock = tickClock()
    const supervisor = createSupervisor({
      manifest: manifestWith('cp'),
      adapter: fake.adapter,
      now: clock.now,
      stopGraceMs: 500,
      killGraceMs: 500,
      delay: async () => clock.advance(500),
    })
    await supervisor.start({ componentId: 'cp', idempotencyKey: 'cp' })
    const restarted = await supervisor.restart('cp')
    expect(restarted).toMatchObject({ ok: false, code: 'stop_unconfirmed' })
    expect(fake.spawns).toHaveLength(1)
    expect(supervisor.snapshot().components[0]).toMatchObject({ state: 'stopping', generation: 1 })
  })
})

describe('crash-loop policy', () => {
  async function crashNTimes(n: number) {
    const { supervisor, adapter, spawns, advance } = await runningSupervisor()
    for (let i = 0; i < n; i++) {
      adapter.exit(101 + i)
      await supervisor.reportUnexpectedExit('cp')
      advance(60_000)
    }
    return { supervisor, adapter, spawns, advance }
  }

  test('five unexpected exits within ten minutes stop restarts and surface crash_loop', async () => {
    const { supervisor, spawns } = await crashNTimes(5)
    expect(supervisor.snapshot().components[0]).toMatchObject({ state: 'crash_loop' })
    expect(spawns).toHaveLength(5) // initial launch plus four restarts; the fifth exit stops the loop
    const start = await supervisor.start({ componentId: 'cp', idempotencyKey: 'retry' })
    expect(start).toMatchObject({ ok: false, code: 'crash_loop' })
  })

  test('failures older than the window age out, so spaced failures never accumulate', async () => {
    const { supervisor, adapter, advance, spawns } = await runningSupervisor()
    for (let i = 0; i < 6; i++) {
      adapter.exit(101 + i)
      await supervisor.reportUnexpectedExit('cp')
      advance(11 * 60_000) // each failure leaves the window before the next
    }
    expect(supervisor.snapshot().components[0].state).toBe('running')
    expect(spawns.length).toBe(7) // initial + one restart per failure
  })

  test('crash_loop clears only through an explicit operator restart', async () => {
    const { supervisor, adapter, spawns, advance } = await runningSupervisor()
    for (let i = 0; i < 5; i++) {
      adapter.exit(101 + i)
      await supervisor.reportUnexpectedExit('cp')
      advance(60_000)
    }
    expect(supervisor.snapshot().components[0]).toMatchObject({ state: 'crash_loop' })
    const refused = await supervisor.start({ componentId: 'cp', idempotencyKey: 'retry' })
    expect(refused).toMatchObject({ ok: false, code: 'crash_loop' })

    const cleared = await supervisor.restart('cp')
    expect(cleared.ok).toBe(true)
    expect(supervisor.snapshot().components[0]).toMatchObject({ state: 'running', generation: 6 })
    expect(spawns).toHaveLength(6)
  })

  test('an expected stop never counts toward the crash window', async () => {
    const { supervisor, spawns } = await runningSupervisor()
    for (let i = 0; i < 5; i++) {
      await supervisor.start({ componentId: 'cp', idempotencyKey: `k${i}` })
      await supervisor.stop('cp')
    }
    expect(supervisor.snapshot().components[0].state).toBe('exited')
    expect(spawns).toHaveLength(5)
  })

  test('the crash-loop verdict survives a supervisor restart through durable records', async () => {
    const dir = `${import.meta.dir}/.tmp-supervision-records`
    rmSync(dir, { force: true, recursive: true })
    try {
      const first = fakeAdapter()
      const clock = tickClock()
      const supervisor = createSupervisor({
        manifest: manifestWith('cp'),
        adapter: first.adapter,
        records: createRecordStore(dir),
        now: clock.now,
      })
      await supervisor.start({ componentId: 'cp', idempotencyKey: 'first' })
      for (let i = 0; i < 5; i++) {
        first.adapter.exit(101 + i)
        await supervisor.reportUnexpectedExit('cp')
        clock.advance(60_000)
      }
      expect(supervisor.snapshot().components[0].state).toBe('crash_loop')

      // A fresh supervisor over the same durable records inherits the verdict.
      const revived = createSupervisor({
        manifest: manifestWith('cp'),
        adapter: fakeAdapter().adapter,
        records: createRecordStore(dir),
        now: tickClock().now,
      })
      const start = await revived.start({ componentId: 'cp', idempotencyKey: 'revived' })
      expect(start).toMatchObject({ ok: false, code: 'crash_loop' })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})

describe('health probes', () => {
  test('missed heartbeats degrade and then mark unhealthy inside the probe window', async () => {
    const { supervisor, advance } = await runningSupervisor()
    expect(supervisor.health('cp')).toBe('healthy')
    advance(30_000) // two missed 15 s intervals
    expect(supervisor.health('cp')).toBe('degraded')
    advance(15_000) // past the 45 s unhealthy threshold
    expect(supervisor.health('cp')).toBe('unhealthy')
  })

  test('a heartbeat refresh restores health', async () => {
    const { supervisor, advance } = await runningSupervisor()
    advance(50_000)
    expect(supervisor.health('cp')).toBe('unhealthy')
    supervisor.heartbeat('cp')
    expect(supervisor.health('cp')).toBe('healthy')
  })

  test('an unresponsive owned process is signalled and recycled as a failure', async () => {
    const { supervisor, signals } = await runningSupervisor()
    const outcome = await supervisor.reportUnresponsive('cp')
    expect(outcome.ok).toBe(true)
    expect(signals).toEqual([{ pid: 101, signalName: 'SIGTERM' }])
    expect(supervisor.snapshot().components[0].generation).toBe(2)
  })
})

describe('sidecar registration: adopt, drain, incompatible', () => {
  function sidecarSupervisor(expectedProtocol: { major: number; minor: number }) {
    const manifest = manifestWith('dev-runtime-sidecar')
    manifest.components[0].protocol = { name: 'adea.sidecar.terminal', ...expectedProtocol }
    const fake = fakeAdapter()
    const clock = tickClock()
    const supervisor = createSupervisor({ manifest, adapter: fake.adapter, now: clock.now })
    return { supervisor, ...fake }
  }

  const RUNNING = {
    componentId: 'dev-runtime-sidecar',
    protocol: { name: 'adea.sidecar.terminal', major: 1, minor: 0 },
  }

  test('an exact protocol version adopts the running sidecar', async () => {
    const { supervisor } = sidecarSupervisor({ major: 1, minor: 0 })
    await supervisor.start({ componentId: 'dev-runtime-sidecar', idempotencyKey: 'sidecar' })
    expect(supervisor.evaluateAdoption(RUNNING)).toMatchObject({ decision: 'adopt' })
  })

  test('a compatible minor migration drains: sessions are retained until detached', async () => {
    const { supervisor, signals } = await sidecarSupervisor({ major: 1, minor: 1 })
    await supervisor.start({ componentId: 'dev-runtime-sidecar', idempotencyKey: 'sidecar' })
    expect(supervisor.evaluateAdoption(RUNNING)).toMatchObject({ decision: 'drain_upgrade' })

    const draining = await supervisor.drain('dev-runtime-sidecar')
    expect(draining.ok).toBe(true)
    expect(supervisor.snapshot().components[0].state).toBe('draining')

    // The running sidecar keeps serving until its sessions are detached.
    const stoppedEarly = await supervisor.stop('dev-runtime-sidecar')
    expect(stoppedEarly).toMatchObject({ ok: false, code: 'invalid_state' })

    await supervisor.sessionsDrained('dev-runtime-sidecar')
    const stopped = await supervisor.stop('dev-runtime-sidecar')
    expect(stopped.ok).toBe(true)
    expect(signals).toEqual([{ pid: 101, signalName: 'SIGTERM' }])
  })

  test('a different major protocol version is sidecar_incompatible with no PID/port fallback', async () => {
    const { supervisor } = sidecarSupervisor({ major: 2, minor: 0 })
    await supervisor.start({ componentId: 'dev-runtime-sidecar', idempotencyKey: 'sidecar' })
    expect(supervisor.evaluateAdoption(RUNNING)).toMatchObject({
      decision: 'incompatible',
      code: 'sidecar_incompatible',
    })
  })
})

describe('audit and diagnostics', () => {
  test('supervision decisions append a bounded, secret-free audit ring', async () => {
    const { supervisor } = await runningSupervisor()
    await supervisor.stop('cp')
    const audit = supervisor.audit()
    expect(audit.length).toBeGreaterThan(0)
    expect(audit.length).toBeLessThanOrEqual(500)
    for (const event of audit) {
      expect(Object.keys(event).toSorted()).toEqual([
        'at',
        'componentId',
        'detail',
        'generation',
        'kind',
      ])
      expect(typeof event.detail).toBe('string')
    }
  })

  test('the snapshot exposes exact packaged versions and digests for diagnostics', async () => {
    const { supervisor } = await runningSupervisor()
    const snapshot = supervisor.snapshot()
    expect(snapshot.components[0].manifest).toMatchObject({
      version: '1.0.0',
      digestSha256: 'a'.repeat(64),
    })
  })
})
