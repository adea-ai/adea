import { describe, expect, test } from 'bun:test'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeRuntimeEvent,
  devCommandProofMessage,
  devOperationDefinitions,
  type DevCommand,
  type DevOperation,
  type DevReply,
  type HarnessRun,
  type RuntimeSession,
} from '../../../packages/types/src/dev-runtime'
import {
  createChannelAuthority,
  ChannelRejection,
} from '../shell/src/dev-runtime/channel/authority'
import { registerHarnessRuntime } from '../shell/src/dev-runtime/harness/register'
import { createRepoMutationOwner } from '../shell/src/dev-runtime/worktrees/mutation-owner'
import { createFollowUpStorage } from '../shell/src/dev-runtime/harness/follow-up-storage'
import type { AcpLaneDriver } from '../shell/src/dev-runtime/harness/acp-lane'
import type { CheckpointRestoreAdapter } from '../shell/src/dev-runtime/harness/checkpoints'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
function boot(
  withDelivery = true,
  withKey = true,
  restore?: {
    adapter: CheckpointRestoreAdapter
    timeoutMs?: number
  }
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-follow-up-gate-'))
  if (withKey) {
    mkdirSync(join(dataDir, 'desktop-state'))
    writeFileSync(join(dataDir, 'desktop-state', 'device.key'), Buffer.alloc(32, 9), {
      mode: 0o600,
    })
  }
  let session: RuntimeSession = {
    id: 'session-1',
    scope,
    projectId: 'project-1',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    activeHarnessRunId: 'run-1',
    lifecycle: 'active',
    archived: false,
    projection: 'structured',
    generation: 1,
    version: 1,
    ...(restore ? { harnessInstallationId: 'installation-1' } : {}),
  }
  const restoreCommits = new Map<
    string,
    { runtimeSessionId: string; generation: number; version: number }
  >()
  let revoked = false
  let admission: (() => Promise<void>) | undefined
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1:4789',
    shellOrigin: 'http://127.0.0.1:4789',
    authorizeCommand: async () => {
      if (admission) await admission()
      if (revoked) throw new ChannelRejection('channel_unauthorized', 'revoked')
    },
    assertCommandAllowed: () => {
      if (revoked) throw new ChannelRejection('channel_unauthorized', 'revoked')
    },
  })
  const deliveries: string[] = []
  const signals: AbortSignal[] = []
  const closedConnections: string[] = []
  let close = async () => {}
  let handoff = async (text: string) => {
    deliveries.push(text)
    return {
      ok: true as const,
      bytes: new TextEncoder().encode(text).byteLength,
      processIdentity: 'fake-pid',
    }
  }
  const driver: AcpLaneDriver = {
    driverId: 'fake',
    driverVersion: '1',
    spawn: async () => ({
      ok: true,
      handshake: {
        protocolVersion: '1',
        capabilities: ['session'],
        sessionOperations: ['session.new'],
        history: 'unavailable',
        processIdentity: 'fake-pid',
      },
    }),
    close: (request) => {
      closedConnections.push(request.connectionId)
      return close()
    },
    ...(withDelivery
      ? {
          deliverPrompt: async (request) => {
            if (request.signal) signals.push(request.signal)
            return handoff(request.prompt)
          },
        }
      : {}),
  }
  const host = registerHarnessRuntime({
    authority,
    dataDir,
    scope,
    acpDriver: driver,
    checkpointRestoreAdapter: restore?.adapter,
    checkpointRestoreTimeoutMs: restore?.timeoutMs,
    getSessionRestoreCommit: (id) => restoreCommits.get(id),
    resolveSession: (id) => (id === session.id ? session : undefined),
    persistSession: (next, restoreId) => {
      session = next
      if (restoreId)
        restoreCommits.set(restoreId, {
          runtimeSessionId: next.id,
          generation: next.generation,
          version: next.version,
        })
    },
  })
  const run: HarnessRun = {
    id: 'run-1',
    scope,
    runtimeSessionId: session.id,
    installationId: 'installation-1',
    agentProfile: {
      id: 'profile-1',
      version: 1,
      displayName: 'Profile',
      capabilityPolicyVersion: 1,
    },
    state: 'working',
    generation: 1,
    version: 1,
    startedAt: new Date().toISOString(),
  }
  host.history.append(run)
  const hello = authority.handshake(
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
  if (!hello.ok) throw new Error('handshake failed')
  const channelSecret = Buffer.from(hello.clientSecret, 'base64url')
  const identity = { channelId: hello.channelId, clientCredentialId: hello.clientCredentialId }
  function command(
    body: Record<string, unknown>,
    operation: DevOperation = 'dev.session.followUps',
    key: string = randomUUID()
  ): DevCommand {
    return {
      schemaVersion: 1,
      operation,
      requestId: randomUUID(),
      nonce: randomBytes(24).toString('base64url'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      scope,
      capabilities: [...devOperationDefinitions[operation].capabilities],
      resource: {
        kind: 'runtime_session',
        id: 'session-1',
        generation: Number(body.expectedGeneration ?? 1),
      },
      idempotencyKey: key,
      body,
    }
  }
  function execute(request: DevCommand): Promise<DevReply> {
    const proof = createHmac('sha256', channelSecret)
      .update(devCommandProofMessage({ ...identity, command: request }))
      .digest('base64url')
    return authority.execute({ ...identity, command: request, proof }, { trusted: true })
  }
  const target = { runtimeSessionId: 'session-1', expectedGeneration: 1 }
  const connect = () =>
    host.lane.connect({
      runtimeSessionId: session.id,
      installation: {
        id: 'installation-1',
        executableIdentity: 'fake',
        executableLabel: 'fake',
        acpAvailability: 'available',
        auth: 'ready',
        health: 'healthy',
        capabilities: ['session'],
      },
    })
  return {
    dataDir,
    host,
    current: () => session,
    authority,
    command,
    execute,
    target,
    connect,
    deliveries,
    signals,
    closedConnections,
    setClose: (next: typeof close) => {
      close = next
    },
    revoke: () => {
      revoked = true
    },
    setAdmission: (next: typeof admission) => {
      admission = next
    },
    setHandoff: (next: typeof handoff) => {
      handoff = next
    },
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  }
}
function value(reply: DevReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(JSON.stringify(reply.error))
  return reply.value as Record<string, unknown>
}

describe('follow-up production registration and M10 gate', () => {
  test('applies the full queue schema on the host before any state change', async () => {
    const s = boot(false)
    try {
      const malformed = s.command({
        ...s.target,
        action: 'enqueue',
        expectedVersion: 0,
        messageId: 'a',
        text: 'valid text',
        extra: true,
      })
      expect(await s.execute(malformed)).toMatchObject({ ok: false })
      expect(s.host.events.events()).toEqual([])
      expect(value(await s.execute(s.command({ ...s.target, action: 'read' }))).items).toEqual([])
      expect(s.deliveries).toEqual([])
    } finally {
      s.cleanup()
    }
  })

  test('recovers a durable queue mutation whose event append committed before a subscriber failed', async () => {
    const s = boot(false)
    try {
      const unsubscribe = s.host.events.subscribe('session-1', () => {
        throw new Error('subscriber interrupted')
      })
      const request = {
        ...s.target,
        action: 'enqueue',
        expectedVersion: 0,
        messageId: 'a',
        text: 'sealed follow up',
      }
      expect(await s.execute(s.command(request, 'dev.session.followUps', 'replay'))).toMatchObject({
        ok: false,
      })
      unsubscribe()
      expect(
        value(await s.execute(s.command(request, 'dev.session.followUps', 'replay'))).version
      ).toBe(1)
      expect(s.host.events.events()).toHaveLength(1)
      expect(s.deliveries).toEqual([])
    } finally {
      s.cleanup()
    }
  })

  test('authority revocation during transport completion never reports accepted or sends the next item', async () => {
    const s = boot()
    try {
      await s.connect()
      value(
        await s.execute(
          s.command({
            ...s.target,
            action: 'enqueue',
            expectedVersion: 0,
            messageId: 'a',
            text: 'first',
          })
        )
      )
      value(
        await s.execute(
          s.command({
            ...s.target,
            action: 'enqueue',
            expectedVersion: 1,
            messageId: 'b',
            text: 'second',
          })
        )
      )
      value(
        await s.execute(
          s.command(
            { ...s.target, harnessRunId: 'run-1', state: 'awaiting_input', source: 'native' },
            'dev.harness.runStatus'
          )
        )
      )
      let complete!: () => void
      let entered!: () => void
      const began = new Promise<void>((resolve) => {
        entered = resolve
      })
      s.setHandoff(async (text) => {
        s.deliveries.push(text)
        entered()
        await new Promise<void>((resolve) => {
          complete = resolve
        })
        return {
          ok: true,
          bytes: new TextEncoder().encode(text).byteLength,
          processIdentity: 'fake-pid',
        }
      })
      const pending = s.execute(s.command({ ...s.target, action: 'deliver', expectedVersion: 2 }))
      await began
      s.revoke()
      complete()
      expect(await pending).toMatchObject({ ok: false, error: { code: 'channel_unauthorized' } })
      expect(s.deliveries).toEqual(['first'])
      expect(JSON.stringify(s.host.events.events())).not.toContain('delivery_accepted')
    } finally {
      s.cleanup()
    }
  })

  test('binds generation, rejects nonce replay, and returns typed unavailable without a genuine delivery seam', async () => {
    const s = boot(false)
    try {
      expect(s.host.commands).toContain('dev.session.followUps')
      const enqueue = s.command(
        {
          ...s.target,
          action: 'enqueue',
          expectedVersion: 0,
          messageId: 'a',
          text: 'actual follow up',
        },
        'dev.session.followUps',
        'enqueue'
      )
      expect(value(await s.execute(enqueue)).version).toBe(1)
      expect(await s.execute(enqueue)).toMatchObject({
        ok: false,
        error: { code: 'replay_rejected' },
      })
      expect(
        value(
          await s.execute(
            s.command(enqueue.body as Record<string, unknown>, 'dev.session.followUps', 'enqueue')
          )
        ).version
      ).toBe(1)
      expect(
        await s.execute(s.command({ ...s.target, expectedGeneration: 0, action: 'read' }))
      ).toMatchObject({ ok: false, error: { code: 'stale_generation' } })
      expect(
        await s.execute(s.command({ ...s.target, action: 'deliver', expectedVersion: 1 }))
      ).toMatchObject({ ok: false, error: { code: 'capability_unavailable' } })
      for (const event of s.host.events.events())
        expect(decodeRuntimeEvent(event, { source: 'host' }).kind).toBe('queue.updated')
      expect(s.deliveries).toEqual([])
    } finally {
      s.cleanup()
    }
  })

  test('delivers only after observed awaiting_input and Stop clears remaining queue before its reply', async () => {
    const s = boot()
    try {
      await s.connect()
      value(
        await s.execute(
          s.command({
            ...s.target,
            action: 'enqueue',
            expectedVersion: 0,
            messageId: 'a',
            text: 'first',
          })
        )
      )
      value(
        await s.execute(
          s.command({
            ...s.target,
            action: 'enqueue',
            expectedVersion: 1,
            messageId: 'b',
            text: 'second',
          })
        )
      )
      value(
        await s.execute(
          s.command(
            { ...s.target, harnessRunId: 'run-1', state: 'awaiting_input', source: 'native' },
            'dev.harness.runStatus'
          )
        )
      )
      const sent = value(
        await s.execute(s.command({ ...s.target, action: 'deliver', expectedVersion: 2 }))
      )
      expect(sent.lastDelivery).toEqual({ messageId: 'a', status: 'accepted' })
      expect(s.deliveries).toEqual(['first'])
      expect(
        value(
          await s.execute(
            s.command({ ...s.target, harnessRunId: 'run-1' }, 'dev.session.cancelHarness')
          )
        ).state
      ).toBe('cancelled')
      const reset = value(
        await s.execute(
          s.command({ runtimeSessionId: 'session-1', expectedGeneration: 2, action: 'read' })
        )
      )
      expect(reset.items).toEqual([])
      expect(JSON.stringify(s.host.events.events())).not.toContain('"text"')
      expect(
        s.host.events
          .events()
          .some(
            (event) =>
              event.kind === 'queue.updated' &&
              (event.payload as { change: string }).change === 'cancelled'
          )
      ).toBe(true)
    } finally {
      s.cleanup()
    }
  })

  test('Stop forwards abort, awaits close, and preserves the claim until a late physical send settles', async () => {
    const s = boot()
    let releaseSend!: () => void
    let releaseClose!: () => void
    const sendWait = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    const closeWait = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    let enteredSend!: () => void
    let enteredClose!: () => void
    const sent = new Promise<void>((resolve) => {
      enteredSend = resolve
    })
    const closing = new Promise<void>((resolve) => {
      enteredClose = resolve
    })
    const physical: string[] = []
    try {
      await s.connect()
      value(
        await s.execute(
          s.command({
            ...s.target,
            action: 'enqueue',
            expectedVersion: 0,
            messageId: 'a',
            text: 'late physical prompt',
          })
        )
      )
      value(
        await s.execute(
          s.command(
            { ...s.target, harnessRunId: 'run-1', state: 'awaiting_input', source: 'native' },
            'dev.harness.runStatus'
          )
        )
      )
      s.setHandoff(async (text) => {
        enteredSend()
        await sendWait
        physical.push(text)
        return {
          ok: true as const,
          bytes: new TextEncoder().encode(text).byteLength,
          processIdentity: 'fake-pid',
        }
      })
      s.setClose(async () => {
        enteredClose()
        await closeWait
      })
      const sending = s.execute(s.command({ ...s.target, action: 'deliver', expectedVersion: 1 }))
      await sent
      expect(s.signals).toHaveLength(1)
      let stopReturned = false
      const stopping = s
        .execute(s.command({ ...s.target, harnessRunId: 'run-1' }, 'dev.session.cancelHarness'))
        .then((reply) => {
          stopReturned = true
          return reply
        })
      await closing
      expect(s.signals[0]!.aborted).toBe(true)
      expect(stopReturned).toBe(false)
      expect(() => createFollowUpStorage({ dataDir: s.dataDir, scope }).validateForPurge()).toThrow(
        'workspace_cleanup_follow_up_busy'
      )
      releaseClose()
      expect(value(await stopping).state).toBe('cancelled')
      expect(await sending).toMatchObject({ ok: false, error: { code: 'stale_generation' } })
      expect(physical).toEqual([])
      expect(() => createFollowUpStorage({ dataDir: s.dataDir, scope }).validateForPurge()).toThrow(
        'workspace_cleanup_follow_up_busy'
      )
      releaseSend()
      await new Promise((resolve) => setImmediate(resolve))
      expect(physical).toEqual(['late physical prompt'])
      expect(() =>
        createFollowUpStorage({ dataDir: s.dataDir, scope }).validateForPurge()
      ).not.toThrow()
      expect(
        s.host.events
          .events()
          .some(
            (event) =>
              event.kind === 'queue.updated' &&
              (event.payload as { change: string }).change === 'delivery_accepted'
          )
      ).toBe(false)
    } finally {
      releaseSend()
      releaseClose()
      await new Promise((resolve) => setImmediate(resolve))
      s.cleanup()
    }
  })

  test('Stop closes only its original ACP binding when a replacement arrives during blocked cleanup', async () => {
    const s = boot()
    let release: (() => void) | undefined
    let stopping: Promise<DevReply> | undefined
    try {
      const original = await s.connect()
      const owner = createRepoMutationOwner({
        dataDir: s.dataDir,
        runtimeNodeId: scope.runtimeNodeId,
        acquireTimeoutMs: 5_000,
        pollIntervalMs: 5,
      })
      release = await owner.holdLock(
        `follow-ups:${JSON.stringify([scope.accountId, scope.workspaceId, scope.runtimeNodeId])}`,
        'test blocked queue cleanup'
      )
      stopping = s.execute(
        s.command({ ...s.target, harnessRunId: 'run-1' }, 'dev.session.cancelHarness')
      )
      for (let turn = 0; turn < 100 && s.host.history.get('run-1')?.state !== 'cancelled'; turn++)
        await new Promise((resolve) => setTimeout(resolve, 1))
      expect(s.host.history.get('run-1')?.state).toBe('cancelled')
      const replacement = await s.connect()
      expect(replacement.id).not.toBe(original.id)
      expect(s.host.lane.readyFor('session-1')?.id).toBe(replacement.id)
      release()
      release = undefined
      expect(value(await stopping).state).toBe('cancelled')
      expect(s.closedConnections).toEqual([original.id])
      expect(s.host.lane.list().find((connection) => connection.id === original.id)?.state).toBe(
        'closed'
      )
      expect(s.host.lane.list().find((connection) => connection.id === replacement.id)?.state).toBe(
        'ready'
      )
    } finally {
      release?.()
      await stopping?.catch(() => undefined)
      s.cleanup()
    }
  })

  test('rechecks a channel revoked while the provider awaits fresh admission', async () => {
    const s = boot()
    try {
      let calls = 0
      let resume!: () => void
      let waiting!: () => void
      const entered = new Promise<void>((resolve) => {
        waiting = resolve
      })
      s.setAdmission(async () => {
        if (++calls === 2) {
          waiting()
          await new Promise<void>((resolve) => {
            resume = resolve
          })
        }
      })
      const pending = s.execute(
        s.command({
          ...s.target,
          action: 'enqueue',
          expectedVersion: 0,
          messageId: 'a',
          text: 'never persisted',
        })
      )
      await entered
      s.authority.revokeAllChannels()
      resume()
      expect(await pending).toMatchObject({ ok: false, error: { code: 'channel_unauthenticated' } })
      expect(s.host.events.events()).toEqual([])
    } finally {
      s.cleanup()
    }
  })

  test('does not mint or overwrite key material when the existing content key is unavailable', async () => {
    const s = boot(false, false)
    try {
      expect(existsSync(join(s.dataDir, 'dev-runtime', 'worktrees', 'locks'))).toBe(false)
      expect(await s.execute(s.command({ ...s.target, action: 'read' }))).toMatchObject({
        ok: false,
        error: { code: 'capability_unavailable' },
      })
      expect(existsSync(join(s.dataDir, 'desktop-state', 'device.key'))).toBe(false)
    } finally {
      s.cleanup()
    }
  })
})

function restoreReceipt(input: Parameters<CheckpointRestoreAdapter['restore']>[0]) {
  return {
    status: 'restored' as const,
    restoreId: input.restoreId,
    expectedGeneration: input.session.generation,
    runtimeSessionId: input.session.id,
    harnessRunId: 'run-1',
    checkpointId: input.checkpoint.checkpointId,
    providerRestoreId: `confirmed-${input.restoreId}`,
    observedAt: new Date().toISOString(),
  }
}
function checkpoint(s: ReturnType<typeof boot>) {
  return s.host.checkpoints.observe({
    runtimeSessionId: 'session-1',
    expectedGeneration: 1,
    checkpointId: 'checkpoint-1',
    name: 'Before follow-up',
    createdAt: new Date().toISOString(),
    sourceEventId: 'native-checkpoint-1',
  })!
}

test('checkpoint restore cannot overlap a held physical ACP follow-up and retries only after settlement', async () => {
  let calls = 0
  const s = boot(true, true, {
    adapter: {
      installationId: 'installation-1',
      source: 'native',
      restore: async (input) => {
        input.assertCurrent()
        calls++
        return restoreReceipt(input)
      },
    },
  })
  let releaseSend!: () => void
  let enteredSend!: () => void
  const held = new Promise<void>((resolve) => {
    releaseSend = resolve
  })
  const entered = new Promise<void>((resolve) => {
    enteredSend = resolve
  })
  try {
    await s.connect()
    const observed = checkpoint(s)
    value(
      await s.execute(
        s.command({
          ...s.target,
          action: 'enqueue',
          expectedVersion: 0,
          messageId: 'a',
          text: 'held physical prompt',
        })
      )
    )
    value(
      await s.execute(
        s.command(
          { ...s.target, harnessRunId: 'run-1', state: 'awaiting_input', source: 'native' },
          'dev.harness.runStatus'
        )
      )
    )
    s.setHandoff(async (text) => {
      enteredSend()
      await held
      return {
        ok: true,
        bytes: new TextEncoder().encode(text).byteLength,
        processIdentity: 'fake-pid',
      }
    })
    const sending = s.execute(s.command({ ...s.target, action: 'deliver', expectedVersion: 1 }))
    await entered
    const body = { ...s.target, checkpointEventId: observed.eventId }
    expect(
      await s.execute(s.command(body, 'dev.session.restoreCheckpoint', 'blocked-restore'))
    ).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
    expect(calls).toBe(0)
    expect(s.current().generation).toBe(1)
    releaseSend()
    expect(await sending).toMatchObject({ ok: true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(
      await s.execute(s.command(body, 'dev.session.restoreCheckpoint', 'settled-restore'))
    ).toMatchObject({ ok: true, value: { status: 'resolved', restoredGeneration: 2 } })
    expect(calls).toBe(1)
    expect(s.current().generation).toBe(2)
    expect(
      await s.execute(s.command({ ...s.target, action: 'deliver', expectedVersion: 3 }))
    ).toMatchObject({ ok: false, error: { code: 'stale_generation' } })
  } finally {
    releaseSend()
    await new Promise((resolve) => setImmediate(resolve))
    s.cleanup()
  }
})

test('checkpoint restore retains the physical claim through timeout and a late fenced receipt', async () => {
  let releaseRestore!: () => void
  let enteredRestore!: () => void
  const entered = new Promise<void>((resolve) => {
    enteredRestore = resolve
  })
  const s = boot(true, true, {
    timeoutMs: 5,
    adapter: {
      installationId: 'installation-1',
      source: 'native',
      restore: (input) => {
        input.assertCurrent()
        enteredRestore()
        return new Promise((resolve) => {
          releaseRestore = () => resolve(restoreReceipt(input))
        })
      },
    },
  })
  const claims = createFollowUpStorage({ dataDir: s.dataDir, scope })
  try {
    await s.connect()
    const observed = checkpoint(s)
    const request = s.command(
      { ...s.target, checkpointEventId: observed.eventId },
      'dev.session.restoreCheckpoint',
      'late-restore'
    )
    const restoring = s.execute(request)
    await entered
    expect(await restoring).toMatchObject({ ok: false, error: { code: 'delivery_ambiguous' } })
    expect(s.current().generation).toBe(1)
    const overlap = await claims.tryDeliveryClaim('session-1')
    overlap?.()
    expect(overlap).toBeUndefined()
    expect(() => s.host.checkpoints.assertInputAvailable('session-1')).toThrow()
    expect(s.host.events.events().some((item) => item.kind === 'checkpoint.restore_failed')).toBe(
      false
    )
    releaseRestore()
    await new Promise((resolve) => setImmediate(resolve))
    expect(s.current().generation).toBe(2)
    expect(() => s.host.checkpoints.assertInputAvailable('session-1')).not.toThrow()
    const released = await claims.tryDeliveryClaim('session-1')
    expect(released).toBeDefined()
    released?.()
    expect(
      await s.execute(s.command(request.body, 'dev.session.restoreCheckpoint', 'late-restore'))
    ).toMatchObject({ ok: true, value: { status: 'resolved', restoredGeneration: 2 } })
    expect(s.current().generation).toBe(2)
  } finally {
    releaseRestore?.()
    await new Promise((resolve) => setImmediate(resolve))
    s.cleanup()
  }
})
