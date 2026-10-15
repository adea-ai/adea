import { afterEach, describe, expect, test } from 'bun:test'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const events = createSessionEventLog({ dataDir, scope })
  const options = {
    dataDir,
    scope,
    events,
    adapter: restoreAdapter,
    resolveSession: (id: string) => (session?.id === id ? session : undefined),
    persistSession: (next: RuntimeSession) => {
      session = next
    },
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
    const first = s.runtime.restore(request)
    const second = s.runtime.restore({ ...request, requestId: randomUUID() })
    const competing = s.runtime
      .restore({ ...request, idempotencyKey: 'competing-key' })
      .catch((error: unknown) => error)
    const refused = Promise.allSettled([first, second])
    s.setSession({ ...original, generation: 2, version: 2 })
    release()
    expect(await refused).toEqual([
      {
        status: 'rejected',
        reason: {
          code: 'stale_generation',
          retryable: false,
          message: 'conversation checkpoint restore failed; see its canonical outcome',
        },
      },
      {
        status: 'rejected',
        reason: {
          code: 'stale_generation',
          retryable: false,
          message: 'conversation checkpoint restore failed; see its canonical outcome',
        },
      },
    ])
    expect(calls).toBe(1)
    expect(await competing).toMatchObject({ code: 'invalid_state' })
    expect(
      s.events.events().filter((event) => event.kind === 'checkpoint.restore_failed')
    ).toHaveLength(1)
    expect(s.events.events().some((event) => event.kind === 'checkpoint.restore_resolved')).toBe(
      false
    )
  })

  test('restart turns interrupted restores into one ambiguous failure without redispatch', async () => {
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
    release()
    await expect(unfinished).rejects.toMatchObject({ code: 'delivery_ambiguous' })
    expect(calls).toBe(1)
    expect(s.current()).toEqual(original)
    expect(
      s.events.events().filter((event) => event.kind === 'checkpoint.restore_failed')
    ).toHaveLength(1)
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
    expect(
      s.events.events().filter((event) => event.kind === 'checkpoint.restore_failed')
    ).toHaveLength(1)
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
