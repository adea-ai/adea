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
import { createFollowUpStorage } from '../shell/src/dev-runtime/harness/follow-up-storage'
import type { AcpLaneDriver } from '../shell/src/dev-runtime/harness/acp-lane'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
function boot(withDelivery = true, withKey = true) {
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
  }
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
    close: () => close(),
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
    resolveSession: (id) => (id === session.id ? session : undefined),
    persistSession: (next) => {
      session = next
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
    authority,
    command,
    execute,
    target,
    connect,
    deliveries,
    signals,
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
