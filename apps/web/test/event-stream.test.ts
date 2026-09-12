import { describe, expect, test } from 'bun:test'

import {
  decodeWorkspaceEventCursor,
  encodeWorkspaceEventCursor,
  EVENT_CURSOR_LIFETIME_MS,
} from '../src/server/event-cursor'
import {
  decideReplay,
  drainingFrame,
  eventFrame,
  heartbeatFrame,
  resyncFrame,
  revalidationOutcome,
  StreamConnections,
  STREAM_CONNECTION_LIMIT,
} from '../src/server/workspace-event-stream'

const environment = { NEON_AUTH_COOKIE_SECRET: 'a'.repeat(48) }
const workspaceId = 'aaaaaaaa-1111-4111-8111-111111111111'
const otherWorkspaceId = 'bbbbbbbb-2222-4222-8222-222222222222'

describe('workspace event cursor', () => {
  test('round-trips a sequence for its own workspace', async () => {
    const token = await encodeWorkspaceEventCursor({ sequence: 42, workspaceId }, environment)
    expect(token).not.toBeNull()

    const decoded = await decodeWorkspaceEventCursor(token!, workspaceId, environment)
    expect(decoded).toEqual({ ok: true, cursor: { sequence: 42, workspaceId } })
  })

  test('does not expose the raw sequence as the token', async () => {
    const token = await encodeWorkspaceEventCursor({ sequence: 42, workspaceId }, environment)
    expect(token).not.toContain('42')
  })

  test('refuses a cursor bound to another workspace', async () => {
    const token = await encodeWorkspaceEventCursor({ sequence: 7, workspaceId }, environment)
    expect(await decodeWorkspaceEventCursor(token!, otherWorkspaceId, environment)).toEqual({
      ok: false,
      reason: 'foreign-workspace',
    })
  })

  test('refuses a tampered or foreign-signed cursor', async () => {
    const token = await encodeWorkspaceEventCursor({ sequence: 7, workspaceId }, environment)
    const [payload, signature] = token!.split('.')
    expect(
      await decodeWorkspaceEventCursor(`${payload}.${signature}x`, workspaceId, environment)
    ).toEqual({ ok: false, reason: 'malformed' })
    // Signed with a different deployment secret: not ours.
    const foreign = await encodeWorkspaceEventCursor(
      { sequence: 7, workspaceId },
      {
        NEON_AUTH_COOKIE_SECRET: 'b'.repeat(48),
      }
    )
    expect(await decodeWorkspaceEventCursor(foreign!, workspaceId, environment)).toEqual({
      ok: false,
      reason: 'malformed',
    })
    expect(await decodeWorkspaceEventCursor('not-a-cursor', workspaceId, environment)).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  test('expires rather than trusting an old cursor forever', async () => {
    const issuedAt = 1_000_000
    const token = await encodeWorkspaceEventCursor(
      { sequence: 5, workspaceId },
      environment,
      issuedAt
    )
    expect(
      await decodeWorkspaceEventCursor(
        token!,
        workspaceId,
        environment,
        issuedAt + EVENT_CURSOR_LIFETIME_MS + 1
      )
    ).toEqual({ ok: false, reason: 'expired' })
  })

  test('fails closed when the deployment has no signing secret', async () => {
    expect(await encodeWorkspaceEventCursor({ sequence: 1, workspaceId }, {})).toBeNull()
    expect(await decodeWorkspaceEventCursor('v1.abc.def', workspaceId, {})).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })
})

describe('workspace event stream protocol', () => {
  const event = {
    aggregateId: 'cccccccc-3333-4333-8333-333333333333',
    aggregateType: 'message',
    actor: { id: 'user-1', kind: 'user' as const },
    correlationId: null,
    eventId: 'dddddddd-4444-4444-8444-444444444444',
    eventType: 'message.created',
    occurredAt: new Date('2026-09-12T00:00:00.000Z'),
    payload: { messageId: 'cccccccc-3333-4333-8333-333333333333' },
    schemaVersion: 1,
    workspaceSequence: 9,
  }

  test('frames carry the opaque cursor as the SSE id, never the sequence', () => {
    const frame = eventFrame(event, 'opaque-cursor-value')
    expect(frame).toContain('id: opaque-cursor-value\n')
    expect(frame).toContain('event: workspace.event\n')
    const data = JSON.parse(frame.split('data: ')[1]!.split('\n')[0]!) as Record<string, unknown>
    expect(data.workspaceSequence).toBe(9)
    expect(data.schemaVersion).toBe(1)
    expect(data.occurredAt).toBe('2026-09-12T00:00:00.000Z')
    // Only cloud-safe fields travel: the payload came from the redacted log.
    expect(Object.keys(data).toSorted()).toEqual([
      'actor',
      'aggregateId',
      'aggregateType',
      'eventId',
      'eventType',
      'occurredAt',
      'payload',
      'schemaVersion',
      'workspaceSequence',
    ])
  })

  test('heartbeat, resync, and draining frames are explicit', () => {
    expect(heartbeatFrame()).toBe(': heartbeat\n\n')
    expect(resyncFrame('cursor-behind-retained-window', 'c1')).toContain('event: resync_required')
    expect(resyncFrame('cursor-behind-retained-window', 'c1')).toContain(
      'cursor-behind-retained-window'
    )
    expect(drainingFrame()).toContain('event: stream_unavailable')
    expect(drainingFrame()).toContain('draining')
  })

  test('replay decisions never hand out an unprovable range', () => {
    const window = { earliest: 5, latest: 20 }

    // Fresh subscriber: current state plus live events, not the whole history.
    expect(decideReplay(null, window)).toEqual({ mode: 'live-from-head', from: 20 })
    // Inside the retained window: replay everything after the cursor.
    expect(decideReplay(12, window)).toEqual({ mode: 'replay', from: 12 })
    expect(decideReplay(4, window)).toEqual({ mode: 'replay', from: 4 })
    // Behind the retained window, or ahead of the head: resync, not a gap.
    expect(decideReplay(3, window)).toEqual({
      mode: 'resync',
      reason: 'cursor-behind-retained-window',
    })
    expect(decideReplay(21, window)).toEqual({ mode: 'resync', reason: 'cursor-ahead-of-head' })
    // An empty log is not a reason to refuse a fresh subscriber.
    expect(decideReplay(null, { earliest: null, latest: 0 })).toEqual({
      mode: 'live-from-head',
      from: 0,
    })
    expect(decideReplay(0, { earliest: null, latest: 0 })).toEqual({ mode: 'replay', from: 0 })
  })

  test('revalidation ends the stream when the session or the membership is gone', () => {
    const allowed = { allowed: true }
    const denied = { allowed: false }
    const principal = { principalId: 'user-1' }

    // Still the same subscriber with the same permission: keep delivering.
    expect(revalidationOutcome(principal, 'user-1', allowed)).toEqual({ state: 'allowed' })
    // A revoked session or device: the subscriber no longer resolves, so the
    // stream ends with a reason the client can act on.
    expect(revalidationOutcome(null, 'user-1', allowed)).toEqual({
      state: 'terminate',
      reason: 'session-revoked',
    })
    // Resolving to a different principal is equally a revoked session.
    expect(revalidationOutcome({ principalId: 'user-2' }, 'user-1', allowed)).toEqual({
      state: 'terminate',
      reason: 'session-revoked',
    })
    // A removed membership ends the stream even though the session is alive.
    expect(revalidationOutcome(principal, 'user-1', denied)).toEqual({
      state: 'terminate',
      reason: 'membership-revoked',
    })
  })

  test('an ending stream names why it is ending', () => {
    expect(drainingFrame()).toContain('"reason":"draining"')
    expect(drainingFrame('membership-revoked')).toContain('"reason":"membership-revoked"')
    expect(drainingFrame('session-revoked')).toContain('"reason":"session-revoked"')
  })

  test('bounds concurrent streams per workspace and releases them', () => {
    const connections = new StreamConnections()
    for (let index = 0; index < STREAM_CONNECTION_LIMIT; index += 1) {
      expect(connections.acquire(workspaceId)).toBe(true)
    }
    expect(connections.acquire(workspaceId)).toBe(false)
    // Another workspace is unaffected.
    expect(connections.acquire(otherWorkspaceId)).toBe(true)

    connections.release(workspaceId)
    expect(connections.open(workspaceId)).toBe(STREAM_CONNECTION_LIMIT - 1)
    expect(connections.acquire(workspaceId)).toBe(true)
    for (let index = 0; index < STREAM_CONNECTION_LIMIT + 2; index += 1) {
      connections.release(workspaceId)
    }
    expect(connections.open(workspaceId)).toBe(0)
  })
})
