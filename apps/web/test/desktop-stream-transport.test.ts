/*
 * The desktop `DevRuntimeService.streams()` transport (#399 residue), driven
 * against a fake shell relay: grant → attach → frames → ack → close. The fake
 * byte-halves mirror the provider contract (offset-sequenced data frames under
 * a 1 MiB credit window, generation-stamped contiguous input, `normal` close
 * after the transfer settles). Proves the renderer never fabricates attach
 * proofs, falls back typed when the surface is absent, and round-trips large
 * files through the pure client model.
 */
import { describe, expect, test } from 'bun:test'

import type { DevStreamFrame, DevStreamGrant } from '@adea-ai/types/dev-runtime'
import { readFileViaStream, writeFileViaStream } from '@adea-ai/dev-view/files/file-stream'

import {
  createDesktopStreamTransport,
  FILE_STREAM_RELAY_EVENT,
} from '../src/lib/desktop-stream-transport'
import type { DesktopShell } from '../src/lib/desktop-bridge'

const CHANNEL = '00000000-0000-4000-8000-00000000c1a5'
const CREDENTIAL = '00000000-0000-4000-8000-00000000c2e2'
const CREDIT_HIGH_WATER = 1024 * 1024

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

function makeGrant(direction: 'read' | 'write'): DevStreamGrant {
  return {
    schemaVersion: 1,
    grantId: '00000000-0000-4000-8000-00000000fe01',
    protocol: 'file-bytes-v1',
    channelId: CHANNEL,
    scope,
    resource: { kind: 'workspace_root', id: 'wt-1', generation: 4 },
    direction,
    fromSequence: '0',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxFrameBytes: 64 * 1024,
  }
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'))
}

type FakeOptions = {
  refuseOpen?: { code: string; message: string }
}

/**
 * The fake shell relay: signed-attach surface plus byte-halves that honor the
 * provider contract — credit-windowed offset reads and contiguous input
 * writes that settle `normal` only when the declared length is received.
 */
function fakeShell(grants: DevStreamGrant[], options?: FakeOptions) {
  const listeners = new Set<(payload: unknown) => void>()
  const spent = new Set<string>()
  const pendingBytes = new Map<string, Uint8Array>()
  const declaredWrites = new Map<string, number>()
  const attachRequests: {
    grantId: string
    requestId: string
    nonce: string
    fromSequence: string
  }[] = []
  const openAttaches: { grantId: string; proof: string }[] = []
  const clientFrames: { streamId: string; frame: DevStreamFrame }[] = []
  const inputReceipts: { streamId: string; received: number }[] = []
  const settled: string[] = []

  type Session = {
    grant: DevStreamGrant
    bytes?: Uint8Array
    cursor: number
    outstanding: number
    received: number
    writeLength: number
  }
  const sessions = new Map<string, Session>()

  function publish(streamId: string, frame: DevStreamFrame): void {
    const relayFrame =
      frame.type === 'data' || frame.type === 'input'
        ? {
            type: frame.type,
            sequence: frame.sequence,
            ...(frame.type === 'input' ? { generation: frame.generation } : {}),
            bytes: toBase64(frame.bytes),
          }
        : frame
    for (const listener of listeners) listener({ streamId, frame: relayFrame })
  }

  function pump(grantId: string): void {
    const session = sessions.get(grantId)
    if (!session || session.grant.direction !== 'read' || !session.bytes) return
    while (session.outstanding < CREDIT_HIGH_WATER && session.cursor < session.bytes.byteLength) {
      const end = Math.min(session.cursor + session.grant.maxFrameBytes, session.bytes.byteLength)
      publish(grantId, {
        type: 'data',
        sequence: String(session.cursor),
        bytes: session.bytes.slice(session.cursor, end),
      })
      session.outstanding += end - session.cursor
      session.cursor = end
    }
    if (session.cursor >= session.bytes.byteLength && session.outstanding === 0) {
      publish(grantId, { type: 'close', code: 'normal', reason: 'bulk read complete' })
      settled.push(grantId)
    }
  }

  function onClientFrame(streamId: string, frame: DevStreamFrame): void {
    const session = sessions.get(streamId)
    if (!session) return
    if (frame.type === 'ack') {
      session.outstanding = Math.max(0, session.outstanding - frame.availableCreditBytes)
      pump(streamId)
      return
    }
    if (frame.type === 'input') {
      if (frame.generation !== session.grant.resource.generation) {
        publish(streamId, {
          type: 'error',
          error: { code: 'stale_generation', retryable: false, message: 'stale generation' },
        })
        return
      }
      if (BigInt(frame.sequence) !== BigInt(session.received)) {
        publish(streamId, {
          type: 'error',
          error: { code: 'file_changed', retryable: false, message: 'chunks must be contiguous' },
        })
        return
      }
      session.received += frame.bytes.byteLength
      inputReceipts.push({ streamId, received: session.received })
      if (session.received >= session.writeLength) {
        publish(streamId, { type: 'close', code: 'normal', reason: 'bulk write complete' })
        settled.push(streamId)
      }
    }
  }

  const bridge: DesktopShell = {
    invoke: (async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'desktop_file_stream_open') {
        const attach = (args?.attach ?? {}) as { grantId?: string; proof?: string }
        if (options?.refuseOpen) {
          return {
            status: 'refused',
            code: options.refuseOpen.code,
            message: options.refuseOpen.message,
          }
        }
        const grant = grants.find((candidate) => candidate.grantId === attach.grantId)
        if (!grant || spent.has(grant.grantId)) {
          return {
            status: 'refused',
            code: spent.has(grant?.grantId ?? '') ? 'replay_rejected' : 'not_found',
            message: 'grant is unknown or spent',
          }
        }
        openAttaches.push({ grantId: grant.grantId, proof: String(attach.proof) })
        spent.add(grant.grantId)
        sessions.set(grant.grantId, {
          grant,
          bytes: pendingBytes.get(grant.grantId),
          cursor: 0,
          outstanding: 0,
          received: 0,
          writeLength: declaredWrites.get(grant.grantId) ?? 0,
        })
        publish(grant.grantId, {
          type: 'opened',
          protocol: grant.protocol,
          generation: grant.resource.generation,
          nextSequence: grant.fromSequence,
        })
        if (grant.direction === 'read') pump(grant.grantId)
        return { status: 'granted', grant }
      }
      if (cmd === 'desktop_file_stream_frame') {
        const streamId = String(args?.streamId ?? '')
        const payload = args?.frame as Record<string, unknown>
        clientFrames.push({ streamId, frame: payload as unknown as DevStreamFrame })
        if (!sessions.has(streamId)) {
          return { status: 'refused', code: 'not_found', message: 'no live stream' }
        }
        if (payload.type === 'ack') {
          onClientFrame(streamId, {
            type: 'ack',
            throughSequence: String(payload.throughSequence),
            availableCreditBytes: Number(payload.availableCreditBytes),
          })
        } else if (payload.type === 'input') {
          onClientFrame(streamId, {
            type: 'input',
            sequence: String(payload.sequence),
            generation: Number(payload.generation),
            bytes: fromBase64(String(payload.bytes)),
          })
        }
        return { status: 'accepted' }
      }
      if (cmd === 'desktop_file_stream_close') {
        const streamId = String(args?.streamId ?? '')
        sessions.delete(streamId)
        settled.push(streamId)
        return { status: 'accepted' }
      }
      throw new Error(`unexpected command: ${cmd}`)
    }) as DesktopShell['invoke'],
    listen: (async (event: string, handler: (payload: unknown) => void) => {
      if (event !== FILE_STREAM_RELAY_EVENT) throw new Error(`unexpected event: ${event}`)
      listeners.add(handler)
      return () => {
        listeners.delete(handler)
      }
    }) as DesktopShell['listen'],
    streamAttachProof: async (request) => {
      attachRequests.push({ ...request })
      return {
        channelId: CHANNEL,
        clientCredentialId: CREDENTIAL,
        proof: `signed:${request.grantId}`,
      }
    },
  }

  return {
    bridge,
    attachRequests,
    openAttaches,
    clientFrames,
    inputReceipts,
    settled,
    /** Feeds the fake's byte payload for a read grant (the "file" on disk). */
    serveBytes(grantId: string, bytes: Uint8Array): void {
      pendingBytes.set(grantId, bytes)
      const session = sessions.get(grantId)
      if (session) session.bytes = bytes
    },
    /** Declares the write length a grant's transfer must complete with. */
    serveWrite(grantId: string, byteLength: number): void {
      declaredWrites.set(grantId, byteLength)
      const session = sessions.get(grantId)
      if (session) session.writeLength = byteLength
    },
    listenerCount: () => listeners.size,
  }
}

describe('createDesktopStreamTransport', () => {
  test('round-trips a large read through credit-windowed fake byte-halves', async () => {
    const grant = makeGrant('read')
    const fake = fakeShell([grant])
    const transport = createDesktopStreamTransport({ bridge: fake.bridge })
    expect(transport).toBeDefined()
    if (!transport) throw new Error('transport missing')

    // 1.5 MiB — forces multiple 1 MiB credit windows through the fake.
    const file = new Uint8Array(Math.floor(1.5 * 1024 * 1024))
    for (let index = 0; index < file.length; index += 1) file[index] = (index * 89 + 13) % 256
    fake.serveBytes(grant.grantId, file)

    const bytes = await readFileViaStream(transport, grant)
    expect(bytes.byteLength).toBe(file.byteLength)
    expect(bytes).toEqual(file)

    // The attach carried the bridge-signed proof, bound to this grant.
    expect(fake.attachRequests[0]).toMatchObject({ grantId: grant.grantId, fromSequence: '0' })
    expect(fake.attachRequests[0]?.nonce.length).toBeGreaterThanOrEqual(22)
    expect(fake.openAttaches[0]?.proof).toBe(`signed:${grant.grantId}`)
    // Credit flowed back across more than one window.
    const acks = fake.clientFrames.filter((entry) => entry.frame.type === 'ack')
    expect(acks.length).toBeGreaterThan(2)
    // The event subscription unwound once the stream settled.
    await Bun.sleep(0)
    expect(fake.listenerCount()).toBe(0)
  })

  test('writes contiguous generation-stamped input and settles on normal close', async () => {
    const grant = makeGrant('write')
    const fake = fakeShell([grant])
    const transport = createDesktopStreamTransport({ bridge: fake.bridge })
    if (!transport) throw new Error('transport missing')

    const content = new Uint8Array(300 * 1024)
    for (let index = 0; index < content.length; index += 1) content[index] = index % 251
    fake.serveWrite(grant.grantId, content.byteLength)
    await writeFileViaStream(transport, grant, content)

    const inputs = fake.clientFrames.filter((entry) => entry.frame.type === 'input')
    expect(inputs.length).toBe(Math.ceil(content.byteLength / grant.maxFrameBytes))
    expect(fake.inputReceipts.at(-1)?.received).toBe(content.byteLength)
    expect(fake.settled).toContain(grant.grantId)
  })

  test('falls back typed when the bridge predates the relay surface', () => {
    const legacyBridge: DesktopShell = {
      invoke: (async () => ({})) as DesktopShell['invoke'],
      listen: (async () => () => {}) as DesktopShell['listen'],
    }
    expect(createDesktopStreamTransport({ bridge: legacyBridge })).toBeUndefined()
  })

  test('surfaces a typed capability refusal instead of a string error', async () => {
    const grant = makeGrant('read')
    const fake = fakeShell([grant], {
      refuseOpen: { code: 'capability_unavailable', message: 'no provider is registered' },
    })
    const transport = createDesktopStreamTransport({ bridge: fake.bridge })
    if (!transport) throw new Error('transport missing')
    await expect(readFileViaStream(transport, grant)).rejects.toMatchObject({
      error: { code: 'capability_unavailable', message: 'no provider is registered' },
    })
  })

  test('a replayed grant attach is refused typed', async () => {
    const grant = makeGrant('read')
    const fake = fakeShell([grant])
    const transport = createDesktopStreamTransport({ bridge: fake.bridge })
    if (!transport) throw new Error('transport missing')
    fake.serveBytes(grant.grantId, new TextEncoder().encode('tiny'))
    await readFileViaStream(transport, grant)
    await expect(readFileViaStream(transport, grant)).rejects.toMatchObject({
      error: { code: 'replay_rejected' },
    })
  })
})
