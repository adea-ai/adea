// Issue #396 manager contract: sequence-numbered byte chunks, bounded ring,
// exactly-once replay, resync for uncovered/slow subscribers, subscriber and
// input limits, lifecycle transitions, and serialized per-terminal
// operations. Backpressure must never block PTY draining.
import { describe, expect, test } from 'bun:test'

import { TERMINAL_LIMITS } from '../shell/src/dev-runtime/terminal/limits'
import {
  consumeDeviceAttributes,
  createTerminalManager,
  type TerminalChunk,
} from '../shell/src/dev-runtime/terminal/terminal-manager'
import { createFakePtyAdapter, type FakePtyProcess } from './fixtures/fake-pty'

const testLimits = {
  ...TERMINAL_LIMITS,
  maxChunkBytes: 32,
  ringMaxBytes: 128,
  ringMaxChunks: 100,
  maxSubscribers: 2,
  inputQueueMaxBytes: 8,
  subscriberHighWaterBytes: 48,
}

function textOf(chunks: TerminalChunk[]): string {
  const bytes = chunks.flatMap((chunk) => [...chunk.bytes])
  return new TextDecoder().decode(new Uint8Array(bytes))
}

async function createManager(overrides?: Partial<Parameters<typeof createTerminalManager>[0]>) {
  const fake = createFakePtyAdapter()
  const manager = createTerminalManager({
    ptyAdapter: fake.adapter,
    outputBatchDelayMs: 1,
    limits: testLimits,
    ...overrides,
  })
  return { fake, manager }
}

async function spawnTerminal(
  manager: ReturnType<typeof createTerminalManager>['manager'],
  terminalId = 't-1'
) {
  const created = await manager.create({
    terminalId,
    generation: 1,
    cols: 80,
    rows: 24,
    shell: '/bin/zsh',
    args: ['-l'],
    cwd: '/tmp',
    env: {},
  })
  expect(created.ok).toBe(true)
  return terminalId
}

describe('terminal manager', () => {
  test('emits bounded sequence chunks that preserve fragmented and invalid UTF-8 bytes', async () => {
    const { fake, manager } = await createManager()
    const terminalId = await spawnTerminal(manager)
    const process = fake.processes[0]!
    const invalidUtf8 = new Uint8Array([0x68, 0xe4, 0xf6, 0xfc, 0xff, 0x62, 0x79, 0x65]) // häöü?bye, broken
    process.emit(invalidUtf8.subarray(0, 3))
    process.emit(invalidUtf8.subarray(3, 5))
    process.emit(invalidUtf8.subarray(5))
    await Bun.sleep(20)
    const chunks = manager.chunks(terminalId, '0')
    expect(chunks.map((chunk) => chunk.seq)).toEqual(['0'])
    expect([...chunks[0]!.bytes]).toEqual([...invalidUtf8])
    expect(chunks[0]!.generation).toBe(1)
    expect(chunks[0]!.terminalId).toBe(terminalId)
  })

  test('splits output at the maximum chunk bound', async () => {
    const { fake, manager } = await createManager()
    const terminalId = await spawnTerminal(manager)
    fake.processes[0]!.emit(new Uint8Array(80).fill(0x61))
    await Bun.sleep(20)
    const chunks = manager.chunks(terminalId, '0')
    expect(chunks.map((chunk) => chunk.bytes.byteLength)).toEqual([32, 32, 16])
  })

  test('answers a fragmented device-attributes query once and keeps the surrounding bytes', async () => {
    const { fake, manager } = await createManager()
    const terminalId = await spawnTerminal(manager)
    const process = fake.processes[0]!
    process.emit(new Uint8Array([0x61, 0x1b]))
    process.emit(new Uint8Array([0x5b]))
    process.emit(new Uint8Array([0x30, 0x63, 0x62]))
    await Bun.sleep(20)
    expect(textOf(manager.chunks(terminalId, '0'))).toBe('ab')
    const replies = process.written.filter((bytes) => bytes[0] === 0x1b && bytes[1] === 0x5b)
    expect(replies).toHaveLength(1)
    expect([...replies[0]!]).toEqual([0x1b, 0x5b, 0x3f, 0x31, 0x3b, 0x32, 0x63])
  })

  test('byte-level device-attributes scanner keeps adjacent escape sequences', () => {
    // ESC [ 0 c preceded and followed by other CSI output.
    const input = new Uint8Array([0x1b, 0x5b, 0x32, 0x4a, 0x1b, 0x5b, 0x30, 0x63, 0x1b, 0x5b, 0x4b])
    const result = consumeDeviceAttributes(0, input)
    expect(result.queries).toBe(1)
    expect([...result.output]).toEqual([0x1b, 0x5b, 0x32, 0x4a, 0x1b, 0x5b, 0x4b])
    expect(result.pending).toBe(0)
  })

  test('replays covered sequences exactly once in order and then streams live', async () => {
    const { fake, manager } = await createManager()
    const terminalId = await spawnTerminal(manager)
    const process = fake.processes[0]!
    process.emit(new TextEncoder().encode('first '))
    await Bun.sleep(10)
    process.emit(new TextEncoder().encode('batch'))
    await Bun.sleep(10)

    const delivered: TerminalChunk[] = []
    const attached = manager.attach(
      terminalId,
      { id: 'sub-1', deliver: (c) => delivered.push(c) },
      '0'
    )
    expect(attached).toEqual({
      ok: true,
      value: { resyncRequired: false, replayed: 2, nextSeq: '2' },
    })
    expect(textOf(delivered)).toBe('first batch')
    process.emit(new TextEncoder().encode('+live'))
    await Bun.sleep(10)
    expect(textOf(delivered)).toBe('first batch+live')
  })

  test('coverage below the ring returns a resync anchor instead of silent truncation', async () => {
    const { fake, manager } = await createManager()
    const terminalId = await spawnTerminal(manager)
    const process = fake.processes[0]!
    // Push more than ringMaxBytes through to force pruning of early sequences.
    for (let batch = 0; batch < 12; batch += 1) {
      process.emit(new Uint8Array(24).fill(0x62 + batch))
      await Bun.sleep(6)
    }
    const coverage = manager.coverage(terminalId)!
    expect(Number(coverage.oldestSeq)).toBeGreaterThan(0)
    const resyncs: string[] = []
    const attached = manager.attach(terminalId, { id: 'sub-late', deliver: () => {} }, '0')
    expect(attached.ok).toBe(true)
    if (attached.ok && attached.value.resyncRequired) {
      resyncs.push(attached.value.checkpointSequence)
      expect(attached.value.checkpointSequence).toBe(coverage.oldestSeq)
    } else {
      throw new Error('expected resyncRequired for uncovered sinceSeq')
    }
    expect(resyncs).toHaveLength(1)
    // The manager marks health so clients see a degraded replay surface.
    expect(manager.snapshot(terminalId)?.health).toBe('replay_required')
  })

  test('sinceSeq beyond the terminal sequence is a typed sequence gap', async () => {
    const { manager } = await createManager()
    const terminalId = await spawnTerminal(manager)
    const result = manager.attach(terminalId, { id: 'sub', deliver: () => {} }, '99')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('sequence_gap')
  })

  test('a slow subscriber gets a resync notice while the PTY keeps draining', async () => {
    const resyncNotices: Array<{ subscriberId: string; checkpointSequence: string }> = []
    const { fake, manager } = await createManager({
      events: {
        onResync: (notice) => resyncNotices.push(notice),
      },
    })
    const terminalId = await spawnTerminal(manager)
    const delivered: TerminalChunk[] = []
    const attached = manager.attach(
      terminalId,
      { id: 'sub-slow', deliver: (chunk) => delivered.push(chunk) },
      '0'
    )
    expect(attached.ok).toBe(true)
    // subscriberHighWaterBytes is 48 in the test limits: write more without acks.
    const process = fake.processes[0]!
    for (let index = 0; index < 6; index += 1) {
      process.emit(new Uint8Array(24).fill(0x73))
      await Bun.sleep(6)
    }
    expect(resyncNotices).toEqual([
      {
        subscriberId: 'sub-slow',
        terminalId,
        reason: 'backpressure',
        checkpointSequence: expect.any(String),
      },
    ])
    const beforePause = manager.coverage(terminalId)!.nextSeq
    // The PTY reader keeps draining: later output still lands in the ring.
    process.emit(new Uint8Array(24).fill(0x74))
    await Bun.sleep(6)
    expect(Number(manager.coverage(terminalId)!.nextSeq)).toBeGreaterThan(Number(beforePause))
    // A resynced subscriber receives nothing further, even with fresh credit:
    // the contract is re-attach from the checkpoint, not silent catch-up.
    const pausedLength = delivered.length
    process.emit(new Uint8Array(24).fill(0x75))
    manager.acknowledge(terminalId, 'sub-slow', 96)
    await Bun.sleep(10)
    expect(delivered.length).toBe(pausedLength)
    // A fresh attach from the oldest still-covered anchor replays once.
    const coveredAnchor = manager.coverage(terminalId)!.oldestSeq
    const caughtUp: TerminalChunk[] = []
    const reattached = manager.attach(
      terminalId,
      { id: 'sub-slow-2', deliver: (chunk) => caughtUp.push(chunk) },
      coveredAnchor
    )
    expect(reattached.ok).toBe(true)
    if (reattached.ok && !reattached.value.resyncRequired) {
      expect(reattached.value.replayed).toBeGreaterThan(0)
      expect(reattached.value.nextSeq).toBe(manager.coverage(terminalId)!.nextSeq)
    }
    expect(caughtUp[0]!.seq).toBe(coveredAnchor)
    // An anchor that pruning has already passed resyncs again with a newer one.
    manager.detach(terminalId, 'sub-slow')
    const stale = manager.attach(
      terminalId,
      { id: 'sub-slow-3', deliver: () => {} },
      resyncNotices[0]!.checkpointSequence < coveredAnchor
        ? resyncNotices[0]!.checkpointSequence
        : '0'
    )
    expect(stale.ok).toBe(true)
    if (stale.ok) {
      expect(stale.value.resyncRequired).toBe(true)
      if (stale.value.resyncRequired) expect(stale.value.checkpointSequence).toBe(coveredAnchor)
    }
    manager.detach(terminalId, 'sub-slow-2')
    manager.detach(terminalId, 'sub-slow-3')
  })

  test('enforces the subscriber limit', async () => {
    const { manager } = await createManager()
    const terminalId = await spawnTerminal(manager)
    expect(manager.attach(terminalId, { id: 'a', deliver: () => {} }, '0').ok).toBe(true)
    expect(manager.attach(terminalId, { id: 'b', deliver: () => {} }, '0').ok).toBe(true)
    const third = manager.attach(terminalId, { id: 'c', deliver: () => {} }, '0')
    expect(third.ok).toBe(false)
    if (!third.ok) expect(third.error.code).toBe('limit_exceeded')
  })

  test('detach keeps the PTY alive and flips the lifecycle to detached', async () => {
    const { fake, manager } = await createManager()
    const terminalId = await spawnTerminal(manager)
    manager.attach(terminalId, { id: 'a', deliver: () => {} }, '0')
    const detached = manager.detach(terminalId, 'a')
    expect(detached).toEqual({ ok: true, value: 'detached' })
    expect(manager.snapshot(terminalId)?.lifecycle).toBe('detached')
    const process = fake.processes[0] as FakePtyProcess
    expect(process.kills).toEqual([])
    // Reattach returns the session to running.
    manager.attach(terminalId, { id: 'b', deliver: () => {} }, '0')
    expect(manager.snapshot(terminalId)?.lifecycle).toBe('running')
  })

  test('input over the queue limit is backpressure and the PTY never sees it', async () => {
    const { fake, manager } = await createManager()
    const terminalId = await spawnTerminal(manager)
    const rejected = manager.write(terminalId, new Uint8Array(testLimits.inputQueueMaxBytes + 1))
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.code).toBe('backpressure')
    expect(fake.processes[0]!.written).toHaveLength(0)
    const accepted = manager.write(terminalId, new Uint8Array([0x0d]))
    expect(accepted).toEqual({ ok: true, value: 'written' })
  })

  test('resize updates dimensions and deduplicates same-size calls', async () => {
    const { fake, manager } = await createManager()
    const terminalId = await spawnTerminal(manager)
    expect(manager.resize(terminalId, 120, 40)).toEqual({ ok: true, value: 'resized' })
    expect(manager.resize(terminalId, 120, 40)).toEqual({ ok: true, value: 'resized' })
    expect(fake.processes[0]!.resizes).toEqual([{ cols: 120, rows: 40 }])
    expect(manager.snapshot(terminalId)).toMatchObject({ cols: 120, rows: 40 })
  })

  test('terminate escalates to SIGKILL only when the process survives SIGTERM', async () => {
    const exits: Array<{ terminalId: string; exitCode: number | null }> = []
    const { fake, manager } = await createManager({
      closeGracePeriodMs: 10,
      events: { onExit: (notice) => exits.push(notice) },
    })
    const terminalId = await spawnTerminal(manager)
    manager.attach(terminalId, { id: 'a', deliver: () => {} }, '0')
    fake.processes[0]!.ignoreSignals = true
    const terminating = manager.terminate(terminalId)
    expect(terminating).toEqual({ ok: true, value: 'terminating' })
    expect(manager.snapshot(terminalId)?.lifecycle).toBe('terminating')
    await Bun.sleep(30)
    expect(fake.processes[0]!.kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(exits.map((exit) => exit.terminalId)).toEqual([terminalId])
    expect(manager.has(terminalId)).toBe(false)
    const writeAfterExit = manager.write(terminalId, new Uint8Array([1]))
    expect(writeAfterExit.ok).toBe(false)
    if (!writeAfterExit.ok) expect(writeAfterExit.error.code).toBe('not_found')
  })

  test('a process that exits on SIGTERM never receives the SIGKILL escalation', async () => {
    const { fake, manager } = await createManager({ closeGracePeriodMs: 10 })
    const terminalId = await spawnTerminal(manager)
    expect(manager.terminate(terminalId)).toEqual({ ok: true, value: 'terminating' })
    await Bun.sleep(30)
    expect(fake.processes[0]!.kills).toEqual(['SIGTERM'])
    expect(manager.has(terminalId)).toBe(false)
  })

  test('unexpected process exit flushes pending output and removes the session', async () => {
    const exits: Array<{ terminalId: string; exitCode: number | null }> = []
    const { fake, manager } = await createManager({
      events: { onExit: (notice) => exits.push(notice) },
    })
    const terminalId = await spawnTerminal(manager)
    const delivered: TerminalChunk[] = []
    manager.attach(terminalId, { id: 'a', deliver: (chunk) => delivered.push(chunk) }, '0')
    fake.processes[0]!.emit(new TextEncoder().encode('dying words'))
    fake.processes[0]!.exit(7)
    await Bun.sleep(20)
    expect(exits).toEqual([{ terminalId, generation: 1, exitCode: 7 }])
    expect(textOf(delivered)).toBe('dying words')
    expect(manager.has(terminalId)).toBe(false)
  })

  test('duplicate create and unknown terminal refs are typed errors', async () => {
    const { manager } = await createManager()
    const terminalId = await spawnTerminal(manager)
    const duplicate = await manager.create({
      terminalId,
      generation: 1,
      cols: 80,
      rows: 24,
      shell: '/bin/zsh',
      args: [],
      cwd: '/tmp',
      env: {},
    })
    expect(duplicate.ok).toBe(false)
    expect(manager.snapshot('missing')).toBeUndefined()
    expect(manager.attach('missing', { id: 'a', deliver: () => {} }, '0').ok).toBe(false)
    expect(manager.detach('missing', 'a').ok).toBe(false)
    expect(manager.write('missing', new Uint8Array([1])).ok).toBe(false)
    expect(manager.resize('missing', 80, 24).ok).toBe(false)
    expect(manager.signal('missing', 'SIGINT').ok).toBe(false)
    expect(manager.terminate('missing').ok).toBe(false)
  })
})
