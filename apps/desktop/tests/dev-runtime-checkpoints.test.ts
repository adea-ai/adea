import { afterEach, describe, expect, test } from 'bun:test'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import {
  devCommandProofMessage,
  type DevCommand,
  type RuntimeSession,
  type Scope,
} from '../../../packages/types/src/dev-runtime'
import {
  createConversationCheckpointRuntime,
  type CheckpointRestoreAdapter,
} from '../shell/src/dev-runtime/harness/checkpoints'
import { createSessionEventLog } from '../shell/src/dev-runtime/harness/events'
import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import { registerHarnessRuntime } from '../shell/src/dev-runtime/harness/register'
import { createDurableJsonStore } from '../shell/src/dev-runtime/host-store'
import { registerProjectSessionRuntime } from '../shell/src/dev-runtime/project-session/register'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const original: RuntimeSession = {
  id: 'session-1',
  scope,
  projectId: 'project-1',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  generation: 1,
  version: 1,
  archived: false,
  lifecycle: 'active',
  projection: 'structured',
  activeHarnessRunId: 'run-1',
  harnessInstallationId: 'installation-1',
}
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function setup(restoreAdapter?: CheckpointRestoreAdapter) {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-checkpoints-'))
  dirs.push(dataDir)
  let session: RuntimeSession | undefined = original
  const commits = new Map<
    string,
    { runtimeSessionId: string; generation: number; version: number }
  >()
  const events = createSessionEventLog({ dataDir, scope })
  const options = {
    dataDir,
    scope,
    events,
    adapter: restoreAdapter,
    resolveSession: (id: string) => (session?.id === id ? session : undefined),
    persistSession: (next: RuntimeSession, restoreId?: string) => {
      session = next
      if (restoreId)
        commits.set(restoreId, {
          runtimeSessionId: next.id,
          generation: next.generation,
          version: next.version,
        })
    },
    getSessionRestoreCommit: (restoreId: string) => commits.get(restoreId),
  }
  const runtime = createConversationCheckpointRuntime(options)
  const checkpoint = runtime.observe({
    runtimeSessionId: original.id,
    expectedGeneration: 1,
    checkpointId: 'checkpoint-1',
    name: 'Before refactor',
    createdAt: '2026-10-15T05:00:00Z',
    sourceEventId: 'native-checkpoint-1',
  })!
  return {
    runtime,
    checkpoint,
    options,
    events,
    current: () => session!,
    setSession: (next: RuntimeSession | undefined) => {
      session = next
    },
  }
}
function durableSessionOptions(s: ReturnType<typeof setup>) {
  const store = createDurableJsonStore<{ session: RuntimeSession; restoreId?: string }>({
    file: join(s.options.dataDir, 'sessions.json'),
    schemaVersion: 1,
    label: 'test sessions',
  })
  store.save([{ session: original }])
  const read = () => store.load().records
  return {
    ...s.options,
    resolveSession: (id: string) => read().find((entry) => entry.session.id === id)?.session,
    persistSession: (session: RuntimeSession, restoreId?: string) =>
      store.save([{ session, restoreId }]),
    getSessionRestoreCommit: (restoreId: string) => {
      const applied = read().find((entry) => entry.restoreId === restoreId)?.session
      return (
        applied && {
          runtimeSessionId: applied.id,
          generation: applied.generation,
          version: applied.version,
        }
      )
    },
    sessions: () => read().map((entry) => entry.session),
  }
}
function command(checkpointEventId: string, overrides: Partial<DevCommand> = {}): DevCommand {
  return {
    schemaVersion: 1,
    operation: 'dev.session.restoreCheckpoint',
    requestId: randomUUID(),
    nonce: randomBytes(24).toString('base64url'),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    scope,
    capabilities: ['dev.session.manage'],
    idempotencyKey: 'restore-key-1',
    resource: { kind: 'runtime_session', id: original.id, generation: 1 },
    body: { runtimeSessionId: original.id, expectedGeneration: 1, checkpointEventId },
    ...overrides,
  }
}
function adapter(run?: CheckpointRestoreAdapter['restore']): CheckpointRestoreAdapter {
  return {
    installationId: 'installation-1',
    source: 'native',
    restore:
      run ??
      (async (input) => {
        input.assertCurrent()
        return {
          status: 'restored',
          restoreId: input.restoreId,
          expectedGeneration: input.session.generation,
          runtimeSessionId: original.id,
          harnessRunId: 'run-1',
          checkpointId: input.checkpoint.checkpointId,
          providerRestoreId: `confirmed-${input.restoreId}`,
          observedAt: new Date().toISOString(),
        }
      }),
  }
}

describe('conversation checkpoint restore authority', () => {
  test('unsupported production capability emits one failed outcome and never pretends to restore', async () => {
    const s = setup()
    expect(s.checkpoint.payload).toMatchObject({
      restore: { supported: false, reason: 'harness_restore_unavailable' },
    })
    const request = command(s.checkpoint.eventId)
    await expect(s.runtime.restore(request)).rejects.toMatchObject({
      code: 'capability_unavailable',
    })
    await expect(s.runtime.restore({ ...request, requestId: randomUUID() })).rejects.toMatchObject({
      code: 'capability_unavailable',
    })
    expect(s.current()).toEqual(original)
    expect(s.events.events().map((event) => event.kind)).toEqual([
      'checkpoint.observed',
      'checkpoint.restore_requested',
      'checkpoint.restore_failed',
    ])
    expect(s.runtime.journal().filter((entry) => entry.phase === 'outcome')).toHaveLength(1)
  })

  test('only confirmed adapter evidence advances generation; replay is stable across restart and preserves prior events', async () => {
    let calls = 0
    const driver = adapter(async (input) => {
      calls++
      return adapter().restore(input)
    })
    const s = setup(driver)
    const prior = s.events.events()[0]
    const request = command(s.checkpoint.eventId)
    const outcome = await s.runtime.restore(request)
    expect(outcome).toMatchObject({
      status: 'resolved',
      requestedGeneration: 1,
      restoredGeneration: 2,
    })
    expect(s.current()).toMatchObject({ generation: 2, version: 2, activeHarnessRunId: 'run-1' })
    const restarted = createConversationCheckpointRuntime(s.options)
    expect(await restarted.restore({ ...request, requestId: randomUUID() })).toEqual(outcome)
    const reordered = createConversationCheckpointRuntime({
      ...s.options,
      scope: {
        runtimeNodeId: scope.runtimeNodeId,
        workspaceId: scope.workspaceId,
        accountId: scope.accountId,
      },
    })
    expect(await reordered.restore({ ...request, requestId: randomUUID() })).toEqual(outcome)
    expect(calls).toBe(1)
    expect(s.events.events()[0]).toEqual(prior)
    expect(s.events.events().map((event) => event.kind)).toEqual([
      'checkpoint.observed',
      'checkpoint.restore_requested',
      'checkpoint.restore_resolved',
    ])
    await expect(
      restarted.restore({ ...request, body: { ...request.body, checkpointEventId: 'other' } })
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  test('rejects stale, foreign session/workspace, forged capability/resource, missing key and archived authority before any journal append', async () => {
    for (const change of [
      { resource: { kind: 'runtime_session', id: 'foreign', generation: 1 } },
      { capabilities: [] },
      { scope: { ...scope, workspaceId: 'foreign' } },
      { idempotencyKey: undefined },
      { body: { runtimeSessionId: 'foreign', expectedGeneration: 1, checkpointEventId: 'unused' } },
    ] as Partial<DevCommand>[]) {
      const s = setup(adapter())
      await expect(s.runtime.restore(command(s.checkpoint.eventId, change))).rejects.toBeDefined()
      expect(s.runtime.journal()).toHaveLength(0)
    }
    for (const session of [
      { ...original, generation: 2 },
      { ...original, archived: true },
      { ...original, scope: { ...scope, workspaceId: 'foreign' } },
    ]) {
      const s = setup(adapter())
      s.setSession(session)
      await expect(s.runtime.restore(command(s.checkpoint.eventId))).rejects.toBeDefined()
      expect(s.runtime.journal()).toHaveLength(0)
    }
  })

  test('requires the exact retained checkpoint event from this session and refuses installation crossover', async () => {
    const s = setup(adapter())
    const foreign = s.events.append({
      runtimeSessionId: 'foreign',
      harnessRunId: 'other-run',
      generation: 1,
      sourceEventId: 'foreign-event',
      kind: 'checkpoint.observed',
      payload: s.checkpoint.payload,
    })!
    await expect(s.runtime.restore(command(foreign.eventId))).rejects.toMatchObject({
      code: 'identity_mismatch',
    })
    await expect(s.runtime.restore(command('unknown'))).rejects.toMatchObject({
      code: 'resync_required',
    })
    s.setSession({ ...original, harnessInstallationId: 'other-installation' })
    await expect(s.runtime.restore(command(s.checkpoint.eventId))).rejects.toMatchObject({
      code: 'identity_mismatch',
    })
    expect(s.runtime.journal()).toHaveLength(0)
  })

  test('fences a takeover while the adapter is preparing; concurrent identical requests dispatch once', async () => {
    let release!: () => void
    let calls = 0
    let entered!: () => void
    const preparing = new Promise<void>((resolve) => {
      entered = resolve
    })
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const s = setup(
      adapter(async (input) => {
        calls++
        entered()
        await wait
        return adapter().restore(input)
      })
    )
    const request = command(s.checkpoint.eventId)
    const first = s.runtime.restore(request)
    const second = s.runtime.restore({ ...request, requestId: randomUUID() })
    const competing = s.runtime
      .restore({ ...request, idempotencyKey: 'competing-key' })
      .catch((error: unknown) => error)
    const refused = Promise.allSettled([first, second])
    await preparing
    s.setSession({ ...original, generation: 2, version: 2 })
    release()
    expect(await refused).toEqual([
      {
        status: 'rejected',
        reason: {
          code: 'stale_generation',
          retryable: false,
          message: 'restore session/input ownership changed',
        },
      },
      {
        status: 'rejected',
        reason: {
          code: 'stale_generation',
          retryable: false,
          message: 'restore session/input ownership changed',
        },
      },
    ])
    expect(calls).toBe(1)
    expect(await competing).toMatchObject({ code: 'invalid_state' })
    expect(
      s.events.events().filter((event) => event.kind === 'checkpoint.restore_failed')
    ).toHaveLength(0)
    expect(s.events.events().some((event) => event.kind === 'checkpoint.restore_resolved')).toBe(
      false
    )
  })

  test('restart retains interrupted restore fences and a live observed receipt reconciles without redispatch', async () => {
    let release!: () => void
    let calls = 0
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const s = setup(
      adapter(async (input) => {
        calls++
        await wait
        return adapter().restore(input)
      })
    )
    const request = command(s.checkpoint.eventId)
    const unfinished = s.runtime.restore(request)
    const restarted = createConversationCheckpointRuntime(s.options)
    await expect(restarted.restore(request)).rejects.toMatchObject({ code: 'delivery_ambiguous' })
    expect(() => restarted.assertInputAvailable(original.id)).toThrow()
    release()
    expect(await unfinished).toMatchObject({ status: 'resolved', restoredGeneration: 2 })
    expect(calls).toBe(1)
    expect(s.current()).toMatchObject({ generation: 2, version: 2 })
    expect(() => restarted.assertInputAvailable(original.id)).not.toThrow()
    expect(
      s.events.events().filter((event) => event.kind === 'checkpoint.restore_failed')
    ).toHaveLength(0)
  })

  test('rejects forged/mismatched adapter receipts and records explicit failure', async () => {
    const s = setup(
      adapter(async (input) => ({
        status: 'restored',
        restoreId: input.restoreId,
        expectedGeneration: input.session.generation,
        runtimeSessionId: 'foreign',
        harnessRunId: 'run-1',
        checkpointId: 'checkpoint-1',
        providerRestoreId: 'proof-1',
        observedAt: new Date().toISOString(),
      }))
    )
    await expect(s.runtime.restore(command(s.checkpoint.eventId))).rejects.toMatchObject({
      code: 'identity_mismatch',
    })
    expect(s.current()).toEqual(original)
  })

  test('an unconfirmed deadline aborts the adapter and never advances the session', async () => {
    let signal: AbortSignal | undefined
    const s = setup(
      adapter(async (input) => {
        signal = input.signal
        return new Promise(() => {})
      })
    )
    const runtime = createConversationCheckpointRuntime({ ...s.options, restoreTimeoutMs: 1 })
    await expect(runtime.restore(command(s.checkpoint.eventId))).rejects.toMatchObject({
      code: 'delivery_ambiguous',
    })
    expect(signal?.aborted).toBe(true)
    expect(s.current()).toEqual(original)
    expect(() => runtime.assertInputAvailable(original.id)).toThrow()
    const restarted = createConversationCheckpointRuntime(s.options)
    expect(() => restarted.assertInputAvailable(original.id)).toThrow()
    await expect(
      restarted.restore(command(s.checkpoint.eventId, { idempotencyKey: 'after-timeout' }))
    ).rejects.toMatchObject({ code: 'invalid_state' })
    expect(
      s.events.events().filter((event) => event.kind === 'checkpoint.restore_failed')
    ).toHaveLength(0)
  })

  test('a late physical restore receipt reconciles after timeout without reopening input early', async () => {
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const physical = { checkpoint: 'working-tree', calls: 0 }
    const s = setup(
      adapter(async (input) => {
        input.assertCurrent()
        physical.calls++
        await wait
        physical.checkpoint = input.checkpoint.checkpointId
        return {
          status: 'restored',
          restoreId: input.restoreId,
          expectedGeneration: input.session.generation,
          runtimeSessionId: original.id,
          harnessRunId: 'run-1',
          checkpointId: input.checkpoint.checkpointId,
          providerRestoreId: 'late-observation',
          observedAt: new Date().toISOString(),
        }
      })
    )
    let clock = Date.now()
    const runtime = createConversationCheckpointRuntime({
      ...s.options,
      now: () => clock,
      restoreTimeoutMs: 1,
    })
    const request = command(s.checkpoint.eventId)
    await expect(runtime.restore(request)).rejects.toMatchObject({ code: 'delivery_ambiguous' })
    const restarted = createConversationCheckpointRuntime(s.options)
    expect(() => runtime.assertInputAvailable(original.id)).toThrow()
    expect(() => restarted.assertInputAvailable(original.id)).toThrow()
    expect(physical).toEqual({ checkpoint: 'working-tree', calls: 1 })
    clock = Date.parse(request.expiresAt) + 1
    release()
    await new Promise((resolve) => setImmediate(resolve))
    expect(physical).toEqual({ checkpoint: 'checkpoint-1', calls: 1 })
    expect(s.current()).toMatchObject({ generation: 2, version: 2 })
    expect(() => restarted.assertInputAvailable(original.id)).not.toThrow()
    expect(await restarted.restore(request)).toMatchObject({
      status: 'resolved',
      providerRestoreId: 'late-observation',
    })
    expect(
      s.events.events().filter((event) => event.kind === 'checkpoint.restore_resolved')
    ).toHaveLength(1)
    expect(
      s.events.events().filter((event) => event.kind === 'checkpoint.restore_failed')
    ).toHaveLength(0)
  })

  test('a receipt from another restore attempt cannot confirm this command', async () => {
    const s = setup(
      adapter(async (input) => ({
        ...(await adapter().restore(input)),
        restoreId: 'older-attempt',
      }))
    )
    await expect(s.runtime.restore(command(s.checkpoint.eventId))).rejects.toMatchObject({
      code: 'identity_mismatch',
    })
    expect(s.current()).toEqual(original)
  })

  test('a receipt cannot bypass the adapter generation-fence contract', async () => {
    const s = setup(
      adapter(async (input) => ({
        status: 'restored',
        restoreId: input.restoreId,
        expectedGeneration: input.session.generation,
        runtimeSessionId: original.id,
        harnessRunId: 'run-1',
        checkpointId: input.checkpoint.checkpointId,
        providerRestoreId: 'unfenced-proof',
        observedAt: new Date().toISOString(),
      }))
    )
    await expect(s.runtime.restore(command(s.checkpoint.eventId))).rejects.toMatchObject({
      code: 'ownership_unproven',
    })
    expect(s.current()).toEqual(original)
  })

  test('malformed confirmation evidence is refused before the canonical generation changes', async () => {
    const s = setup(
      adapter(async (input) => {
        input.assertCurrent()
        return {
          status: 'restored',
          restoreId: input.restoreId,
          expectedGeneration: input.session.generation,
          runtimeSessionId: original.id,
          harnessRunId: 'run-1',
          checkpointId: input.checkpoint.checkpointId,
          providerRestoreId: '   ',
          observedAt: new Date().toISOString(),
        }
      })
    )
    await expect(s.runtime.restore(command(s.checkpoint.eventId))).rejects.toBeDefined()
    expect(s.current()).toEqual(original)
  })

  test('restart publishes a durable confirmed outcome after an event-log interruption, preserving the audit prefix', async () => {
    let calls = 0
    const s = setup(
      adapter(async (input) => {
        calls++
        return adapter().restore(input)
      })
    )
    const interruptedEvents = {
      ...s.events,
      append: (input: Parameters<typeof s.events.append>[0]) => {
        if (input.kind === 'checkpoint.restore_resolved')
          throw new Error('simulated event write interruption')
        return s.events.append(input)
      },
    }
    const runtime = createConversationCheckpointRuntime({ ...s.options, events: interruptedEvents })
    const request = command(s.checkpoint.eventId)
    const confirmed = await runtime.restore(request)
    const auditBefore = runtime.journal()
    expect(s.events.events().some((event) => event.kind === 'checkpoint.restore_resolved')).toBe(
      false
    )
    const restarted = createConversationCheckpointRuntime(s.options)
    expect(await restarted.restore(request)).toEqual(confirmed)
    expect(calls).toBe(1)
    expect(restarted.journal().slice(0, auditBefore.length)).toEqual(auditBefore)
    expect(
      s.events.events().filter((event) => event.kind === 'checkpoint.restore_resolved')
    ).toHaveLength(1)
    const eventsBefore = s.events.events()
    createConversationCheckpointRuntime(s.options)
    expect(s.events.events()).toEqual(eventsBefore)
  })

  test('a durable outcome write failure retains ambiguity and input fencing across restart', async () => {
    let calls = 0
    const s = setup(
      adapter(async (input) => {
        calls++
        const receipt = await adapter().restore(input)
        const directory = join(s.options.dataDir, 'dev-runtime', 'harness', 'checkpoint-restores')
        const file = readdirSync(directory).find((name) => name.endsWith('.sqlite3'))!
        const db = new Database(join(directory, file))
        try {
          db.exec(`CREATE TRIGGER refuse_confirmation BEFORE UPDATE ON durable_store_records
          WHEN EXISTS (SELECT 1 FROM json_each(NEW.payload)
            WHERE json_extract(value, '$.phase') = 'outcome'
              AND json_extract(value, '$.outcome.status') = 'resolved')
          BEGIN SELECT RAISE(FAIL, 'simulated outcome write failure'); END`)
        } finally {
          db.close()
        }
        return receipt
      })
    )
    const options = durableSessionOptions(s)
    const runtime = createConversationCheckpointRuntime(options)
    const request = command(s.checkpoint.eventId)
    await expect(runtime.restore(request)).rejects.toMatchObject({ code: 'corrupt_state' })
    expect(options.sessions()).toEqual([original])
    const journal = runtime.journal()
    const restarted = createConversationCheckpointRuntime(options)
    await expect(restarted.restore({ ...request, requestId: randomUUID() })).rejects.toMatchObject({
      code: 'delivery_ambiguous',
    })
    expect(() => restarted.assertInputAvailable(original.id)).toThrow()
    expect(calls).toBe(1)
    expect(restarted.journal()).toEqual(journal)
    expect(
      s.events.events().filter((event) => event.kind === 'checkpoint.restore_failed')
    ).toHaveLength(0)
    expect(s.events.events().some((event) => event.kind === 'checkpoint.restore_resolved')).toBe(
      false
    )
  })

  test('a physical restore whose confirmation cannot persist fences competing restores across restart', async () => {
    const physical = { checkpoint: 'working-tree', calls: 0 }
    const s = setup(
      adapter(async (input) => {
        const receipt = await adapter().restore(input)
        physical.checkpoint = input.checkpoint.checkpointId
        physical.calls++
        const directory = join(s.options.dataDir, 'dev-runtime', 'harness', 'checkpoint-restores')
        const file = readdirSync(directory).find((name) => name.endsWith('.sqlite3'))!
        const db = new Database(join(directory, file))
        try {
          db.exec(`CREATE TRIGGER refuse_physical_confirmation BEFORE UPDATE ON durable_store_records
          WHEN EXISTS (SELECT 1 FROM json_each(NEW.payload)
            WHERE json_extract(value, '$.phase') = 'outcome'
              AND json_extract(value, '$.outcome.status') = 'resolved')
          BEGIN SELECT RAISE(FAIL, 'physical restore happened before journal failure'); END`)
        } finally {
          db.close()
        }
        return receipt
      })
    )
    const request = command(s.checkpoint.eventId)
    await expect(s.runtime.restore(request)).rejects.toMatchObject({ code: 'corrupt_state' })
    expect(physical).toEqual({ checkpoint: 'checkpoint-1', calls: 1 })
    expect(s.current()).toEqual(original)
    const restarted = createConversationCheckpointRuntime(s.options)
    await expect(
      restarted.restore({ ...request, idempotencyKey: 'competing' })
    ).rejects.toMatchObject({ code: 'invalid_state' })
    expect(restarted.journal().some((entry) => entry.phase === 'outcome')).toBe(false)
    expect(physical.calls).toBe(1)
    expect(() => s.runtime.assertInputAvailable(original.id)).toThrow()
    expect(() => restarted.assertInputAvailable(original.id)).toThrow()
    s.setSession({ ...original, generation: 2, version: 2 })
    expect(() => restarted.assertInputAvailable(original.id)).toThrow()
  })

  test('an applied restore can repair historical publication after takeover without advancing again', async () => {
    const s = setup(adapter())
    const runtime = createConversationCheckpointRuntime({
      ...s.options,
      events: {
        ...s.events,
        append: (input) => {
          if (input.kind === 'checkpoint.restore_resolved')
            throw new Error('publication interrupted')
          return s.events.append(input)
        },
      },
    })
    const request = command(s.checkpoint.eventId)
    const outcome = await runtime.restore(request)
    expect(runtime.journal().filter((entry) => entry.phase === 'session_committed')).toHaveLength(1)
    const takeover = { ...original, generation: 3, version: 3, activeHarnessRunId: 'another-run' }
    s.setSession(takeover)
    const restarted = createConversationCheckpointRuntime(s.options)
    await expect(restarted.restore(request)).rejects.toMatchObject({ code: 'stale_generation' })
    expect(s.current()).toEqual(takeover)
    const published = s.events
      .events()
      .filter((event) => event.kind === 'checkpoint.restore_resolved')
    expect(published).toHaveLength(1)
    expect(published[0]!.payload).toEqual(outcome)
  })

  test('restart completes a durably confirmed restore after the session write fails without redispatch', async () => {
    let calls = 0
    const s = setup(
      adapter(async (input) => {
        calls++
        return adapter().restore(input)
      })
    )
    const options = durableSessionOptions(s)
    const runtime = createConversationCheckpointRuntime({
      ...options,
      persistSession: () => {
        throw { code: 'corrupt_state', message: 'simulated session write failure' }
      },
    })
    const request = command(s.checkpoint.eventId)
    await expect(runtime.restore(request)).rejects.toMatchObject({ code: 'corrupt_state' })
    expect(options.sessions()).toEqual([original])
    const confirmed = runtime.journal().find((entry) => entry.phase === 'outcome')!.outcome!
    expect(confirmed.status).toBe('resolved')
    expect(s.events.events().some((event) => event.kind === 'checkpoint.restore_resolved')).toBe(
      false
    )
    await expect(
      runtime.restore({ ...request, idempotencyKey: 'competing-key' })
    ).rejects.toMatchObject({ code: 'invalid_state' })
    const prefix = runtime.journal()
    const restarted = createConversationCheckpointRuntime(options)
    expect(options.sessions()).toEqual([{ ...original, generation: 2, version: 2 }])
    expect(await restarted.restore({ ...request, requestId: randomUUID() })).toEqual(confirmed)
    expect(restarted.journal().slice(0, prefix.length)).toEqual(prefix)
    expect(calls).toBe(1)
    expect(
      s.events.events().filter((event) => event.kind === 'checkpoint.restore_resolved')
    ).toHaveLength(1)
    expect(s.events.events().some((event) => event.kind === 'checkpoint.restore_failed')).toBe(
      false
    )
    createConversationCheckpointRuntime(options)
    expect(options.sessions()).toEqual([{ ...original, generation: 2, version: 2 }])
  })

  test('a session write that commits before throwing keeps one confirmed outcome across restart', async () => {
    let calls = 0
    const s = setup(
      adapter(async (input) => {
        calls++
        return adapter().restore(input)
      })
    )
    const options = durableSessionOptions(s)
    const runtime = createConversationCheckpointRuntime({
      ...options,
      persistSession: (session, restoreId) => {
        options.persistSession(session, restoreId)
        throw { code: 'corrupt_state', message: 'simulated error after durable commit' }
      },
    })
    const request = command(s.checkpoint.eventId)
    const confirmed = await runtime.restore(request)
    expect(confirmed.status).toBe('resolved')
    expect(options.sessions()).toEqual([{ ...original, generation: 2, version: 2 }])
    const restarted = createConversationCheckpointRuntime(options)
    expect(await restarted.restore(request)).toEqual(confirmed)
    expect(options.sessions()).toEqual([{ ...original, generation: 2, version: 2 }])
    expect(calls).toBe(1)
    expect(restarted.journal().filter((entry) => entry.phase === 'outcome')).toHaveLength(1)
    expect(
      s.events.events().filter((event) => event.kind === 'checkpoint.restore_resolved')
    ).toHaveLength(1)
    expect(s.events.events().some((event) => event.kind === 'checkpoint.restore_failed')).toBe(
      false
    )
  })

  test('confirmed recovery never overwrites a changed session owner or version', async () => {
    for (const change of [
      { version: 2 },
      { activeHarnessRunId: 'another-run' },
      { archived: true },
      { generation: 2, version: 2 },
      { generation: 3, version: 3 },
    ]) {
      let calls = 0
      const s = setup(
        adapter(async (input) => {
          calls++
          return adapter().restore(input)
        })
      )
      const runtime = createConversationCheckpointRuntime({
        ...s.options,
        persistSession: () => {
          throw { code: 'corrupt_state' }
        },
      })
      const request = command(s.checkpoint.eventId)
      await expect(runtime.restore(request)).rejects.toMatchObject({ code: 'corrupt_state' })
      const changed = { ...original, ...change }
      s.setSession(changed)
      const restarted = createConversationCheckpointRuntime(s.options)
      await expect(restarted.restore(request)).rejects.toMatchObject({ code: 'stale_generation' })
      expect(s.current()).toEqual(changed)
      expect(calls).toBe(1)
      expect(s.events.events().some((event) => event.kind === 'checkpoint.restore_resolved')).toBe(
        false
      )
      expect(restarted.journal().filter((entry) => entry.phase === 'outcome')).toHaveLength(1)
    }
  })

  test('a failed journal commit-marker write recovers its atomic session witness after takeover', async () => {
    let calls = 0
    const s = setup(
      adapter(async (input) => {
        calls++
        const receipt = await adapter().restore(input)
        const directory = join(s.options.dataDir, 'dev-runtime', 'harness', 'checkpoint-restores')
        const db = new Database(
          join(
            directory,
            readdirSync(directory).find((name) => name.endsWith('.sqlite3'))!
          )
        )
        try {
          db.exec(`CREATE TRIGGER refuse_commit_marker BEFORE UPDATE ON durable_store_records
          WHEN json_extract(NEW.payload, '$[#-1].phase') = 'session_committed'
          BEGIN SELECT RAISE(FAIL, 'simulated commit marker failure'); END`)
        } finally {
          db.close()
        }
        return receipt
      })
    )
    const authority = createChannelAuthority({
      shellHost: '127.0.0.1:4795',
      shellOrigin: 'http://127.0.0.1:4795',
      authorizeCommand: async () => {},
    })
    const projectOptions = { authority, dataDir: s.options.dataDir, scope }
    const projects = registerProjectSessionRuntime(projectOptions)
    projects.upsertSession(original)
    const options = {
      ...s.options,
      resolveSession: (id: string) => projects.getSession(id),
      persistSession: (session: RuntimeSession, restoreId?: string) =>
        projects.upsertSession(session, restoreId),
      getSessionRestoreCommit: (restoreId: string) =>
        projects.getCheckpointRestoreCommit(restoreId),
    }
    const runtime = createConversationCheckpointRuntime(options)
    const request = command(s.checkpoint.eventId)
    await expect(runtime.restore(request)).rejects.toMatchObject({ code: 'corrupt_state' })
    expect(projects.getSession(original.id)).toMatchObject({ generation: 2, version: 2 })
    const confirmed = runtime.journal().find((entry) => entry.phase === 'outcome')!.outcome!
    expect(projects.getCheckpointRestoreCommit(confirmed.restoreId)).toMatchObject({
      runtimeSessionId: original.id,
      generation: 2,
      version: 2,
    })
    expect(runtime.journal().some((entry) => entry.phase === 'session_committed')).toBe(false)
    projects.upsertSession({
      ...original,
      generation: 3,
      version: 3,
      activeHarnessRunId: 'another-run',
    })
    const directory = join(s.options.dataDir, 'dev-runtime', 'harness', 'checkpoint-restores')
    const db = new Database(
      join(
        directory,
        readdirSync(directory).find((name) => name.endsWith('.sqlite3'))!
      )
    )
    try {
      db.exec('DROP TRIGGER refuse_commit_marker')
    } finally {
      db.close()
    }
    const reopened = registerProjectSessionRuntime(projectOptions)
    const restarted = createConversationCheckpointRuntime({
      ...options,
      resolveSession: (id: string) => reopened.getSession(id),
      persistSession: (session: RuntimeSession, restoreId?: string) =>
        reopened.upsertSession(session, restoreId),
      getSessionRestoreCommit: (restoreId: string) =>
        reopened.getCheckpointRestoreCommit(restoreId),
    })
    await expect(restarted.restore(request)).rejects.toMatchObject({ code: 'stale_generation' })
    expect(reopened.getSession(original.id)).toMatchObject({
      generation: 3,
      version: 3,
      activeHarnessRunId: 'another-run',
    })
    expect(restarted.journal().filter((entry) => entry.phase === 'session_committed')).toHaveLength(
      1
    )
    const published = s.events
      .events()
      .filter((event) => event.kind === 'checkpoint.restore_resolved')
    expect(published).toHaveLength(1)
    expect(published[0]!.payload).toEqual(confirmed)
    expect(calls).toBe(1)
  })

  test('production session persistence exposes no uncommitted generation after a SQLite write failure', async () => {
    const s = setup(adapter())
    const live = {
      ...original,
      id: '00000000-0000-4000-8000-000000000040',
      projectId: '00000000-0000-4000-8000-000000000020',
      repoId: '00000000-0000-4000-8000-000000000030',
      worktreeId: '00000000-0000-4000-8000-000000000050',
    }
    const authority = createChannelAuthority({
      shellHost: '127.0.0.1:4795',
      shellOrigin: 'http://127.0.0.1:4795',
      authorizeCommand: async () => {},
    })
    const projectOptions = { authority, dataDir: s.options.dataDir, scope }
    const projects = registerProjectSessionRuntime(projectOptions)
    projects.upsertSession(live)
    let calls = 0
    const options = {
      ...s.options,
      resolveSession: (id: string) => projects.getSession(id),
      persistSession: (session: RuntimeSession, restoreId?: string) =>
        projects.upsertSession(session, restoreId),
      getSessionRestoreCommit: (restoreId: string) =>
        projects.getCheckpointRestoreCommit(restoreId),
      adapter: adapter(async (input) => {
        calls++
        input.assertCurrent()
        return {
          status: 'restored' as const,
          restoreId: input.restoreId,
          expectedGeneration: 1,
          runtimeSessionId: live.id,
          harnessRunId: 'run-1',
          checkpointId: 'checkpoint-1',
          providerRestoreId: 'proof-1',
          observedAt: new Date().toISOString(),
        }
      }),
    }
    const runtime = createConversationCheckpointRuntime(options)
    const checkpoint = runtime.observe({
      runtimeSessionId: live.id,
      expectedGeneration: 1,
      checkpointId: 'checkpoint-1',
      name: 'Before refactor',
      createdAt: new Date().toISOString(),
      sourceEventId: 'production-checkpoint',
    })!
    const directory = join(s.options.dataDir, 'dev-runtime', 'project-session')
    const file = join(
      directory,
      readdirSync(directory).find((name) => name.endsWith('.sqlite3'))!
    )
    const db = new Database(file)
    try {
      db.exec(`CREATE TRIGGER refuse_session BEFORE UPDATE ON durable_store_records
        BEGIN SELECT RAISE(FAIL, 'simulated session store failure'); END`)
    } finally {
      db.close()
    }
    const request = command(checkpoint.eventId, {
      resource: { kind: 'runtime_session', id: live.id, generation: 1 },
      body: {
        runtimeSessionId: live.id,
        expectedGeneration: 1,
        checkpointEventId: checkpoint.eventId,
      },
    })
    await expect(runtime.restore(request)).rejects.toMatchObject({ code: 'corrupt_state' })
    expect(projects.getSession(live.id)).toEqual(live)
    await expect(runtime.restore(request)).rejects.toMatchObject({ code: 'corrupt_state' })
    expect(s.events.events().some((event) => event.kind === 'checkpoint.restore_resolved')).toBe(
      false
    )
    const repaired = new Database(file)
    try {
      repaired.exec('DROP TRIGGER refuse_session')
    } finally {
      repaired.close()
    }
    const reopened = registerProjectSessionRuntime(projectOptions)
    expect(reopened.getSession(live.id)).toEqual(live)
    const restarted = createConversationCheckpointRuntime({
      ...options,
      resolveSession: (id: string) => reopened.getSession(id),
      persistSession: (session: RuntimeSession, restoreId?: string) =>
        reopened.upsertSession(session, restoreId),
      getSessionRestoreCommit: (restoreId: string) =>
        reopened.getCheckpointRestoreCommit(restoreId),
    })
    expect(await restarted.restore(request)).toMatchObject({
      status: 'resolved',
      restoredGeneration: 2,
    })
    expect(reopened.getSession(live.id)).toMatchObject({ generation: 2, version: 2 })
    expect(registerProjectSessionRuntime(projectOptions).getSession(live.id)).toEqual(
      reopened.getSession(live.id)
    )
    expect(calls).toBe(1)
  })

  test('a pending restore fences input transfer and an external takeover is never mistaken for its commit', async () => {
    let calls = 0
    const s = setup(
      adapter(async (input) => {
        calls++
        return adapter().restore(input)
      })
    )
    const authority = createChannelAuthority({
      shellHost: '127.0.0.1:4795',
      shellOrigin: 'http://127.0.0.1:4795',
      authorizeCommand: async () => {},
    })
    const projectOptions = {
      authority,
      dataDir: s.options.dataDir,
      scope,
      assertSessionInputAvailable: (id: string): void => runtime.assertInputAvailable(id),
    }
    const projects = registerProjectSessionRuntime(projectOptions)
    projects.upsertSession(original)
    const runtime = createConversationCheckpointRuntime({
      ...s.options,
      resolveSession: (id) => projects.getSession(id),
      persistSession: () => {
        throw { code: 'corrupt_state' }
      },
      getSessionRestoreCommit: (restoreId) => projects.getCheckpointRestoreCommit(restoreId),
    })
    const request = command(s.checkpoint.eventId)
    await expect(runtime.restore(request)).rejects.toMatchObject({ code: 'corrupt_state' })
    expect(() =>
      projects.providers['dev.session.transferInput']!({
        ...request,
        operation: 'dev.session.transferInput',
        body: {
          runtimeSessionId: original.id,
          expectedGeneration: 1,
          expectedOwnerVersion: 1,
          fromView: 'dev',
          toView: 'chat',
        },
      })
    ).toThrow()
    expect(projects.getSession(original.id)).toEqual(original)
    // Simulate an external/older host replacing the durable session anyway.
    projects.upsertSession({ ...original, generation: 2, version: 2 })
    const reopened = registerProjectSessionRuntime(projectOptions)
    expect(reopened.getSession(original.id)).toEqual({ ...original, generation: 2, version: 2 })
    const restarted = createConversationCheckpointRuntime({
      ...s.options,
      resolveSession: (id) => reopened.getSession(id),
      persistSession: (session, restoreId) => reopened.upsertSession(session, restoreId),
      getSessionRestoreCommit: (restoreId) => reopened.getCheckpointRestoreCommit(restoreId),
    })
    await expect(restarted.restore(request)).rejects.toMatchObject({ code: 'stale_generation' })
    expect(s.events.events().some((event) => event.kind === 'checkpoint.restore_resolved')).toBe(
      false
    )
    expect(restarted.journal().some((entry) => entry.phase === 'session_committed')).toBe(false)
    expect(calls).toBe(1)
  })

  test('the authenticated M10 channel registers restore and denies unproved or wrongly scoped commands', async () => {
    const s = setup()
    const authority = createChannelAuthority({
      shellHost: '127.0.0.1:4795',
      shellOrigin: 'http://127.0.0.1:4795',
      authorizeCommand: async (input) => {
        if (input.scope.workspaceId !== scope.workspaceId) throw new Error('foreign scope')
      },
    })
    const runtime = registerHarnessRuntime({ ...s.options, authority })
    expect(runtime.commands).toContain('dev.session.restoreCheckpoint')
    const handshake = authority.handshake(
      {
        schemaVersion: 1,
        method: 'dev.runtime.handshake.v1',
        requestId: randomUUID(),
        bootstrap: authority.issueLaunchBootstrap(),
        supportedProtocolVersions: ['1'],
        nonce: randomBytes(24).toString('base64url'),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      },
      { trusted: true }
    )
    if (!handshake.ok) throw new Error('handshake failed')
    const execute = (request: DevCommand, forged = false) => {
      const identity = {
        channelId: handshake.channelId,
        clientCredentialId: handshake.clientCredentialId,
      }
      const proof = createHmac('sha256', Buffer.from(handshake.clientSecret, 'base64url'))
        .update(devCommandProofMessage({ ...identity, command: request }))
        .digest('base64url')
      return authority.execute(
        { ...identity, command: request, proof: forged ? 'forged' : proof },
        { trusted: true }
      )
    }
    expect(await execute(command(s.checkpoint.eventId), true)).toMatchObject({ ok: false })
    expect(await execute(command(s.checkpoint.eventId, { capabilities: [] }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_state' },
    })
    expect(
      await execute(
        command(s.checkpoint.eventId, {
          scope: { ...scope, workspaceId: '00000000-0000-4000-8000-000000000009' },
        })
      )
    ).toMatchObject({ ok: false })
    expect(await execute(command(s.checkpoint.eventId))).toMatchObject({
      ok: false,
      error: { code: 'capability_unavailable' },
    })
  })
})
