/*
 * file-stream model tests (#399 residue): the client half of the
 * `file-bytes-v1` protocol over a scripted transport — reads must be
 * contiguous and acknowledged, writes generation-stamped at running byte
 * offsets, and both settle only on the server's `normal` close.
 */
import { describe, expect, test } from 'bun:test'

import type { DevStreamFrame, DevStreamGrant } from '@adea-ai/types/dev-runtime'

import {
  fileChunkSize,
  readFileViaStream,
  writeFileViaStream,
  type FileStreamTransport,
} from '../src/files/file-stream'
import { readResultFromBytes, sha256Hex } from '../src/editor/editor-document'

const grant: DevStreamGrant = {
  schemaVersion: 1,
  grantId: '00000000-0000-4000-8000-00000000feed',
  protocol: 'file-bytes-v1',
  channelId: '00000000-0000-4000-8000-00000000c1a5',
  scope: {
    accountId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    runtimeNodeId: '00000000-0000-4000-8000-000000000003',
  },
  resource: { kind: 'workspace_root', id: 'wt-1', generation: 4 },
  direction: 'read',
  fromSequence: '0',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  maxFrameBytes: 64 * 1024,
}

type ScriptedSocket = {
  open: boolean
  sent: DevStreamFrame[]
  closed: { code: number; reason: string } | undefined
  handlers: {
    onFrame: (frame: DevStreamFrame) => void
    onClose: (code: number, reason: string) => void
  }
}

function scriptedTransport(
  direction: 'read' | 'write',
  pump?: (socket: ScriptedSocket) => void
): { transport: FileStreamTransport; socket: ScriptedSocket } {
  const socket: ScriptedSocket = {
    open: true,
    sent: [],
    closed: undefined,
    handlers: { onFrame: () => {}, onClose: () => {} },
  }
  const transport: FileStreamTransport = {
    connect(granted, handlers) {
      socket.handlers = handlers
      // The server side of a real attach starts pumping once the socket is
      // open; the script mirrors that ordering.
      if (pump) pump(socket)
      return {
        get open() {
          return socket.open
        },
        send: (frame) => socket.sent.push(frame),
        close: (code, reason) => {
          socket.closed = { code, reason }
          socket.open = false
        },
      }
    },
  }
  void direction
  return { transport, socket }
}

function dataFrame(sequence: string, text: string): DevStreamFrame {
  return { type: 'data', sequence, bytes: new TextEncoder().encode(text) }
}

describe('readFileViaStream', () => {
  test('collects contiguous frames, acks credit, resolves on normal close', async () => {
    let connected: ScriptedSocket | undefined
    const { transport } = scriptedTransport('read', (socket) => {
      connected = socket
      socket.handlers.onFrame(dataFrame('0', 'hello '))
      socket.handlers.onFrame(dataFrame('6', 'world'))
      socket.handlers.onFrame({ type: 'close', code: 'normal' })
    })
    void connected
    const bytes = await readFileViaStream(transport, grant)
    expect(new TextDecoder().decode(bytes)).toBe('hello world')
  })

  test('acks carry per-frame credit and byte-offset sequences', async () => {
    const { transport, socket } = scriptedTransport('read', (session) => {
      session.handlers.onFrame(dataFrame('0', 'ab'))
      session.handlers.onFrame({ type: 'close', code: 'normal' })
    })
    await readFileViaStream(transport, grant)
    const acks = socket.sent.filter((frame) => frame.type === 'ack')
    expect(acks).toEqual([{ type: 'ack', throughSequence: '0', availableCreditBytes: 2 }])
  })

  test('rejects on a sequence gap instead of skipping bytes', async () => {
    const { transport } = scriptedTransport('read', (socket) => {
      socket.handlers.onFrame(dataFrame('0', 'ab'))
      socket.handlers.onFrame(dataFrame('10', 'skipped'))
    })
    await expect(readFileViaStream(transport, grant)).rejects.toMatchObject({
      error: { code: 'invalid_state' },
    })
  })

  test('rejects with the typed error frame', async () => {
    const { transport } = scriptedTransport('read', (socket) => {
      socket.handlers.onFrame({
        type: 'error',
        error: { code: 'stale_generation', retryable: false, message: 'moved on' },
      })
    })
    await expect(readFileViaStream(transport, grant)).rejects.toMatchObject({
      error: { code: 'stale_generation', message: 'moved on' },
    })
  })
})

describe('writeFileViaStream', () => {
  test('sends contiguous generation-stamped chunks at running offsets', async () => {
    let server: ScriptedSocket | undefined
    const payload = new TextEncoder().encode('x'.repeat(200))
    const writeGrant: DevStreamGrant = {
      ...grant,
      direction: 'write',
      maxFrameBytes: 64,
    }
    const { transport, socket } = scriptedTransport('write', (session) => {
      server = session
    })
    const pending = writeFileViaStream(transport, writeGrant, payload)
    expect(socket.sent.length).toBe(Math.ceil(200 / fileChunkSize(writeGrant)))
    expect(socket.sent[0]).toEqual({
      type: 'input',
      sequence: '0',
      generation: 4,
      bytes: payload.subarray(0, 64),
    })
    expect(socket.sent[1]).toEqual({
      type: 'input',
      sequence: '64',
      generation: 4,
      bytes: payload.subarray(64, 128),
    })
    server?.handlers.onFrame({ type: 'close', code: 'normal' })
    await pending
  })

  test('resolves on normal close and rejects a discarded write with file_changed', async () => {
    const writeGrant: DevStreamGrant = { ...grant, direction: 'write' }
    const happy = scriptedTransport('write', (socket) => {
      queueMicrotask(() => socket.handlers.onFrame({ type: 'close', code: 'normal' }))
    })
    await writeFileViaStream(happy.transport, writeGrant, new TextEncoder().encode('tiny'))

    const sad = scriptedTransport('write', (socket) => {
      socket.handlers.onFrame({
        type: 'error',
        error: { code: 'file_changed', retryable: false, message: 'digest mismatch' },
      })
    })
    await expect(
      writeFileViaStream(sad.transport, writeGrant, new TextEncoder().encode('tiny'))
    ).rejects.toMatchObject({ error: { code: 'file_changed' } })
  })
})

describe('readResultFromBytes / sha256Hex', () => {
  test('mirrors the provider analysis for a full read', () => {
    const bytes = new TextEncoder().encode('﻿a\r\nb\n')
    const read = readResultFromBytes(bytes, {
      entry: {
        path: { worktreeId: 'wt', rootIdentity: { mtimeNs: '0', size: '0' }, relativePath: 'x' },
        identity: { mtimeNs: '1', size: String(bytes.byteLength) },
        kind: 'file',
        size: String(bytes.byteLength),
        observedAt: '2026-01-01T00:00:00Z',
      },
    })
    expect(read.eof).toBe(true)
    expect(read.encoding).toBe('utf8')
    expect(read.eol).toBe('mixed')
    const binary = readResultFromBytes(new Uint8Array([0x61, 0x00, 0x62]), {
      entry: read.entry,
    })
    expect(binary.encoding).toBe('binary')
  })

  test('sha256Hex hashes the exact bytes', async () => {
    expect(await sha256Hex(new TextEncoder().encode('hello'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    )
  })
})
