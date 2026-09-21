// Issue #396 packaged-lane smoke: the full stack — adopted sidecar process,
// M10-gated channel commands, and a real Bun PTY — exercised end to end on
// the repository-pinned Bun line for macOS. Fixture-only suites cannot close
// the terminal issue; this file is the real-PTY evidence for CI on darwin.
import { afterAll, describe, expect, test } from 'bun:test'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decodeDevStreamGrant,
  devCommandProofMessage,
  devOperationDecoders,
  type DevCommand,
  type DevReply,
  type DevStreamFrame,
  type Scope,
} from '../../../packages/types/src/dev-runtime'
import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import { registerTerminalRuntime } from '../shell/src/dev-runtime/terminal/register'
import { adoptSidecar } from '../shell/src/dev-runtime/terminal/sidecar/adoption'
import { readEndpointFile } from '../shell/src/dev-runtime/terminal/sidecar/endpoint-file'
import { connectUnix } from './fixtures/unix-connect'

const SHELL_HOST = '127.0.0.1:4789'
const SHELL_ORIGIN = 'http://127.0.0.1:4789'
const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const executableIdentity = 'adea-terminal-sidecar@smoke'

// The gateway seam is exercised at the authority level here; the full
// WebSocket path is pinned by shell-channel.test.ts and terminal-channel.
let streamProvider: ((session: never) => void) | null = null

describe.skipIf(process.platform !== 'darwin')('packaged macOS real PTY smoke', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-terminal-smoke-'))
  const runtimeRoot = join(dataDir, 'dev-runtime')

  const authority = createChannelAuthority({ shellHost: SHELL_HOST, shellOrigin: SHELL_ORIGIN })
  const handshakeReply = authority.handshake(
    {
      schemaVersion: 1,
      method: 'dev.runtime.handshake.v1',
      requestId: randomUUID(),
      bootstrap: authority.issueLaunchBootstrap(),
      supportedProtocolVersions: ['1'],
      nonce: Buffer.from(randomUUID()).toString('base64url'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
    { trusted: true }
  )
  if (!handshakeReply.ok) throw new Error('handshake failed')
  const identity = {
    channelId: handshakeReply.channelId,
    clientCredentialId: handshakeReply.clientCredentialId,
  }
  const secret = Buffer.from(handshakeReply.clientSecret, 'base64url')

  function execute(
    operation: keyof typeof import('../../packages/types/src/dev-runtime').devOperationDefinitions,
    body: Record<string, unknown>
  ): Promise<DevReply> {
    // Lazy import keeps the type-only reference honest.
    const definitions = require('../../../packages/types/src/dev-runtime').devOperationDefinitions
    const definition = definitions[operation]
    const command: DevCommand = {
      schemaVersion: 1,
      operation,
      requestId: randomUUID(),
      nonce: Buffer.from(randomUUID()).toString('base64url'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      scope,
      capabilities: [...definition.capabilities],
      resource: definition.resource
        ? {
            kind: 'terminal',
            id: body.terminalId as string,
            generation: (body.expectedGeneration as number | undefined) ?? 1,
          }
        : undefined,
      body,
    }
    return authority.execute(
      {
        channelId: identity.channelId,
        clientCredentialId: identity.clientCredentialId,
        command,
        proof: createHmac('sha256', secret)
          .update(
            devCommandProofMessage({
              channelId: identity.channelId,
              clientCredentialId: identity.clientCredentialId,
              command,
            }),
            'utf8'
          )
          .digest('base64url'),
      },
      { trusted: true }
    )
  }

  test('spawn, bytes, resize, signal, exit, and durable search through a real sidecar PTY', async () => {
    // 1. Boot the real sidecar binary entry and adopt it. `bun test` runs
    // every file on one shared thread, so this lane owns its own teardown:
    // pipes are drained (an undrained pipe can wedge the child), and the
    // child gets SIGTERM with observed exit inside a bounded window before
    // SIGKILL — a one-shot SIGTERM under a loaded machine is how leaked
    // sidecar orphans are born.
    const child = Bun.spawn(
      [
        'bun',
        'run',
        join(import.meta.dir, '../shell/src/dev-runtime/terminal/sidecar/entry.ts'),
        '--data-dir',
        dataDir,
      ],
      {
        env: {
          ...process.env,
          ADEA_SIDECAR_VERSION: 'smoke',
          ADEA_SIDECAR_IDENTITY: executableIdentity,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
    const drained = Promise.all([drain(child.stdout), drain(child.stderr)]).catch(() => {})
    try {
      let endpoint = null as ReturnType<typeof readEndpointFile>
      const readyDeadline = Date.now() + 10_000
      while (!endpoint && Date.now() < readyDeadline) {
        endpoint = readEndpointFile(dataDir)
        if (!endpoint) await Bun.sleep(100)
      }
      expect(endpoint).not.toBeNull()
      const adopted = await adoptSidecar({
        dataDir,
        scope,
        expectedExecutableIdentity: executableIdentity,
        evaluateAdoption: (protocol) => (protocol.major === 1 ? 'adopt' : 'incompatible'),
        connect: (socketPath) => connectUnix(socketPath),
      })
      expect(adopted.ok).toBe(true)
      if (!adopted.ok) return
      const sidecar = adopted.client

      registerTerminalRuntime({
        authority,
        gateway: {
          registerStreamHandler: (_protocol, provider) => {
            streamProvider = provider as never
          },
        } as never,
        sidecar,
        scope,
        runtimeRoot,
        resolveWorktreeRoot: (id) =>
          id === '00000000-0000-4000-8000-0000000000b0' ? '/tmp' : null,
      })

      // 2. Create a real PTY through the M10 gate.
      const createReply = await execute('dev.terminal.create', {
        runtimeSessionId: '00000000-0000-4000-8000-0000000000c0',
        worktreeId: '00000000-0000-4000-8000-0000000000b0',
        cols: 80,
        rows: 24,
      })
      expect(createReply.ok).toBe(true)
      if (!createReply.ok) return
      devOperationDecoders['dev.terminal.create'].reply(createReply)
      const terminalId = (createReply.value as { id: string }).id

      // 3. Attach a read stream and drive the real shell.
      const attachReply = await execute('dev.terminal.attach', {
        terminalId,
        expectedGeneration: 1,
        direction: 'read',
        fromSequence: '0',
      })
      expect(attachReply.ok).toBe(true)
      if (!attachReply.ok) return
      const grant = decodeDevStreamGrant(attachReply.value)
      const frames: DevStreamFrame[] = []
      const session = {
        grant,
        inbound: { accept: () => ({ ok: true }), markClosed: () => {} },
        send: (frame: DevStreamFrame) => frames.push(frame),
        close: () => {},
        onFrame: undefined as ((frame: DevStreamFrame) => void) | undefined,
        onClose: undefined as (() => void) | undefined,
      }
      ;(streamProvider as unknown as (session: unknown) => void)(session)
      const inputReply = await execute('dev.terminal.input', {
        terminalId,
        expectedGeneration: 1,
        direction: 'write',
      })
      expect(inputReply.ok).toBe(true)
      if (!inputReply.ok) return
      const writeGrant = decodeDevStreamGrant(inputReply.value)
      const writeSession = {
        grant: writeGrant,
        inbound: { accept: () => ({ ok: true }), markClosed: () => {} },
        send: () => {},
        close: () => {},
        onFrame: undefined as ((frame: DevStreamFrame) => void) | undefined,
        onClose: undefined as (() => void) | undefined,
      }
      ;(streamProvider as unknown as (session: unknown) => void)(writeSession)
      writeSession.onFrame?.({
        type: 'input',
        sequence: '1',
        generation: 1,
        bytes: new TextEncoder().encode('echo adea-smoke-$((40+2))\n'),
      })

      // 4. The real PTY echoes; durable search proves the bytes landed.
      // A login shell may take many seconds to finish its startup files on a
      // loaded machine; the poll budget covers that startup, not just the
      // echo. Deadline-based like every other wait in this lane.
      let matched = false
      const searchDeadline = Date.now() + 45_000
      while (!matched && Date.now() < searchDeadline) {
        await Bun.sleep(250)
        const searchReply = await execute('dev.terminal.search', {
          terminalId,
          expectedGeneration: 1,
          query: 'adea-smoke-42',
          limit: 5,
        })
        if (searchReply.ok) {
          const matches = (searchReply.value as { items: unknown[] }).items
          matched = matches.length > 0
        }
      }
      expect(matched).toBe(true)
      expect(frames.filter((frame) => frame.type === 'data').length).toBeGreaterThan(0)

      // 5. Resize reaches the real PTY; explicit terminate (with its
      // confirmation id) escalates SIGTERM → SIGKILL for an interactive
      // login shell that ignores SIGTERM.
      const resizeReply = await execute('dev.terminal.resize', {
        terminalId,
        expectedGeneration: 1,
        cols: 100,
        rows: 30,
      })
      expect(resizeReply.ok).toBe(true)
      const terminateReply = await execute('dev.terminal.terminate', {
        terminalId,
        expectedGeneration: 1,
        confirmationId: 'smoke-operator-terminate',
      })
      expect(terminateReply.ok).toBe(true)
      let exited = false
      for (let attempt = 0; attempt < 50 && !exited; attempt += 1) {
        await Bun.sleep(200)
        const listReply = await execute('dev.terminal.list', {
          worktreeId: '00000000-0000-4000-8000-0000000000b0',
        })
        if (listReply.ok) {
          const items = (listReply.value as { items: Array<{ id: string; state: string }> }).items
          exited = !items.some((terminal) => terminal.id === terminalId)
        }
      }
      expect(exited).toBe(true)
      sidecar.close()
    } finally {
      await stopSidecarChild(child)
      await drained
    }
  }, 180_000)

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })
})

/** Reads a spawned stream to the end so the child's pipe never fills. */
async function drain(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  for (;;) {
    const { done } = await reader.read()
    if (done) return
  }
}

/** SIGTERM, observe the exit inside a bounded window, then SIGKILL. */
async function stopSidecarChild(child: Bun.Subprocess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  const exitedGracefully = await Promise.race([
    child.exited.then(
      () => true,
      () => false
    ),
    Bun.sleep(3_000).then(() => false),
  ])
  if (exitedGracefully) return
  child.kill('SIGKILL')
  await Promise.race([child.exited, Bun.sleep(1_000)])
}
