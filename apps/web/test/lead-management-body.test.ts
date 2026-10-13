import { describe, expect, test } from 'bun:test'
import { managementInputDigest, type ManagementAuthorityDecision } from '@adea-ai/types/management'

import {
  createLeadManagementHandler,
  type LeadManagementRouteDependencies,
} from '../src/server/lead-management-route'
import {
  MANAGEMENT_NOW,
  MANAGEMENT_PROJECT,
  MANAGEMENT_WORKSPACE,
  managementAuthorityDecision,
} from './helpers/management-authority'

// Focused body-boundary checks for the lead host endpoint: authentication happens before any
// request byte is read, the 64 KiB limit counts bytes actually read (declared or not), an aborted
// or overflowing body cancels its stream, and refusals perform no claim, authority or effect.

const URL = 'https://adea-fixture.invalid/api/internal/pi-durable/management'
const LIMIT_BYTES = 64 * 1024
const CANONICAL_REQUEST = {
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
}
const ACTOR = { kind: 'user', userId: '0f3a2e1c-0000-4000-8000-0000000000bb' } as const

/** The canonical request, optionally padded with extra opaque fields the route only digests. */
function padded(padding: string) {
  return { ...CANONICAL_REQUEST, padding }
}

function callBody(input: unknown, canonicalRequest: unknown = CANONICAL_REQUEST): string {
  return JSON.stringify({
    canonicalRequest,
    input,
    operation: 'project.update',
    schemaVersion: 'adea-management-call/v1',
    targetId: MANAGEMENT_PROJECT,
    workspaceId: MANAGEMENT_WORKSPACE,
  })
}

async function decisionFor(input: unknown): Promise<ManagementAuthorityDecision> {
  return managementAuthorityDecision({
    input,
    operation: 'project.update',
    principal: ACTOR,
    targetId: MANAGEMENT_PROJECT,
    workspaceId: MANAGEMENT_WORKSPACE,
  })
}

/** Verifier that accepts the decision (or rejects with null) and records when it ran. */
async function authenticated(
  decision: ManagementAuthorityDecision,
  canonicalRequest: unknown = CANONICAL_REQUEST
) {
  const canonicalRequestDigest = await managementInputDigest(canonicalRequest)
  if (!canonicalRequestDigest) throw new Error('canonical request digest unavailable')
  return async () => ({ canonicalRequestDigest, decision })
}

function build(verify: LeadManagementRouteDependencies['verify']) {
  const spy = { assertCurrent: 0, claim: 0, executed: 0 }
  const handler = createLeadManagementHandler({
    assertCurrent: async () => {
      spy.assertCurrent += 1
    },
    claim: async () => {
      spy.claim += 1
      return { state: 'claimed' as const }
    },
    complete: async () => true,
    now: () => MANAGEMENT_NOW,
    operationsFor: () =>
      ({
        projectUpdate: async () => {
          spy.executed += 1
          return { ok: true, operation: 'project.update', value: { id: MANAGEMENT_PROJECT } }
        },
      }) as never,
    verify,
  })
  return { handler, spy }
}

/** A chunked body (no content-length) that emits `chunks` 16 KiB chunks and records its life. */
function countedBody(chunks: number, chunkBytes = 16 * 1024) {
  const state = { cancelled: false, pulled: 0 }
  const body = new ReadableStream<Uint8Array>(
    {
      cancel() {
        state.cancelled = true
      },
      pull(controller) {
        state.pulled += 1
        if (state.pulled > chunks) controller.close()
        else controller.enqueue(new Uint8Array(chunkBytes).fill(0x78))
      },
    },
    { highWaterMark: 0 }
  )
  return { body, state }
}

/** A chunked body carrying the exact UTF-8 bytes of `text`, split into 16 KiB chunks. */
function chunkedText(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close()
      controller.enqueue(bytes.slice(offset, offset + 16 * 1024))
      offset += 16 * 1024
    },
  })
}

function post(body: BodyInit | null, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request(URL, {
    body,
    duplex: 'half',
    headers: { authorization: 'Bearer signed-token', ...headers },
    method: 'POST',
    signal,
  } as RequestInit)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('lead management body boundary (#1215)', () => {
  test('an unauthenticated delivery is refused before any request byte is read', async () => {
    const stream = countedBody(64)
    const { handler, spy } = build(async () => null)

    const response = await handler(post(stream.body))

    expect(response.status).toBe(404)
    expect(stream.state.pulled).toBe(0)
    expect(spy.assertCurrent + spy.claim + spy.executed).toBe(0)
  })

  test('an undeclared body is bounded at 64 KiB of bytes read and its stream is cancelled', async () => {
    const stream = countedBody(64)
    const { handler, spy } = build(await authenticated(await decisionFor({ name: 'Renamed' })))

    const response = await handler(post(stream.body))

    expect(response.status).toBe(404)
    expect(stream.state.cancelled).toBe(true)
    // 64 KiB is reached after four 16 KiB chunks; one more may already be queued.
    expect(stream.state.pulled).toBeLessThanOrEqual(6)
    expect(spy.assertCurrent + spy.claim + spy.executed).toBe(0)
  })

  test('a declared length that understates the body still bounds the bytes actually read', async () => {
    const stream = countedBody(64)
    const { handler, spy } = build(await authenticated(await decisionFor({ name: 'Renamed' })))

    const response = await handler(post(stream.body, { 'content-length': '100' }))

    expect(response.status).toBe(404)
    expect(stream.state.cancelled).toBe(true)
    expect(stream.state.pulled).toBeLessThanOrEqual(6)
    expect(spy.assertCurrent + spy.claim + spy.executed).toBe(0)
  })

  test('a multibyte body over 64 KiB of bytes is refused though its character count is under the limit', async () => {
    // Padding lives in the opaque canonical request, which the route only digests, so the call
    // is otherwise valid and only the byte bound can refuse it.
    const canonical = padded('界'.repeat(22_000))
    const text = callBody({ name: 'Renamed' }, canonical)
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(LIMIT_BYTES)
    expect(text.length).toBeLessThan(LIMIT_BYTES)
    const { handler, spy } = build(
      await authenticated(await decisionFor({ name: 'Renamed' }), canonical)
    )

    const response = await handler(post(chunkedText(text)))

    expect(response.status).toBe(404)
    expect(spy.assertCurrent).toBe(0)
    expect(spy.claim).toBe(0)
    expect(spy.executed).toBe(0)
  })

  test('an aborted delivery stops reading, cancels its stream and performs no effect', async () => {
    const controller = new AbortController()
    let cancelled = false
    // Emits one chunk, then stalls: the body never completes unless the request is cancelled.
    const stalled = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
      start(streamController) {
        streamController.enqueue(new Uint8Array(1024).fill(0x78))
      },
    })
    const { handler, spy } = build(await authenticated(await decisionFor({ name: 'Renamed' })))

    const pending = handler(post(stalled, {}, controller.signal))
    setTimeout(() => controller.abort(), 20)
    const outcome = await Promise.race([
      pending.then((response) => response.status),
      sleep(2_000).then(() => 'stalled'),
    ])

    expect(outcome).toBe(404)
    expect(cancelled).toBe(true)
    expect(spy.assertCurrent + spy.claim + spy.executed).toBe(0)
  })

  test('a valid multibyte body within the byte limit still reaches the effect', async () => {
    const canonical = padded('界'.repeat(1_000))
    const { handler, spy } = build(
      await authenticated(await decisionFor({ name: 'Renamed' }), canonical)
    )

    const response = await handler(post(chunkedText(callBody({ name: 'Renamed' }, canonical))))

    expect(response.status).toBe(200)
    expect(spy.assertCurrent).toBe(1)
    expect(spy.claim).toBe(1)
    expect(spy.executed).toBe(1)
  })
})
