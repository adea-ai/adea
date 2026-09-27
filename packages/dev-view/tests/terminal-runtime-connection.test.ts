import { describe, expect, test } from 'bun:test'

import type {
  DevCommand,
  DevReply,
  DevRuntimePage,
  DevStreamFrame,
  DevStreamGrant,
  Scope,
  TerminalRecord,
} from '@adea-ai/types/dev-runtime'
import type { DevRuntimeService, DevStreamTransportSocket } from '../src/platform'
import {
  createTerminalRuntimeConnection,
  type TerminalRuntimeConnectionOptions,
} from '../src/terminal/runtime-connection'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

function terminal(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    scope,
    runtimeSessionId: '00000000-0000-4000-8000-000000000011',
    worktreeId: '00000000-0000-4000-8000-000000000012',
    sidecarId: '00000000-0000-4000-8000-000000000013',
    processRecordId: '00000000-0000-4000-8000-000000000014',
    state: 'running',
    health: 'healthy',
    lastSeq: '0',
    generation: 3,
    ...overrides,
  }
}

function successReply(command: DevCommand, value: unknown): DevReply {
  return {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: true,
    value,
    observedAt: '2026-09-27T00:00:00.000Z',
  } as DevReply
}

type TestStreamSocket = DevStreamTransportSocket & {
  readonly direction: DevStreamGrant['direction']
  readonly bufferedAmount?: number
  readonly sent: DevStreamFrame[]
  readonly closed: Array<{ code: number; reason: string }>
  frame(frame: DevStreamFrame): void
}

type HarnessOptions = {
  currentRecords?: TerminalRecord[][]
  mutateGrant?: (direction: DevStreamGrant['direction'], grant: DevStreamGrant) => DevStreamGrant
  omitBufferedAmount?: DevStreamGrant['direction']
  resizeReply?: (command: DevCommand) => Promise<unknown> | unknown
  streamFrame?: (direction: DevStreamGrant['direction'], grant: DevStreamGrant) => DevStreamFrame[]
  executeOverride?: (command: DevCommand, index: number) => Promise<DevReply> | DevReply
}

function makeHarness(options: HarnessOptions = {}) {
  const commands: DevCommand[] = []
  const sockets: TestStreamSocket[] = []
  const frames: DevStreamFrame[] = []
  let recordPage = 0
  let id = 0

  const runtime: DevRuntimeService = {
    state: () => ({ status: 'ready' }),
    capabilitySnapshot: async (requestedScope) => ({
      scope: requestedScope,
      granted: [],
      unavailable: [],
      channelGeneration: 1,
      observedAt: '2026-09-27T00:00:00.000Z',
    }),
    execute: async (command) => {
      const index = commands.length
      commands.push(command)
      if (options.executeOverride) return options.executeOverride(command, index)
      if (command.operation === 'dev.terminal.list') {
        const pageIndex = recordPage++
        const page: DevRuntimePage<TerminalRecord> = {
          items: options.currentRecords?.[pageIndex] ?? [terminal()],
          ...(options.currentRecords?.[pageIndex + 1]
            ? { nextCursor: `page-${pageIndex + 1}` }
            : {}),
          observedAt: '2026-09-27T00:00:00.000Z',
        }
        return successReply(command, page)
      }
      if (command.operation === 'dev.terminal.resize') {
        const result = options.resizeReply ? await options.resizeReply(command) : terminal()
        return successReply(command, result)
      }
      if (
        command.operation !== 'dev.terminal.attach' &&
        command.operation !== 'dev.terminal.input'
      ) {
        throw new Error(`unexpected operation ${command.operation}`)
      }
      const direction = command.operation === 'dev.terminal.attach' ? 'read' : 'write'
      const body = command.body as Record<string, unknown>
      const grant: DevStreamGrant = {
        schemaVersion: 1,
        grantId: `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
        protocol: 'terminal-bytes-v1',
        channelId: '00000000-0000-4000-8000-000000000020',
        scope: command.scope,
        resource: command.resource!,
        direction,
        fromSequence: String(body.fromSequence ?? '0'),
        expiresAt: '2026-09-27T00:01:00.000Z',
        maxFrameBytes: 8,
      }
      return successReply(command, options.mutateGrant?.(direction, grant) ?? grant)
    },
    streams: () => ({
      connect: (grant, handlers) => {
        const sent: DevStreamFrame[] = []
        const closed: Array<{ code: number; reason: string }> = []
        const socket: TestStreamSocket = {
          direction: grant.direction,
          sent,
          closed,
          bufferedAmount: options.omitBufferedAmount === grant.direction ? undefined : 12,
          open: true,
          send(frame) {
            sent.push(frame)
          },
          close(code, reason) {
            closed.push({ code, reason })
          },
          frame(frame) {
            handlers.onFrame(frame)
          },
        }
        sockets.push(socket)
        const emitted = options.streamFrame?.(grant.direction, grant) ?? [
          {
            type: 'opened' as const,
            protocol: 'terminal-bytes-v1' as const,
            generation: grant.resource.generation,
            nextSequence: grant.fromSequence,
          },
        ]
        queueMicrotask(() => emitted.forEach((frame) => handlers.onFrame(frame)))
        return socket
      },
    }),
  }

  const adapterOptions: TerminalRuntimeConnectionOptions = {
    runtime,
    terminal: terminal(),
    commandContext: {
      now: () => new Date('2026-09-27T00:00:00.000Z'),
      randomId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
      nonce: () => 'AAAAAAAAAAAAAAAAAAAAAA',
    },
  }
  const adapter = createTerminalRuntimeConnection(adapterOptions)

  return { adapter, commands, sockets, frames, runtime }
}

function connect(harness: ReturnType<typeof makeHarness>, context = { fromSequence: '0' }) {
  const socket = harness.adapter.connect(
    {
      onFrame: (frame) => harness.frames.push(frame),
      onClose: () => undefined,
    },
    context
  )
  return socket
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('terminal runtime grant connection', () => {
  test('binds two exact, separate grants and routes ACKs only to the measured read stream', async () => {
    const harness = makeHarness()
    const socket = connect(harness)
    await settle()

    expect(harness.adapter.heartbeatMode).toBe('server_only')
    expect(harness.frames[0]).toEqual({
      type: 'opened',
      protocol: 'terminal-bytes-v1',
      generation: 3,
      nextSequence: '0',
    })
    expect(harness.commands.map(({ operation }) => operation)).toEqual([
      'dev.terminal.attach',
      'dev.terminal.input',
    ])
    expect(harness.commands.map(({ resource }) => resource)).toEqual([
      { kind: 'terminal', id: terminal().id, generation: 3 },
      { kind: 'terminal', id: terminal().id, generation: 3 },
    ])
    expect(harness.commands.map(({ body }) => (body as Record<string, unknown>).direction)).toEqual(
      ['read', 'write']
    )
    expect(socket.bufferedAmount).toBe(24)
    socket.send({ type: 'ack', throughSequence: '0', availableCreditBytes: 1 })
    expect(harness.sockets.find(({ direction }) => direction === 'read')?.sent).toEqual([
      { type: 'ack', throughSequence: '0', availableCreditBytes: 1 },
    ])
    expect(harness.sockets.find(({ direction }) => direction === 'write')?.sent).toEqual([])
  })

  test('owns contiguous input byte offsets and continues them only within the same generation', async () => {
    const harness = makeHarness()
    const first = connect(harness)
    await settle()
    first.send({ type: 'input', sequence: '0', generation: 3, bytes: new Uint8Array([1, 2, 3]) })
    expect(harness.sockets.find(({ direction }) => direction === 'write')?.sent).toEqual([
      { type: 'input', sequence: '0', generation: 3, bytes: new Uint8Array([1, 2, 3]) },
    ])
    first.close(1000, 'reconnect')

    const second = connect(harness, { fromSequence: '9', generation: 3 })
    await settle()
    second.send({ type: 'input', sequence: '0', generation: 3, bytes: new Uint8Array([4, 5]) })

    expect(
      harness.commands.filter(({ operation }) => operation === 'dev.terminal.list')
    ).toHaveLength(1)
    expect(
      harness.commands
        .filter(
          ({ operation }) =>
            operation === 'dev.terminal.attach' || operation === 'dev.terminal.input'
        )
        .map(({ body }) => (body as Record<string, unknown>).fromSequence)
    ).toEqual(['0', '0', '9', '3'])
    expect(harness.sockets.filter(({ direction }) => direction === 'write')[1]?.sent).toEqual([
      { type: 'input', sequence: '3', generation: 3, bytes: new Uint8Array([4, 5]) },
    ])
    expect(
      harness.commands.filter(({ operation }) => operation === 'dev.terminal.list')[0]?.body
    ).toEqual({
      runtimeSessionId: terminal().runtimeSessionId,
      limit: 500,
    })
  })

  test('restarts both cursors at zero when the exact terminal record has a fresh generation', async () => {
    const next = terminal({ generation: 4, lastSeq: '17' })
    const harness = makeHarness({ currentRecords: [[next]] })
    const first = connect(harness)
    await settle()
    first.send({ type: 'input', sequence: '0', generation: 3, bytes: new Uint8Array([1, 2, 3]) })
    first.close(1000, 'reconnect')

    const second = connect(harness, { fromSequence: '8', generation: 3 })
    await settle()
    second.send({ type: 'input', sequence: '0', generation: 4, bytes: new Uint8Array([4]) })

    expect(
      harness.commands.slice(-2).map(({ body }) => (body as Record<string, unknown>).fromSequence)
    ).toEqual(['0', '0'])
    expect(harness.frames.at(-1)).toEqual({
      type: 'opened',
      protocol: 'terminal-bytes-v1',
      generation: 4,
      nextSequence: '0',
    })
    expect(harness.sockets.filter(({ direction }) => direction === 'write')[1]?.sent).toEqual([
      { type: 'input', sequence: '0', generation: 4, bytes: new Uint8Array([4]) },
    ])
  })

  test('rejects a grant with mismatched resource binding before attaching either stream', async () => {
    const harness = makeHarness({
      mutateGrant: (direction, grant) =>
        direction === 'write'
          ? {
              ...grant,
              resource: { ...grant.resource, id: '00000000-0000-4000-8000-000000000099' },
            }
          : grant,
    })
    const socket = connect(harness)
    await settle()

    expect(harness.sockets).toHaveLength(0)
    expect(harness.frames).toHaveLength(1)
    expect(harness.frames[0]?.type).toBe('error')
    if (harness.frames[0]?.type === 'error')
      expect(harness.frames[0].error.code).toBe('identity_mismatch')
    expect(socket.open).toBe(false)
  })

  test('rejects read and write grants minted on different authenticated channels', async () => {
    const harness = makeHarness({
      mutateGrant: (direction, grant) =>
        direction === 'write'
          ? { ...grant, channelId: '00000000-0000-4000-8000-000000000099' }
          : grant,
    })
    connect(harness)
    await settle()

    expect(harness.sockets).toHaveLength(0)
    expect(harness.frames.find((frame) => frame.type === 'error')).toMatchObject({
      type: 'error',
      error: { code: 'identity_mismatch', retryable: false },
    })
  })

  test('fails closed when reconnect lookup returns the selected ID outside its captured session', async () => {
    const wrongSession = terminal({ runtimeSessionId: '00000000-0000-4000-8000-000000000088' })
    const harness = makeHarness({ currentRecords: [[wrongSession]] })
    connect(harness, { fromSequence: '4', generation: 3 })
    await settle()

    expect(harness.commands.map(({ operation }) => operation)).toEqual(['dev.terminal.list'])
    expect(harness.sockets).toHaveLength(0)
    expect(harness.frames.find((frame) => frame.type === 'error')).toMatchObject({
      type: 'error',
      error: { code: 'identity_mismatch', retryable: false },
    })
  })

  test('surfaces a typed, nonretryable permission denial without attaching streams', async () => {
    const harness = makeHarness({
      executeOverride: (command) =>
        ({
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: false,
          error: {
            code: 'permission_denied',
            retryable: false,
            message: 'host details stay private',
          },
        }) as DevReply,
    })
    connect(harness)
    await settle()

    expect(harness.sockets).toHaveLength(0)
    expect(harness.frames.find((frame) => frame.type === 'error')).toMatchObject({
      type: 'error',
      error: {
        code: 'permission_denied',
        retryable: false,
        message: 'The terminal connection is not available for this runtime.',
      },
    })
  })

  test('does not accept an authenticated runtime reply for a different command request', async () => {
    const harness = makeHarness({
      executeOverride: (command) => ({
        ...successReply(command, {}),
        requestId: '00000000-0000-4000-8000-000000000099',
      }),
    })
    connect(harness)
    await settle()

    expect(harness.sockets).toHaveLength(0)
    expect(harness.frames.find((frame) => frame.type === 'error')).toMatchObject({
      type: 'error',
      error: { code: 'unsupported_version', retryable: false },
    })
  })

  test('rejects an output cursor outside canonical uint64 before minting grants', async () => {
    const harness = makeHarness()
    connect(harness, { fromSequence: '18446744073709551616' })
    await settle()

    expect(harness.commands).toHaveLength(0)
    expect(harness.frames.find((frame) => frame.type === 'error')).toMatchObject({
      type: 'error',
      error: { code: 'sequence_gap', retryable: false },
    })
  })

  test('rejects a malformed authenticated opened generation before forwarding opened', async () => {
    const harness = makeHarness({
      streamFrame: (direction, grant) =>
        direction === 'read'
          ? [
              {
                type: 'opened',
                protocol: 'terminal-bytes-v1',
                generation: grant.resource.generation + 1,
                nextSequence: grant.fromSequence,
              },
            ]
          : [
              {
                type: 'opened',
                protocol: 'terminal-bytes-v1',
                generation: grant.resource.generation,
                nextSequence: grant.fromSequence,
              },
            ],
    })
    connect(harness)
    await settle()

    expect(harness.frames.some((frame) => frame.type === 'opened')).toBe(false)
    expect(harness.frames.find((frame) => frame.type === 'error')).toMatchObject({
      type: 'error',
      error: { code: 'stale_generation', retryable: false },
    })
  })

  test('rejects an opened output cursor that differs from its exact read grant', async () => {
    const harness = makeHarness({
      streamFrame: (direction, grant) => [
        {
          type: 'opened',
          protocol: 'terminal-bytes-v1',
          generation: grant.resource.generation,
          nextSequence: direction === 'read' ? '1' : grant.fromSequence,
        },
      ],
    })
    connect(harness)
    await settle()

    expect(harness.frames.some((frame) => frame.type === 'opened')).toBe(false)
    expect(harness.frames.find((frame) => frame.type === 'error')).toMatchObject({
      type: 'error',
      error: { code: 'sequence_gap', retryable: false },
    })
  })

  test('paginates the captured session before minting reconnect grants', async () => {
    const other = terminal({ id: '00000000-0000-4000-8000-000000000021' })
    const selected = terminal({ generation: 4 })
    const harness = makeHarness({ currentRecords: [[other], [selected]] })
    connect(harness, { fromSequence: '7', generation: 3 })
    await settle()

    const listCommands = harness.commands.filter(
      ({ operation }) => operation === 'dev.terminal.list'
    )
    expect(listCommands).toHaveLength(2)
    expect(listCommands.map(({ body }) => body)).toEqual([
      { runtimeSessionId: terminal().runtimeSessionId, limit: 500 },
      { runtimeSessionId: terminal().runtimeSessionId, limit: 500, cursor: 'page-1' },
    ])
    expect(
      harness.commands.filter(({ operation }) => operation === 'dev.terminal.attach')[0]?.body
    ).toMatchObject({
      expectedGeneration: 4,
      fromSequence: '0',
    })
    expect(harness.frames.find((frame) => frame.type === 'opened')).toMatchObject({
      type: 'opened',
      generation: 4,
      nextSequence: '0',
    })
  })

  test('stops reconnect pagination when the owning socket closes', async () => {
    let resolvePage!: (reply: DevReply) => void
    const page = new Promise<DevReply>((resolve) => {
      resolvePage = resolve
    })
    const harness = makeHarness({ executeOverride: () => page })
    const socket = connect(harness, { fromSequence: '7', generation: 3 })
    expect(harness.commands).toHaveLength(1)
    socket.close(1000, 'selection changed')
    resolvePage(successReply(harness.commands[0]!, { items: [], nextCursor: 'next-page' }))
    await settle()
    expect(harness.commands.map(({ operation }) => operation)).toEqual(['dev.terminal.list'])
    expect(harness.sockets).toHaveLength(0)
    expect(harness.frames).toHaveLength(0)
  })

  test('bounds active reconnect scans even when every cursor is unique', async () => {
    const harness = makeHarness({
      executeOverride: (command, index) => {
        if (index > 100) throw new Error('fixture stops an unbounded scan')
        return successReply(command, { items: [], nextCursor: `page-${index + 1}` })
      },
    })
    connect(harness, { fromSequence: '7', generation: 3 })
    await settle()
    expect(harness.commands).toHaveLength(64)
    expect(harness.frames.find((frame) => frame.type === 'error')).toMatchObject({
      type: 'error',
      error: { code: 'limit_exceeded', retryable: false },
    })
    expect(harness.sockets).toHaveLength(0)
    expect(harness.commands.every(({ operation }) => operation === 'dev.terminal.list')).toBe(true)
  })

  test('rejects pages larger than the requested terminal record bound', async () => {
    const harness = makeHarness({
      currentRecords: [Array.from({ length: 501 }, () => terminal())],
    })
    connect(harness, { fromSequence: '7', generation: 3 })
    await settle()
    expect(harness.commands).toHaveLength(1)
    expect(harness.frames.find((frame) => frame.type === 'error')).toMatchObject({
      type: 'error',
      error: { code: 'limit_exceeded', retryable: false },
    })
    expect(harness.sockets).toHaveLength(0)
  })

  test('requires real bufferedAmount measurements from both relay sockets', async () => {
    const harness = makeHarness({ omitBufferedAmount: 'write' })
    const socket = connect(harness)
    await settle()

    expect(harness.frames.find((frame) => frame.type === 'opened')).toBeUndefined()
    expect(harness.frames.find((frame) => frame.type === 'error')).toMatchObject({
      type: 'error',
      error: { code: 'capability_unavailable', retryable: false },
    })
    expect(socket.bufferedAmount).toBe(Number.POSITIVE_INFINITY)
  })

  test('bounds replay accumulated while the paired write stream is not yet open', async () => {
    const harness = makeHarness({
      streamFrame: (direction, grant) =>
        direction === 'write'
          ? []
          : [
              {
                type: 'opened',
                protocol: 'terminal-bytes-v1',
                generation: grant.resource.generation,
                nextSequence: grant.fromSequence,
              },
              ...Array.from({ length: 257 }, () => ({
                type: 'heartbeat' as const,
                observedAt: '2026-09-27T00:00:00.000Z',
                throughSequence: '0',
              })),
            ],
    })
    connect(harness)
    await settle()

    expect(harness.frames.some((frame) => frame.type === 'opened')).toBe(false)
    expect(harness.frames.find((frame) => frame.type === 'error')).toMatchObject({
      type: 'error',
      error: { code: 'backpressure', retryable: true },
    })
    expect(harness.sockets.every((socket) => socket.closed.length === 1)).toBe(true)
  })

  test('does not connect late grants after the caller closes during grant issuance', async () => {
    let releaseRead!: (reply: DevReply) => void
    const harness = makeHarness({
      executeOverride: (command) =>
        new Promise<DevReply>((resolve) => {
          if (command.operation === 'dev.terminal.attach') releaseRead = resolve
        }),
    })
    const socket = connect(harness)
    await settle()
    socket.close(1000, 'pane disposed')
    releaseRead?.({
      schemaVersion: 1,
      operation: 'dev.terminal.attach',
      requestId: harness.commands[0]!.requestId,
      ok: false,
      error: { code: 'cancelled', retryable: false, message: 'cancelled' },
    })
    await settle()

    expect(harness.sockets).toHaveLength(0)
    expect(harness.commands.map(({ operation }) => operation)).toEqual(['dev.terminal.attach'])
  })

  test('ignores callbacks from a retired stream after a replacement attempt opens', async () => {
    const harness = makeHarness()
    const first = connect(harness)
    await settle()
    const oldRead = harness.sockets.find(({ direction }) => direction === 'read')!
    first.close(1000, 'replace')

    connect(harness, { fromSequence: '0', generation: 3 })
    await settle()
    const frameCount = harness.frames.length
    oldRead.frame({ type: 'data', sequence: '0', bytes: new Uint8Array([99]) })

    expect(harness.frames).toHaveLength(frameCount)
    expect(harness.frames.some((frame) => frame.type === 'data')).toBe(false)
  })

  test('coalesces resize through the registered control operation, never either stream', async () => {
    let finishFirstResize!: (value: unknown) => void
    const harness = makeHarness({
      resizeReply: (command) =>
        (command.body as Record<string, unknown>).cols === 80
          ? new Promise((resolve) => (finishFirstResize = resolve))
          : terminal(),
    })
    const socket = connect(harness)
    await settle()
    socket.send({ type: 'resize', sequence: '0', generation: 3, cols: 80, rows: 24 })
    socket.send({ type: 'resize', sequence: '0', generation: 3, cols: 100, rows: 30 })
    await settle()

    expect(
      harness.commands.filter(({ operation }) => operation === 'dev.terminal.resize')
    ).toHaveLength(1)
    expect(harness.sockets.every(({ sent }) => sent.length === 0)).toBe(true)
    expect(
      harness.commands.find(({ operation }) => operation === 'dev.terminal.resize')
    ).toMatchObject({
      resource: { kind: 'terminal', id: terminal().id, generation: 3 },
      body: { terminalId: terminal().id, expectedGeneration: 3, cols: 80, rows: 24 },
    })

    finishFirstResize?.(terminal())
    await settle()
    expect(
      harness.commands.filter(({ operation }) => operation === 'dev.terminal.resize')
    ).toHaveLength(2)
    expect(
      harness.commands.filter(({ operation }) => operation === 'dev.terminal.resize')[1]?.body
    ).toMatchObject({
      cols: 100,
      rows: 30,
    })
    expect(harness.sockets.every(({ sent }) => sent.length === 0)).toBe(true)
  })

  test('splits input at the write grant frame limit and advances the byte offset per send', async () => {
    const harness = makeHarness()
    const socket = connect(harness)
    await settle()
    socket.send({
      type: 'input',
      sequence: '0',
      generation: 3,
      bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    })

    expect(harness.sockets.find(({ direction }) => direction === 'write')?.sent).toEqual([
      {
        type: 'input',
        sequence: '0',
        generation: 3,
        bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
      },
      { type: 'input', sequence: '8', generation: 3, bytes: new Uint8Array([8, 9]) },
    ])
  })
})
