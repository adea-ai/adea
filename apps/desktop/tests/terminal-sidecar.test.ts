// Issue #396 sidecar contract: endpoint file authority, authenticated hello
// (credential + fresh nonce + protocol identity + scope binding), terminal
// operations over the framed protocol, byte-preserving data frames, resync
// propagation, and adoption decisions (adopt / drain_upgrade / incompatible).
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { adoptSidecar } from '../shell/src/dev-runtime/terminal/sidecar/adoption'
import {
  connectSidecarClient,
  type SidecarClient,
} from '../shell/src/dev-runtime/terminal/sidecar/client'
import {
  endpointFilePath,
  readEndpointFile,
  writeEndpointFile,
} from '../shell/src/dev-runtime/terminal/sidecar/endpoint-file'
import {
  createSidecarService,
  newSidecarCredential,
  type SidecarService,
} from '../shell/src/dev-runtime/terminal/sidecar/service'
import {
  SIDECAR_PROTOCOL,
  type ByteDuplex,
  type ByteFrameMeta,
} from '../shell/src/dev-runtime/terminal/sidecar/protocol'
import { createBunPtyAdapter } from '../shell/src/dev-runtime/terminal/pty-adapter'
import { TERMINAL_LIMITS } from '../shell/src/dev-runtime/terminal/limits'
import { createFakePtyAdapter } from './fixtures/fake-pty'
import { createBoundedLoopbackPair, createLoopbackPair } from './fixtures/loopback-duplex'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const executableIdentity = 'adea-terminal-sidecar@1.0.0-test'
const terminalId = '00000000-0000-4000-8000-0000000000aa'

type FrameRecord = { meta: ByteFrameMeta; bytes: Uint8Array }

type Harness = {
  dataDir: string
  runtimeRoot: string
  service: SidecarService
  fake: ReturnType<typeof createFakePtyAdapter>
  credentialBase64: string
  connectClient: (overrides?: {
    credential?: string
    nonce?: string
    onDataFrame?: (meta: ByteFrameMeta, bytes: Uint8Array) => void
    onResync?: (notice: {
      terminalId: string
      subscriberId: string
      checkpointSequence: string
    }) => void
    onExited?: (notice: { terminalId: string; generation: number; exitCode: number | null }) => void
  }) => Promise<SidecarClient>
  tryConnectClient: (overrides?: {
    credential?: string
    nonce?: string
  }) => Promise<{ ok: true; client: SidecarClient } | { ok: false; code: string; message: string }>
}

function makeHarness(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-sidecar-'))
  const runtimeRoot = join(dataDir, 'dev-runtime')
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })
  const credential = newSidecarCredential()
  const fake = createFakePtyAdapter()
  const service = createSidecarService({
    runtimeRoot,
    ptyAdapter: fake.adapter,
    sidecarVersion: '1.0.0-test',
    credential,
    executableIdentity,
    pidStartIdentity: 'test-start-identity',
  })
  const credentialBase64 = Buffer.from(credential).toString('base64url')

  async function tryConnectClient(
    overrides: { credential?: string; nonce?: string } = {}
  ): Promise<{ ok: true; client: SidecarClient } | { ok: false; code: string; message: string }> {
    const [clientSide, serverSide] = createLoopbackPair()
    service.handleConnection(serverSide)
    return connectSidecarClient({
      duplex: clientSide,
      scope,
      credential: overrides.credential ?? credentialBase64,
      nonce: overrides.nonce ?? `nonce-${Math.random()}`,
    })
  }

  async function connectClient(
    overrides: Parameters<typeof tryConnectClient>[0] & {
      onDataFrame?: (meta: ByteFrameMeta, bytes: Uint8Array) => void
      onResync?: (notice: {
        terminalId: string
        subscriberId: string
        checkpointSequence: string
      }) => void
      onExited?: (notice: {
        terminalId: string
        generation: number
        exitCode: number | null
      }) => void
    } = {}
  ): Promise<SidecarClient> {
    const [clientSide, serverSide] = createLoopbackPair()
    service.handleConnection(serverSide)
    const connected = await connectSidecarClient({
      duplex: clientSide,
      scope,
      credential: overrides.credential ?? credentialBase64,
      nonce: overrides.nonce ?? `nonce-${Math.random()}`,
      onDataFrame: overrides.onDataFrame,
      onResync: overrides.onResync,
      onExited: overrides.onExited,
    })
    if (!connected.ok)
      throw new Error(`sidecar connect failed: ${connected.code} ${connected.message}`)
    return connected.client
  }

  return { dataDir, runtimeRoot, service, fake, credentialBase64, connectClient, tryConnectClient }
}

function cleanup(harness: Harness): void {
  rmSync(harness.dataDir, { recursive: true, force: true })
}

async function createTerminal(client: SidecarClient, id = terminalId): Promise<void> {
  const created = await client.create({
    terminalId: id,
    generation: 1,
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    shell: '/bin/zsh',
    args: ['-l'],
  })
  expect(created.ok).toBe(true)
}

describe('sidecar endpoint file', () => {
  test('round-trips atomically with owner-only modes and rejects garbage', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-endpoint-'))
    try {
      expect(readEndpointFile(dataDir)).toBeNull()
      writeEndpointFile(dataDir, {
        schemaVersion: 1,
        protocol: SIDECAR_PROTOCOL,
        sidecarVersion: '1.0.0',
        executableIdentity,
        pid: 4242,
        pidStartIdentity: 'start',
        credential: 'cred',
        socketPath: '/tmp/s.sock',
        createdAt: '2026-09-18T00:00:00.000Z',
      })
      const endpoint = readEndpointFile(dataDir)!
      expect(endpoint.protocol).toEqual(SIDECAR_PROTOCOL)
      expect(endpoint.pid).toBe(4242)
      expect(endpoint.credential).toBe('cred')
      expect(statSync(endpointFilePath(dataDir)).mode & 0o777).toBe(0o600)
      writeFileSync(endpointFilePath(dataDir), 'not json{')
      expect(readEndpointFile(dataDir)).toBeNull()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('sidecar service handshake', () => {
  test('authenticates with the endpoint credential and a fresh nonce', async () => {
    const harness = makeHarness()
    try {
      const client = await harness.connectClient()
      expect(client.welcome.sidecarVersion).toBe('1.0.0-test')
      expect(client.welcome.pidStartIdentity).toBe('test-start-identity')
      expect(client.welcome.protocol).toEqual(SIDECAR_PROTOCOL)
      client.close()
    } finally {
      cleanup(harness)
    }
  })

  test('a wrong credential is refused before any terminal operation', async () => {
    const harness = makeHarness()
    try {
      const wrong = Buffer.from(new Uint8Array(32).fill(1)).toString('base64url')
      const result = await harness.tryConnectClient({ credential: wrong })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('channel_unauthenticated')
    } finally {
      cleanup(harness)
    }
  })

  test('a replayed hello nonce is rejected even with the right credential', async () => {
    const harness = makeHarness()
    try {
      const first = await harness.tryConnectClient({ nonce: 'same-nonce' })
      expect(first.ok).toBe(true)
      if (first.ok) first.client.close()
      await Bun.sleep(5)
      const second = await harness.tryConnectClient({ nonce: 'same-nonce' })
      expect(second.ok).toBe(false)
      if (!second.ok) expect(second.code).toBe('replay_rejected')
    } finally {
      cleanup(harness)
    }
  })
})

describe('sidecar terminal lifecycle', () => {
  test('create, input, resize, signal, and list round-trip over the framed protocol', async () => {
    const harness = makeHarness()
    try {
      const client = await harness.connectClient()
      await createTerminal(client)
      const list = await client.list()
      expect(list.ok).toBe(true)
      if (list.ok) {
        const terminals = list.value.terminals as Array<{ terminalId: string; lifecycle: string }>
        expect(terminals.map((terminal) => terminal.terminalId)).toEqual([terminalId])
        expect(terminals[0]!.lifecycle).toBe('running')
      }
      expect(await client.resize(terminalId, 120, 40)).toMatchObject({ ok: true })
      expect(harness.fake.processes[0]!.resizes).toEqual([{ cols: 120, rows: 40 }])
      const input = await client.writeInput(terminalId, new TextEncoder().encode('echo hi\n'))
      expect(input.ok).toBe(true)
      expect(new TextDecoder().decode(harness.fake.processes[0]!.written[0]!)).toBe('echo hi\n')
      expect(await client.signal(terminalId, 'SIGINT')).toMatchObject({ ok: true })
      client.close()
    } finally {
      cleanup(harness)
    }
  })

  test('spawn failure is a typed error surfaced to the client', async () => {
    const harness = makeHarness()
    try {
      const client = await harness.connectClient()
      harness.fake.failNextSpawnWith('spawn_failed', 'no such shell')
      const created = await client.create({
        terminalId,
        generation: 1,
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        shell: '/missing',
        args: [],
      })
      expect(created.ok).toBe(false)
      client.close()
    } finally {
      cleanup(harness)
    }
  })

  test('unsupported platforms surface typed capability state through the sidecar', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-sidecar-win-'))
    try {
      const runtimeRoot = join(dataDir, 'dev-runtime')
      mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })
      const winCredential = newSidecarCredential()
      const winService = createSidecarService({
        runtimeRoot,
        ptyAdapter: createBunPtyAdapter('win32'),
        sidecarVersion: '1.0.0-test',
        credential: winCredential,
        executableIdentity,
        pidStartIdentity: 'x',
      })
      const [clientSide, serverSide] = createLoopbackPair()
      winService.handleConnection(serverSide)
      const connected = await connectSidecarClient({
        duplex: clientSide,
        scope,
        credential: Buffer.from(winCredential).toString('base64url'),
        nonce: 'n',
      })
      // Handshake shape is platform-independent; spawn reports the capability.
      expect(connected.ok).toBe(true)
      if (connected.ok) {
        const created = await connected.client.create({
          terminalId,
          generation: 1,
          cols: 80,
          rows: 24,
          cwd: '/tmp',
          shell: '/bin/zsh',
          args: [],
        })
        expect(created.ok).toBe(false)
        connected.client.close()
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('output streams as byte-preserving data frames; attach replays exactly once', async () => {
    const harness = makeHarness()
    try {
      const received: FrameRecord[] = []
      const client = await harness.connectClient({
        onDataFrame: (meta, bytes) => received.push({ meta, bytes }),
      })
      await createTerminal(client)
      const attached = await client.attach({ terminalId, subscriberId: 'sub-1', sinceSeq: '0' })
      expect(attached).toMatchObject({
        ok: true,
        value: { resyncRequired: false, replayed: 0, nextSeq: '0' },
      })
      // 0xFF is invalid UTF-8: it must survive every frame untouched.
      // The manager coalesces a 4 ms batch window, so distinct flushes need
      // a pause between them.
      harness.fake.processes[0]!.emit(new Uint8Array([0x68, 0xff, 0x69]))
      await Bun.sleep(15)
      harness.fake.processes[0]!.emit(new Uint8Array([0x21]))
      await Bun.sleep(20)
      expect(received.map((frame) => frame.meta.seq)).toEqual(['0', '1'])
      expect([...received[0]!.bytes]).toEqual([0x68, 0xff, 0x69])
      expect([...received[1]!.bytes]).toEqual([0x21])
      expect(received[0]!.meta.generation).toBe(1)
      expect(received[0]!.meta.kind).toBe('terminal.data')
      // A second attach from '0' replays both chunks exactly once.
      const replayed: FrameRecord[] = []
      const client2 = await harness.connectClient({
        onDataFrame: (meta, bytes) => replayed.push({ meta, bytes }),
      })
      const reattached = await client2.attach({ terminalId, subscriberId: 'sub-2', sinceSeq: '0' })
      expect(reattached).toMatchObject({ ok: true, value: { resyncRequired: false, replayed: 2 } })
      await Bun.sleep(20)
      expect(replayed.map((frame) => frame.meta.seq)).toEqual(['0', '1'])
      client.close()
      client2.close()
    } finally {
      cleanup(harness)
    }
  })

  test('exit notices reach every connection and lifecycle flips', async () => {
    const harness = makeHarness()
    try {
      const exits: Array<{ terminalId: string; generation: number; exitCode: number | null }> = []
      const record = (notice: {
        type: string
        terminalId: string
        generation: number
        exitCode: number | null
      }) =>
        exits.push({
          terminalId: notice.terminalId,
          generation: notice.generation,
          exitCode: notice.exitCode,
        })
      const client = await harness.connectClient({ onExited: record })
      const client2 = await harness.connectClient({ onExited: record })
      await createTerminal(client)
      harness.fake.processes[0]!.exit(3)
      await Bun.sleep(20)
      expect(exits).toEqual([
        { terminalId, generation: 1, exitCode: 3 },
        { terminalId, generation: 1, exitCode: 3 },
      ])
      client.close()
      client2.close()
    } finally {
      cleanup(harness)
    }
  })

  test('checkpoint, search, and historyDelete operate on durable state', async () => {
    const harness = makeHarness()
    try {
      const received: FrameRecord[] = []
      const client = await harness.connectClient({
        onDataFrame: (meta, bytes) => received.push({ meta, bytes }),
      })
      await createTerminal(client)
      await client.attach({ terminalId, subscriberId: 'sub-1', sinceSeq: '0' })
      harness.fake.processes[0]!.emit(new TextEncoder().encode('error: boom'))
      await Bun.sleep(20)
      const checkpoint = await client.checkpoint(terminalId)
      expect(checkpoint.ok).toBe(true)
      const search = await client.search(terminalId, 'error:', 10)
      expect(search.ok).toBe(true)
      if (search.ok) {
        const matches = search.value.matches as Array<{ seq: string; preview: string }>
        expect(matches).toHaveLength(1)
        expect(matches[0]!.preview).toContain('error: boom')
      }
      const deleted = await client.deleteHistory(terminalId)
      expect(deleted).toMatchObject({ ok: true, value: { deletedSegments: 1 } })
      const searchAfter = await client.search(terminalId, 'error:', 10)
      expect(searchAfter.ok).toBe(true)
      if (searchAfter.ok) expect(searchAfter.value.matches).toHaveLength(0)
      client.close()
    } finally {
      cleanup(harness)
    }
  })

  test('operations on unknown terminals are typed errors', async () => {
    const harness = makeHarness()
    try {
      const client = await harness.connectClient()
      const missing = '00000000-0000-4000-8000-0000000000bb'
      expect(
        (await client.attach({ terminalId: missing, subscriberId: 's', sinceSeq: '0' })).ok
      ).toBe(false)
      expect((await client.resize(missing, 80, 24)).ok).toBe(false)
      expect((await client.signal(missing, 'SIGINT')).ok).toBe(false)
      expect((await client.terminate(missing)).ok).toBe(false)
      expect((await client.checkpoint(missing)).ok).toBe(false)
      expect((await client.search(missing, 'q', 5)).ok).toBe(false)
      expect((await client.deleteHistory(missing)).ok).toBe(false)
      client.close()
    } finally {
      cleanup(harness)
    }
  })

  test('connection close detaches its subscribers but PTYs live on', async () => {
    const harness = makeHarness()
    try {
      const client = await harness.connectClient()
      await createTerminal(client)
      await client.attach({ terminalId, subscriberId: 'sub-1', sinceSeq: '0' })
      client.close()
      await Bun.sleep(10)
      const list = await harness.connectClient().then(async (fresh) => {
        const result = await fresh.list()
        fresh.close()
        return result
      })
      expect(list.ok).toBe(true)
      if (list.ok) {
        const terminals = list.value.terminals as Array<{
          lifecycle: string
          subscriberCount: number
        }>
        expect(terminals[0]!.lifecycle).toBe('detached')
        expect(terminals[0]!.subscriberCount).toBe(0)
      }
      expect(harness.fake.processes[0]!.kills).toEqual([])
    } finally {
      cleanup(harness)
    }
  })
})

/** Opens a loopback sidecar connection served by the harness. */
function connectTo(harness: Harness): () => Promise<ByteDuplex> {
  return async () => {
    const [clientSide, serverSide] = createLoopbackPair()
    harness.service.handleConnection(serverSide)
    return clientSide
  }
}

describe('sidecar adoption', () => {
  function writeEndpoint(
    harness: Harness,
    overrides?: Partial<Parameters<typeof writeEndpointFile>[1]>
  ): void {
    writeEndpointFile(harness.dataDir, {
      schemaVersion: 1,
      protocol: SIDECAR_PROTOCOL,
      sidecarVersion: '1.0.0-test',
      executableIdentity,
      pid: process.pid,
      pidStartIdentity: 'test-start-identity',
      credential: harness.credentialBase64,
      socketPath: 'loopback',
      createdAt: '2026-09-18T00:00:00.000Z',
      ...overrides,
    })
  }

  test('adopts a compatible sidecar after credential authentication', async () => {
    const harness = makeHarness()
    try {
      writeEndpoint(harness)
      const result = await adoptSidecar({
        dataDir: harness.dataDir,
        scope,
        expectedExecutableIdentity: executableIdentity,
        evaluateAdoption: () => 'adopt',
        connect: connectTo(harness),
        nonce: 'adopt-nonce-1',
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.decision).toBe('adopt')
        expect(result.client.welcome.sidecarVersion).toBe('1.0.0-test')
        result.client.close()
      }
    } finally {
      cleanup(harness)
    }
  })

  test('a replaced executable identity is refused before any protocol traffic', async () => {
    const harness = makeHarness()
    try {
      writeEndpoint(harness, { executableIdentity: 'attacker-binary', credential: 'anything' })
      let connected = false
      const result = await adoptSidecar({
        dataDir: harness.dataDir,
        scope,
        expectedExecutableIdentity: executableIdentity,
        evaluateAdoption: () => 'adopt',
        connect: async () => {
          connected = true
          const [clientSide] = createLoopbackPair()
          return clientSide
        },
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.decision).toBe('incompatible')
        expect(result.code).toBe('identity_mismatch')
      }
      expect(connected).toBe(false)
    } finally {
      cleanup(harness)
    }
  })

  test('supervisor verdict drives adopt / drain_upgrade / incompatible', async () => {
    const harness = makeHarness()
    try {
      writeEndpoint(harness, {
        protocol: { name: 'adea-terminal-sidecar', major: 1, minor: 9 },
        sidecarVersion: '1.9.0-test',
      })
      const drained = await adoptSidecar({
        dataDir: harness.dataDir,
        scope,
        expectedExecutableIdentity: executableIdentity,
        evaluateAdoption: () => 'drain_upgrade',
        connect: connectTo(harness),
        nonce: 'drain-1',
      })
      expect(drained.ok).toBe(true)
      if (drained.ok) {
        expect(drained.decision).toBe('drain_upgrade')
        drained.client.close()
      }
      const incompatible = await adoptSidecar({
        dataDir: harness.dataDir,
        scope,
        expectedExecutableIdentity: executableIdentity,
        evaluateAdoption: () => 'incompatible',
        connect: connectTo(harness),
        nonce: 'drain-2',
      })
      expect(incompatible).toMatchObject({
        ok: false,
        decision: 'incompatible',
        code: 'sidecar_incompatible',
      })
    } finally {
      cleanup(harness)
    }
  })

  test('a sidecar refusing the credential yields an adoption failure, not a fallback', async () => {
    const harness = makeHarness()
    try {
      writeEndpoint(harness, {
        credential: Buffer.from(new Uint8Array(32).fill(5)).toString('base64url'),
      })
      const result = await adoptSidecar({
        dataDir: harness.dataDir,
        scope,
        expectedExecutableIdentity: executableIdentity,
        evaluateAdoption: () => 'adopt',
        connect: connectTo(harness),
        nonce: 'bad-cred-1',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('channel_unauthenticated')
    } finally {
      cleanup(harness)
    }
  })

  test('a missing endpoint without a starter is typed unavailable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-adopt-none-'))
    try {
      const result = await adoptSidecar({
        dataDir,
        scope,
        expectedExecutableIdentity: executableIdentity,
        evaluateAdoption: () => 'adopt',
        connect: async () => {
          throw new Error('never')
        },
      })
      expect(result).toMatchObject({ ok: false, decision: 'incompatible', code: 'unavailable' })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('real sidecar process on this platform', () => {
  test.skipIf(process.platform !== 'darwin')(
    'boots the entry, adopts over a real unix socket, spawns a shell, and streams bytes',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'adea-sidecar-live-'))
      try {
        const entry = new URL('../shell/src/dev-runtime/terminal/sidecar/entry.ts', import.meta.url)
          .pathname
        const child = Bun.spawn(['bun', 'run', entry, '--data-dir', dataDir], {
          env: {
            ...process.env,
            ADEA_SIDECAR_VERSION: '1.0.0-live',
            ADEA_SIDECAR_IDENTITY: executableIdentity,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        let endpoint = null as ReturnType<typeof readEndpointFile>
        for (let index = 0; index < 50 && !endpoint; index += 1) {
          endpoint = readEndpointFile(dataDir)
          if (!endpoint) await Bun.sleep(100)
        }
        if (!endpoint) {
          const stderr = await new Response(child.stderr).text()
          throw new Error(`sidecar entry did not write an endpoint file: ${stderr}`)
        }
        expect(endpoint.pid).toBe(child.pid)
        const { connectUnix } = await import('./fixtures/unix-connect')
        const result = await adoptSidecar({
          dataDir,
          scope,
          expectedExecutableIdentity: executableIdentity,
          evaluateAdoption: (protocol) => (protocol.major === 1 ? 'adopt' : 'incompatible'),
          connect: (socketPath) => connectUnix(socketPath),
        })
        expect(result.ok).toBe(true)
        if (!result.ok) {
          child.kill()
          return
        }
        const client = result.client
        const liveTerminal = '00000000-0000-4000-8000-0000000000cc'
        const created = await client.create({
          terminalId: liveTerminal,
          generation: 1,
          cols: 80,
          rows: 24,
          cwd: '/tmp',
          shell: '/bin/sh',
          args: ['-l'],
        })
        expect(created.ok).toBe(true)
        // A second adopted client attaches for the streaming leg (each
        // adoption mints its own single-use nonce).
        const second = await adoptSidecar({
          dataDir,
          scope,
          expectedExecutableIdentity: executableIdentity,
          evaluateAdoption: () => 'adopt',
          connect: (socketPath) => connectUnix(socketPath),
        })
        expect(second.ok).toBe(true)
        if (!second.ok) {
          child.kill()
          return
        }
        const attached = await second.client.attach({
          terminalId: liveTerminal,
          subscriberId: 'live-sub',
          sinceSeq: '0',
        })
        expect(attached.ok).toBe(true)
        const input = await second.client.writeInput(
          liveTerminal,
          new TextEncoder().encode('echo adea-live-$((41+1))\n')
        )
        expect(input.ok).toBe(true)
        await Bun.sleep(500)
        // The real PTY echoed the command; the durable search path proves
        // the bytes arrived intact end to end.
        const checkpoint = await client.checkpoint(liveTerminal)
        expect(checkpoint.ok).toBe(true)
        const search = await client.search(liveTerminal, 'adea-live-42', 5)
        expect(search.ok).toBe(true)
        if (search.ok) {
          expect(search.value.matches.length).toBeGreaterThan(0)
        }
        await client.deleteHistory(liveTerminal)
        client.close()
        second.client.close()
        child.kill()
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    }
  )
})

describe('durable replay across the ring boundary', () => {
  async function smallRingHarness(
    options: {
      /** Model the transport's bounded write queue (its size, in bytes). */
      queueBound?: number
      /** Offer the transport's pacing seam; `false` is the pre-#593 shape. */
      paced?: boolean
      /** Override the per-subscriber high-water the bridge paces against. */
      subscriberHighWaterBytes?: number
    } = {}
  ) {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-sidecar-ring-'))
    const runtimeRoot = join(dataDir, 'dev-runtime')
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })
    const credential = newSidecarCredential()
    const fake = createFakePtyAdapter()
    const service = createSidecarService({
      runtimeRoot,
      ptyAdapter: fake.adapter,
      sidecarVersion: '1.0.0-test',
      credential,
      executableIdentity,
      pidStartIdentity: 'test-start-identity',
      managerLimits: {
        ...TERMINAL_LIMITS,
        ringMaxBytes: 96,
        ...(options.subscriberHighWaterBytes === undefined
          ? {}
          : { subscriberHighWaterBytes: options.subscriberHighWaterBytes }),
      },
    })
    const bounded =
      options.queueBound === undefined
        ? undefined
        : createBoundedLoopbackPair({
            queueBound: options.queueBound,
            ...(options.paced === undefined ? {} : { paced: options.paced }),
          })
    const [clientSide, serverSide] = bounded
      ? [bounded.client, bounded.server]
      : createLoopbackPair()
    service.handleConnection(serverSide)
    const connected = await connectSidecarClient({
      duplex: clientSide,
      scope,
      credential: Buffer.from(credential).toString('base64url'),
      nonce: 'ring-nonce',
    })
    if (!connected.ok) throw new Error(`sidecar connect failed: ${connected.code}`)
    return {
      service,
      fake,
      runtimeRoot,
      client: connected.client,
      received: [] as FrameRecord[],
      overflowed: () => bounded?.overflowed() ?? false,
      cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
    }
  }

  test('attach below the ring replays the durable checkpoints, exactly once in order', async () => {
    const harness = await smallRingHarness()
    try {
      harness.client.setEvents({
        onDataFrame: (meta, bytes) => harness.received.push({ meta, bytes }),
      })
      await createTerminal(harness.client)
      // ~12 chunk flushes; the 96-byte ring prunes the oldest, while the
      // checkpoint sink retains every chunk (open buffer + segments).
      for (let batch = 0; batch < 12; batch += 1) {
        harness.fake.processes[0]!.emit(new Uint8Array(24).fill(0x61 + batch))
        await Bun.sleep(6)
      }
      const coverage = harness.service.manager.coverage(terminalId)
      expect(coverage).toBeDefined()
      if (!coverage) return
      expect(Number(coverage.oldestSeq)).toBeGreaterThan(0)
      const attached = await harness.client.attach({
        terminalId,
        subscriberId: 'sub-durable',
        sinceSeq: '0',
      })
      expect(attached).toMatchObject({
        ok: true,
        value: { resyncRequired: false, replayed: 12 },
      })
      await Bun.sleep(20)
      expect(harness.received.map((frame) => frame.meta.seq)).toEqual(
        Array.from({ length: 12 }, (_, index) => String(index))
      )
      expect(Array.from(harness.received[0]!.bytes)).toEqual(
        Array.from(new Uint8Array(24).fill(0x61))
      )
      expect(Array.from(harness.received[11]!.bytes)).toEqual(
        Array.from(new Uint8Array(24).fill(0x6c))
      )
    } finally {
      harness.cleanup()
    }
  }, 20_000)

  // #593: the bridge is routinely larger than the transport's write queue, and
  // the attach path used to hand the whole span over synchronously — the
  // connection was ended mid-replay (queue_overflow) and every reconnect
  // re-requested the same oversized bridge, a non-converging loop.
  test('a durable bridge larger than the transport queue paces instead of dying mid-replay (#593)', async () => {
    // The bound holds one full ring replay (the 96-byte ring is 4 framed
    // chunks) but is far below what an unpaced handover of the bridge queues —
    // the next test pins that the same bound really does trip without pacing.
    // The pacing watermark sits below one framed chunk so every chunk must
    // wait its turn rather than sliding in under a larger watermark.
    const harness = await smallRingHarness({
      queueBound: 1536,
      subscriberHighWaterBytes: 100,
    })
    try {
      harness.client.setEvents({
        onDataFrame: (meta, bytes) => harness.received.push({ meta, bytes }),
      })
      await createTerminal(harness.client)
      for (let batch = 0; batch < 12; batch += 1) {
        harness.fake.processes[0]!.emit(new Uint8Array(24).fill(0x61 + batch))
        await Bun.sleep(6)
      }
      const attached = await harness.client.attach({
        terminalId,
        subscriberId: 'sub-paced',
        sinceSeq: '0',
      })
      // The reply still lands after the whole bridge, in order and complete.
      expect(attached).toMatchObject({
        ok: true,
        value: { resyncRequired: false, replayed: 12 },
      })
      expect(harness.overflowed()).toBe(false)
      await Bun.sleep(50)
      expect(harness.received.map((frame) => frame.meta.seq)).toEqual(
        Array.from({ length: 12 }, (_, index) => String(index))
      )
      expect(Array.from(harness.received[11]!.bytes)).toEqual(
        Array.from(new Uint8Array(24).fill(0x6c))
      )
    } finally {
      harness.cleanup()
    }
  }, 20_000)

  test('an unpaced handover of the same bridge trips the queue bound (#593 mechanism)', async () => {
    // Same bound as the paced test: without the pacing seam the whole span is
    // queued at once and the transport fails closed — the failure #593
    // reported from the soak lane.
    const harness = await smallRingHarness({ queueBound: 1536, paced: false })
    try {
      harness.client.setEvents({
        onDataFrame: (meta, bytes) => harness.received.push({ meta, bytes }),
      })
      await createTerminal(harness.client)
      for (let batch = 0; batch < 12; batch += 1) {
        harness.fake.processes[0]!.emit(new Uint8Array(24).fill(0x61 + batch))
        await Bun.sleep(6)
      }
      await harness.client.attach({
        terminalId,
        subscriberId: 'sub-unpaced',
        sinceSeq: '0',
      })
      await Bun.sleep(50)
      // Without the pacing seam the whole span is queued at once and the
      // transport fails closed — the failure #593 reported from the soak lane.
      expect(harness.overflowed()).toBe(true)
    } finally {
      harness.cleanup()
    }
  }, 20_000)

  test('a genuinely unavailable span resyncs from the deterministic ring anchor', async () => {
    const harness = await smallRingHarness()
    try {
      const resyncs: Array<{ terminalId: string; checkpointSequence: string }> = []
      harness.client.setEvents({
        onResync: (notice) => resyncs.push(notice),
      })
      await createTerminal(harness.client)
      for (let batch = 0; batch < 12; batch += 1) {
        harness.fake.processes[0]!.emit(new Uint8Array(24).fill(0x61))
        await Bun.sleep(6)
      }
      // Flush the pending buffer to a segment, then delete it: the
      // retention-boundary shape where the requested span exists nowhere.
      const checkpointed = await harness.client.checkpoint(terminalId)
      expect(checkpointed.ok).toBe(true)
      const sessionDir = join(harness.runtimeRoot, terminalId)
      const segments = readdirSync(sessionDir)
        .filter((name) => name.startsWith('seg-'))
        .toSorted()
      expect(segments.length).toBeGreaterThan(0)
      rmSync(join(sessionDir, segments[0]!))
      const coverage = harness.service.manager.coverage(terminalId)
      expect(coverage).toBeDefined()
      if (!coverage) return
      const attached = await harness.client.attach({
        terminalId,
        subscriberId: 'sub-gap',
        sinceSeq: '0',
      })
      // Deterministic: the anchor is exactly the ring's oldest covered
      // sequence, never a fabricated partial replay.
      expect(attached).toMatchObject({
        ok: true,
        value: { resyncRequired: true, checkpointSequence: coverage.oldestSeq },
      })
      const again = await harness.client.attach({
        terminalId,
        subscriberId: 'sub-gap-2',
        sinceSeq: '0',
      })
      expect(again).toMatchObject({
        ok: true,
        value: { resyncRequired: true, checkpointSequence: coverage.oldestSeq },
      })
      expect(harness.received).toEqual([])
      await Bun.sleep(20)
      expect(resyncs).toEqual([])
    } finally {
      harness.cleanup()
    }
  }, 20_000)

  test('a mid-history hole never replays a fabricated continuous bridge', async () => {
    const harness = await smallRingHarness()
    try {
      await createTerminal(harness.client)
      for (let batch = 0; batch < 12; batch += 1) {
        harness.fake.processes[0]!.emit(new Uint8Array(24).fill(0x61))
        await Bun.sleep(6)
      }
      // Two segments; removing only the OLDEST leaves a hole between seq 0
      // and the survivors, which must resync instead of partial-replaying.
      const checkpointed = await harness.client.checkpoint(terminalId)
      expect(checkpointed.ok).toBe(true)
      const secondBatch: Array<Promise<void>> = []
      for (let batch = 0; batch < 4; batch += 1) {
        harness.fake.processes[0]!.emit(new Uint8Array(24).fill(0x62))
        secondBatch.push(Bun.sleep(6))
      }
      await Promise.all(secondBatch)
      const checkpointAgain = await harness.client.checkpoint(terminalId)
      expect(checkpointAgain.ok).toBe(true)
      const sessionDir = join(harness.runtimeRoot, terminalId)
      const segments = readdirSync(sessionDir)
        .filter((name) => name.startsWith('seg-'))
        .toSorted()
      expect(segments.length).toBeGreaterThanOrEqual(2)
      rmSync(join(sessionDir, segments[0]!))
      const attached = await harness.client.attach({
        terminalId,
        subscriberId: 'sub-hole',
        sinceSeq: '0',
      })
      expect(attached).toMatchObject({
        ok: true,
        value: { resyncRequired: true, checkpointSequence: expect.any(String) },
      })
    } finally {
      harness.cleanup()
    }
  }, 20_000)
})

/** Wires one loopback client whose resync/data events land in the given records. */
async function connectTrackingClient(
  harness: Awaited<ReturnType<typeof midStreamHarness>>,
  received: FrameRecord[],
  resyncs: Array<{ terminalId: string; subscriberId: string; checkpointSequence: string }>
): Promise<SidecarClient> {
  return harness.connect({
    onDataFrame: (meta, bytes) => received.push({ meta, bytes }),
    onResync: (notice) => resyncs.push(notice),
  })
}

describe('mid-stream resync propagation to live clients', () => {
  // Deterministic chunk boundaries: maxChunkBytes equals the emitted block, so
  // every emit flushes exactly one ring chunk synchronously (no batch-timer
  // jitter). The 48-byte ring holds two chunks; the 72-byte high-water trips
  // on the subscriber's third unacknowledged chunk, one prune after the
  // anchor has moved off sequence 0.
  async function midStreamHarness() {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-sidecar-resync-'))
    const runtimeRoot = join(dataDir, 'dev-runtime')
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })
    const credential = newSidecarCredential()
    const fake = createFakePtyAdapter()
    const service = createSidecarService({
      runtimeRoot,
      ptyAdapter: fake.adapter,
      sidecarVersion: '1.0.0-test',
      credential,
      executableIdentity,
      pidStartIdentity: 'test-start-identity',
      managerLimits: {
        ...TERMINAL_LIMITS,
        maxChunkBytes: 24,
        ringMaxBytes: 48,
        subscriberHighWaterBytes: 72,
      },
    })
    async function connect(handlers: {
      onDataFrame?: (meta: ByteFrameMeta, bytes: Uint8Array) => void
      onResync: (notice: {
        terminalId: string
        subscriberId: string
        checkpointSequence: string
      }) => void
    }): Promise<SidecarClient> {
      const [clientSide, serverSide] = createLoopbackPair()
      service.handleConnection(serverSide)
      const connected = await connectSidecarClient({
        duplex: clientSide,
        scope,
        credential: Buffer.from(credential).toString('base64url'),
        nonce: `resync-nonce-${Math.random()}`,
        onDataFrame: handlers.onDataFrame,
        onResync: handlers.onResync,
      })
      if (!connected.ok) throw new Error(`sidecar connect failed: ${connected.code}`)
      return connected.client
    }
    return {
      service,
      fake,
      runtimeRoot,
      connect,
      cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
    }
  }

  test('a live subscriber past the mid-stream high-water gets exactly one resync, anchored at the ring oldest sequence', async () => {
    const harness = await midStreamHarness()
    try {
      const resyncs: Array<{
        terminalId: string
        subscriberId: string
        checkpointSequence: string
      }> = []
      const received: FrameRecord[] = []
      const client = await connectTrackingClient(harness, received, resyncs)
      await createTerminal(client)
      const attached = await client.attach({ terminalId, subscriberId: 'sub-slow', sinceSeq: '0' })
      expect(attached).toMatchObject({
        ok: true,
        value: { resyncRequired: false, replayed: 0 },
      })
      // Inject the fault past the live attach: four full chunks with no acks
      // ever. The subscriber crosses the high-water mid-stream.
      for (let index = 0; index < 4; index += 1) {
        harness.fake.processes[0]!.emit(new Uint8Array(24).fill(0x61 + index))
      }
      await Bun.sleep(20)
      // Ordering across the notice is exactly once: the chunks before the
      // pause arrive in order, byte-preserving, then ONE resync, then nothing.
      expect(received.map((frame) => frame.meta.seq)).toEqual(['0', '1', '2'])
      expect(received.map((frame) => [...frame.bytes])).toEqual([
        Array.from(new Uint8Array(24).fill(0x61)),
        Array.from(new Uint8Array(24).fill(0x62)),
        Array.from(new Uint8Array(24).fill(0x63)),
      ])
      const coverage = harness.service.manager.coverage(terminalId)
      expect(coverage).toBeDefined()
      if (!coverage) return
      // The full wire message the client observes (sidecar protocol control
      // frame, relayed verbatim by the shell-side client).
      expect(resyncs).toEqual([
        {
          type: 'resync',
          terminalId,
          subscriberId: 'sub-slow',
          // Same deterministic anchor the attach-time resync path returns.
          checkpointSequence: coverage.oldestSeq,
        },
      ])
      // Anchor parity, both directions, with the ring frozen at the notice's
      // state: make the durable span genuinely unavailable (checkpoint to a
      // segment, then remove it — the retention-boundary shape) and attach
      // below the ring. The attach-time path resolves to the exact anchor the
      // mid-stream notice carried, never a fabricated partial replay.
      const checkpointed = await client.checkpoint(terminalId)
      expect(checkpointed.ok).toBe(true)
      const sessionDir = join(harness.runtimeRoot, terminalId)
      const segments = readdirSync(sessionDir)
        .filter((name) => name.startsWith('seg-'))
        .toSorted()
      expect(segments.length).toBeGreaterThan(0)
      for (const segment of segments) rmSync(join(sessionDir, segment))
      const parity = await client.attach({ terminalId, subscriberId: 'sub-parity', sinceSeq: '0' })
      expect(parity).toMatchObject({
        ok: true,
        value: { resyncRequired: true, checkpointSequence: resyncs[0]!.checkpointSequence },
      })
      // The PTY keeps draining after the pause, and neither fresh credit nor
      // new output re-notices the latched subscriber: one notice per gap.
      const nextSeqAtNotice = coverage.nextSeq
      harness.fake.processes[0]!.emit(new Uint8Array(24).fill(0x68))
      await Bun.sleep(10)
      expect(Number(harness.service.manager.coverage(terminalId)!.nextSeq)).toBeGreaterThan(
        Number(nextSeqAtNotice)
      )
      const acknowledged = await client.acknowledge(terminalId, 'sub-slow', 4096)
      expect(acknowledged.ok).toBe(true)
      harness.fake.processes[0]!.emit(new Uint8Array(24).fill(0x69))
      await Bun.sleep(10)
      expect(received.map((frame) => frame.meta.seq)).toEqual(['0', '1', '2'])
      expect(resyncs).toHaveLength(1)
    } finally {
      harness.cleanup()
    }
  }, 20_000)

  test('the notice is addressed to the connection that owns the subscriber, never broadcast', async () => {
    const harness = await midStreamHarness()
    try {
      const resyncsA: Array<{ subscriberId: string; checkpointSequence: string }> = []
      const resyncsB: Array<{ subscriberId: string; checkpointSequence: string }> = []
      const receivedA: FrameRecord[] = []
      const receivedB: FrameRecord[] = []
      const clientA = await connectTrackingClient(harness, receivedA, resyncsA)
      const clientB = await connectTrackingClient(harness, receivedB, resyncsB)
      await createTerminal(clientA)
      await clientA.attach({ terminalId, subscriberId: 'sub-a', sinceSeq: '0' })
      await clientB.attach({ terminalId, subscriberId: 'sub-b', sinceSeq: '0' })
      for (let index = 0; index < 4; index += 1) {
        harness.fake.processes[0]!.emit(new Uint8Array(24).fill(0x71 + index))
      }
      await Bun.sleep(20)
      // Each connection observes only its own subscriber's notice — same
      // anchor, addressed routing, one notice per subscriber.
      expect(resyncsA).toEqual([
        {
          type: 'resync',
          terminalId,
          subscriberId: 'sub-a',
          checkpointSequence: expect.any(String),
        },
      ])
      expect(resyncsB).toEqual([
        {
          type: 'resync',
          terminalId,
          subscriberId: 'sub-b',
          checkpointSequence: resyncsA[0]!.checkpointSequence,
        },
      ])
    } finally {
      harness.cleanup()
    }
  }, 20_000)
})
