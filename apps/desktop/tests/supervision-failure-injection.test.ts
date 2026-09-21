// Failure-injection suite (M10 #34, deterministic): gateway loss, duplicate
// remote command replay, host sleep/wake (clock jump), and ledger expiry —
// each as an injected fault against existing seams (the supervision engine's
// fake adapter and injected clock; the channel authority's injected clock).
// No real sleeps: every clock movement is `clock.advance(ms)`.
import { describe, expect, test } from 'bun:test'
import { createHmac, randomUUID } from 'node:crypto'

import {
  devCommandProofMessage,
  type DevCommand,
  type Scope,
} from '../../../packages/types/src/dev-runtime'
import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import {
  decodeComponentManifest,
  type ComponentManifest,
} from '../shell/src/supervision/component-manifest'
import { createSupervisor, type SupervisionAdapter } from '../shell/src/supervision/supervisor'

// ── Shared deterministic fixtures ──────────────────────────────────────────

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

function fakeAdapter(mode: 'term' | 'never' = 'term') {
  let nextPid = 100
  const spawns: Array<{ componentId: string; generation: number }> = []
  const live = new Map<number, { pidStartIdentity: string; executableIdentity: string }>()
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
      return { identity, processGroup: `pgid-${pid}` }
    },
    async currentIdentity(pid: number) {
      const identity = live.get(pid)
      if (!identity) return null
      return { ...identity, processGroup: `pgid-${pid}` }
    },
    async probe() {
      return 'responsive' as const
    },
    async signalIdentity(identity: { pid: number }) {
      if (mode === 'term') live.delete(identity.pid)
    },
    exit(pid: number) {
      live.delete(pid)
    },
  }
  return { adapter: adapter as SupervisionAdapter, spawns, exit: adapter.exit }
}

function tickClock(start = 1_000_000_000_000) {
  let now = start
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
    },
  }
}

// ── Host sleep/wake: one clock jump, every consumer derived ────────────────

describe('injected fault: host sleep/wake (clock jump)', () => {
  test('supervision marks health from the probe window at decision time and never restarts spuriously', async () => {
    const fake = fakeAdapter()
    const clock = tickClock()
    const supervisor = createSupervisor({
      manifest: manifestWith('cp'),
      adapter: fake.adapter,
      now: clock.now,
    })
    await supervisor.start({ componentId: 'cp', idempotencyKey: 'cp' })
    expect(supervisor.snapshot().components[0]).toMatchObject({
      state: 'running',
      health: 'healthy',
    })

    // The host sleeps for six hours: one clock jump, no timers, no events.
    clock.advance(6 * 60 * 60_000)
    const component = supervisor.snapshot().components[0]
    // Health is recomputed from the probe window, never a stored flag.
    expect(component.state).toBe('running')
    expect(component.health).toBe('unhealthy')
    expect(supervisor.baselineReady()).toEqual({ ready: false, missing: ['cp'] })
    // The engine did not invent a crash across the jump.
    expect(fake.spawns).toHaveLength(1)
    expect(supervisor.audit().filter((event) => event.kind === 'exit')).toEqual([])

    // The wake heartbeat (first probe observation after the jump) restores it.
    supervisor.heartbeat('cp')
    expect(supervisor.snapshot().components[0].health).toBe('healthy')
    expect(supervisor.baselineReady()).toEqual({ ready: true, missing: [] })
    expect(fake.spawns).toHaveLength(1)
  })

  test('crash-loop failures from before the sleep age out of the window', async () => {
    const fake = fakeAdapter()
    const clock = tickClock()
    const supervisor = createSupervisor({
      manifest: manifestWith('cp'),
      adapter: fake.adapter,
      now: clock.now,
    })
    await supervisor.start({ componentId: 'cp', idempotencyKey: 'cp' })
    // Four crashes inside the window (one short of the budget)…
    for (let i = 0; i < 4; i++) {
      fake.exit(101 + i)
      await supervisor.reportUnexpectedExit('cp')
      clock.advance(60_000)
    }
    expect(fake.spawns).toHaveLength(5)
    // …then the host sleeps for a day. Every failure has left the window.
    clock.advance(24 * 60 * 60_000)
    fake.exit(105)
    const outcome = await supervisor.reportUnexpectedExit('cp')
    // Only the post-wake failure counts: the loop restarts instead of
    // hallucinating a crash-loop verdict from stale ledger entries.
    expect(outcome).toMatchObject({ ok: true, value: 'restarted' })
    // initial + 4 crash restarts + the single post-wake restart
    expect(fake.spawns).toHaveLength(6)
    expect(supervisor.snapshot().components[0].state).toBe('running')
    expect(supervisor.snapshot().components[0].generation).toBe(6)
  })

  test('a stop confirmation from before the sleep is expired by the supervision ledger', async () => {
    const fake = fakeAdapter()
    const clock = tickClock()
    const supervisor = createSupervisor({
      manifest: manifestWith('cp'),
      adapter: fake.adapter,
      now: clock.now,
    })
    await supervisor.start({ componentId: 'cp', idempotencyKey: 'cp' })
    const confirmation = supervisor.requestStop('cp')
    expect(confirmation.ok).toBe(true)
    if (!confirmation.ok) return

    // Inside the confirmation's 60-second ledger window the stop works.
    const stopped = await supervisor.stop('cp', {
      confirmationId: confirmation.value.confirmationId,
    })
    expect(stopped.ok).toBe(true)
    // Restart and mint a fresh confirmation, then sleep past its expiry.
    await supervisor.restart('cp')
    const later = supervisor.requestStop('cp')
    if (!later.ok) return
    clock.advance(61_000)
    const expired = await supervisor.stop('cp', {
      confirmationId: later.value.confirmationId,
    })
    expect(expired).toMatchObject({ ok: false, code: 'confirmation_invalid' })
    // The launch was not touched by the expired confirmation.
    expect(supervisor.snapshot().components[0].state).toBe('running')
  })
})

// ── Gateway loss, duplicate command replay, nonce ledger expiry ────────────

describe('injected fault: gateway loss and remote command replay', () => {
  const SHELL_HOST = '127.0.0.1'
  const SHELL_ORIGIN = `http://${SHELL_HOST}:4789`
  const SCOPE: Scope = {
    accountId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    runtimeNodeId: '00000000-0000-4000-8000-000000000003',
  }

  function handshakePayload(bootstrap: string) {
    return {
      schemaVersion: 1,
      method: 'dev.runtime.handshake.v1',
      requestId: randomUUID(),
      bootstrap,
      supportedProtocolVersions: ['1'],
      nonce: Buffer.from(randomUUID()).toString('base64url'),
      issuedAt: new Date(clockNow).toISOString(),
      expiresAt: new Date(clockNow + 30_000).toISOString(),
    }
  }

  let clockNow = 2_000_000_000_000

  function makeAuthority() {
    clockNow = 2_000_000_000_000
    const authority = createChannelAuthority({
      now: () => clockNow,
      shellHost: SHELL_HOST,
      shellOrigin: SHELL_ORIGIN,
    })
    const reply = authority.handshake(handshakePayload(authority.issueLaunchBootstrap()), {
      trusted: true,
    })
    if (!reply.ok) throw new Error('fixture handshake failed')
    const identity = {
      channelId: reply.channelId,
      clientCredentialId: reply.clientCredentialId,
    }
    const secret = Buffer.from(reply.clientSecret, 'base64url')
    const providerCalls: string[] = []
    authority.registerCommandProvider('dev.capability.snapshot', (command) => {
      providerCalls.push(command.requestId)
      return authority.capabilitySnapshot(command.scope, identity)
    })
    const command = (overrides?: Partial<DevCommand>): DevCommand =>
      ({
        schemaVersion: 1,
        operation: 'dev.capability.snapshot',
        requestId: randomUUID(),
        nonce: Buffer.from(randomUUID()).toString('base64url'),
        issuedAt: new Date(clockNow).toISOString(),
        expiresAt: new Date(clockNow + 60_000).toISOString(),
        scope: SCOPE,
        capabilities: [],
        body: {},
        ...overrides,
      }) as DevCommand
    const frame = (cmd: DevCommand) => ({
      channelId: identity.channelId,
      clientCredentialId: identity.clientCredentialId,
      command: cmd,
      proof: createHmac('sha256', secret)
        .update(
          devCommandProofMessage({
            channelId: identity.channelId,
            clientCredentialId: identity.clientCredentialId,
            command: cmd,
          })
        )
        .digest('base64url'),
    })
    return { authority, identity, secret, providerCalls, command, frame }
  }

  test('duplicate remote command replay is refused and never executed twice', async () => {
    const { authority, providerCalls, command, frame } = makeAuthority()
    const cmd = command()
    const first = await authority.execute(frame(cmd), { trusted: true })
    expect(first.ok).toBe(true)
    expect(providerCalls).toHaveLength(1)

    // The exact same frame (same request id, same nonce, same proof) arrives
    // again — the classic gateway redelivery after a lost ack.
    const replay = await authority.execute(frame(cmd), { trusted: true })
    expect(replay).toMatchObject({ ok: false, error: { code: 'replay_rejected' } })
    expect(providerCalls).toHaveLength(1)
    expect(authority.countersSnapshot().replayRejected).toBeGreaterThan(0)

    // A logical retry (fresh request id AND nonce, same idempotency shape)
    // goes through: only the replayed bytes are refused.
    const retry = await authority.execute(frame(command()), { trusted: true })
    expect(retry.ok).toBe(true)
    expect(providerCalls).toHaveLength(2)
  })

  test('gateway loss revokes channels and grants; reconnect never inherits old authority', async () => {
    const { authority, identity, providerCalls, command, frame } = makeAuthority()

    // A grant minted on the live gateway.
    const grant = authority.mintStreamGrant({
      identity,
      protocol: 'terminal-bytes-v1',
      scope: SCOPE,
      resource: { kind: 'terminal', id: 't1', generation: 1 },
      direction: 'write',
    })

    const first = await authority.execute(frame(command()), { trusted: true })
    expect(first.ok).toBe(true)

    // The gateway dies: every channel and grant is torn down.
    expect(authority.revokeAllChannels()).toBe(1)

    // The in-flight frame is not silently re-executed by the new gateway.
    const orphaned = await authority.execute(frame(command()), { trusted: true })
    expect(orphaned).toMatchObject({ ok: false, error: { code: 'channel_unauthenticated' } })
    expect(providerCalls).toHaveLength(1)

    // The old grant cannot attach after gateway loss: the old channel
    // identity is dead, and grants are re-minted on reconnect, never
    // inherited. (Structurally valid attach: a real proof shape.)
    expect(authority.hasStreamProvider('terminal-bytes-v1')).toBe(false)
    const oldGrantAttach = {
      schemaVersion: 1,
      grantId: grant.grantId,
      requestId: randomUUID(),
      nonce: Buffer.from(randomUUID()).toString('base64url'),
      fromSequence: '0',
      proof: 'A'.repeat(43),
    }
    expect(() => authority.attachStream({ identity, attach: oldGrantAttach })).toThrow(
      'unknown channel credential'
    )

    // Reconnect: a fresh trusted handshake with a fresh bootstrap.
    const revived = authority.handshake(handshakePayload(authority.issueLaunchBootstrap()), {
      trusted: true,
    })
    expect(revived.ok).toBe(true)
    if (!revived.ok) return

    // On the reconnected channel the pre-loss grant is gone entirely.
    expect(() =>
      authority.attachStream({
        identity: {
          channelId: revived.channelId,
          clientCredentialId: revived.clientCredentialId,
        },
        attach: oldGrantAttach,
      })
    ).toThrow('stream grant is unknown')
    // The old channel's identity stays dead after the reconnect.
    const stale = await authority.execute(frame(command()), { trusted: true })
    expect(stale).toMatchObject({ ok: false, error: { code: 'channel_unauthenticated' } })
    // The reconnected channel serves fresh commands.
    const newSecret = Buffer.from(revived.clientSecret, 'base64url')
    const newCommand = command()
    const reconnected = await authority.execute(
      {
        channelId: revived.channelId,
        clientCredentialId: revived.clientCredentialId,
        command: newCommand,
        proof: createHmac('sha256', newSecret)
          .update(
            devCommandProofMessage({
              channelId: revived.channelId,
              clientCredentialId: revived.clientCredentialId,
              command: newCommand,
            })
          )
          .digest('base64url'),
      },
      { trusted: true }
    )
    expect(reconnected.ok).toBe(true)
  })

  test('the consumed-nonce ledger expires: bounded retention, then the nonce is free again', async () => {
    const { authority, command, frame } = makeAuthority()
    const nonce = Buffer.from(randomUUID()).toString('base64url')

    const original = command({ nonce })
    const accepted = await authority.execute(frame(original), { trusted: true })
    expect(accepted.ok).toBe(true)

    // Ten seconds later a different command reusing the nonce is a replay.
    clockNow += 10_000
    const reused = command({ nonce })
    const replayed = await authority.execute(frame(reused), { trusted: true })
    expect(replayed).toMatchObject({ ok: false, error: { code: 'replay_rejected' } })

    // Past expiry (60 s) plus the retention window (30 s) the ledger entry is
    // swept — the bound is finite. The nonce can be consumed again by a
    // fresh, fully valid envelope; the expired original itself stays dead.
    clockNow += 81_000 // 91 s after the original: retention (expiresAt+30 s) has passed
    const freshReuse = command({ nonce })
    const afterExpiry = await authority.execute(frame(freshReuse), { trusted: true })
    expect(afterExpiry.ok).toBe(true)

    // The original envelope, replayed verbatim now, is expired — never
    // resurrected by the sweep.
    const resurrected = await authority.execute(frame(original), { trusted: true })
    expect(resurrected).toMatchObject({ ok: false, error: { code: 'token_expired' } })
  })
})
