import { describe, expect, test } from 'bun:test'
import { decodeDevCommand, decodeRuntimeEvent, devOperationDefinitions } from '../src/dev-runtime'
import {
  decodeFollowUpQueueReply,
  decodeFollowUpQueueRequest,
  decodeFollowUpQueueSnapshot,
} from '../src/dev-runtime-follow-ups'

const base = { runtimeSessionId: 'session-1', expectedGeneration: 2 }
const enqueue = {
  ...base,
  action: 'enqueue',
  expectedVersion: 0,
  messageId: 'message-1',
  text: 'follow up',
} as const

describe('generation-fenced follow-up queue contract', () => {
  test('accepts exact bounded actions and reuses session authority', () => {
    for (const body of [
      { ...base, action: 'read' },
      enqueue,
      { ...base, action: 'remove', expectedVersion: 1, messageId: 'message-1' },
      { ...base, action: 'reorder', expectedVersion: 1, messageIds: ['message-2', 'message-1'] },
      { ...base, action: 'deliver', expectedVersion: 1 },
    ] as const)
      expect(decodeFollowUpQueueRequest(body)).toEqual(body)
    const definition = devOperationDefinitions['dev.session.followUps']
    expect(definition.capabilities).toEqual(['dev.session.manage'])
    expect(definition.resource).toEqual({ kind: 'runtime_session', idField: 'runtimeSessionId' })
    const command = {
      schemaVersion: 1,
      operation: 'dev.session.followUps',
      requestId: '00000000-0000-4000-8000-000000000004',
      nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
      issuedAt: '2026-10-15T05:00:00.000Z',
      expiresAt: '2026-10-15T05:01:00.000Z',
      scope: {
        accountId: '00000000-0000-4000-8000-000000000001',
        workspaceId: '00000000-0000-4000-8000-000000000002',
        runtimeNodeId: '00000000-0000-4000-8000-000000000003',
      },
      capabilities: definition.capabilities,
      resource: { kind: 'runtime_session', id: 'session-1', generation: 2 },
      idempotencyKey: 'enqueue-1',
      body: enqueue,
    } as const
    expect(decodeDevCommand(command)).toEqual(command)
    expect(() =>
      decodeDevCommand({ ...command, resource: { ...command.resource, generation: 3 } })
    ).toThrow()
  })

  for (const body of [
    { ...enqueue, action: 'steer' },
    { ...enqueue, generation: 2 },
    { ...enqueue, expectedGeneration: -1 },
    { ...enqueue, expectedGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...enqueue, expectedVersion: -1 },
    { ...enqueue, text: '' },
    { ...enqueue, text: 'x'.repeat(16_385) },
    { ...enqueue, text: '\u0000' },
    { ...enqueue, messageId: '' },
    { ...base, action: 'enqueue', expectedVersion: 0 },
    { ...base, action: 'reorder', expectedVersion: 1, messageIds: ['same', 'same'] },
    {
      ...base,
      action: 'reorder',
      expectedVersion: 1,
      messageIds: Array.from({ length: 17 }, (_, i) => `id-${i}`),
    },
    { ...base, action: 'read', text: 'not a mutation' },
  ]) {
    test(`rejects malformed action ${JSON.stringify(body).slice(0, 100)}`, () =>
      expect(() => decodeFollowUpQueueRequest(body)).toThrow())
  }

  test('strictly validates snapshots without claiming delivery for pending/ambiguous items', () => {
    const snapshot = {
      schemaVersion: 1,
      runtimeSessionId: 'session-1',
      generation: 2,
      version: 1,
      delivery: 'unavailable',
      items: [{ id: 'message-1', text: 'follow up', bytes: 9, state: 'queued' }],
    } as const
    const decoded = decodeFollowUpQueueSnapshot(snapshot)
    expect(decoded).toEqual(snapshot)
    expect(Object.isFrozen(decoded.items)).toBe(true)
    const reply = decodeFollowUpQueueReply({
      schemaVersion: 1,
      operation: 'dev.session.followUps',
      requestId: '00000000-0000-4000-8000-000000000004',
      ok: true,
      value: snapshot,
      observedAt: '2026-10-15T05:00:00.000Z',
    })
    expect(reply.ok).toBe(true)
    if (reply.ok) {
      expect(reply.value).not.toBe(snapshot)
      expect(Object.isFrozen(reply.value)).toBe(true)
      expect(Object.isFrozen(reply.value.items)).toBe(true)
    }
    expect(() =>
      decodeFollowUpQueueReply({
        schemaVersion: 1,
        operation: 'dev.session.events',
        requestId: '00000000-0000-4000-8000-000000000004',
        ok: true,
        value: snapshot,
        observedAt: '2026-10-15T05:00:00.000Z',
      })
    ).toThrow('reply.operation: expected dev.session.followUps')
    expect(() =>
      decodeFollowUpQueueReply({
        schemaVersion: 1,
        operation: 'dev.session.followUps',
        requestId: '00000000-0000-4000-8000-000000000004',
        ok: true,
        value: { ...snapshot, items: [{ ...snapshot.items[0], bytes: 10 }] },
        observedAt: '2026-10-15T05:00:00.000Z',
      })
    ).toThrow()
    expect(() =>
      decodeFollowUpQueueSnapshot({ ...snapshot, items: [{ ...snapshot.items[0], bytes: 10 }] })
    ).toThrow()
    expect(() =>
      decodeFollowUpQueueSnapshot({
        ...snapshot,
        items: [{ ...snapshot.items[0], state: 'delivered' }],
      })
    ).toThrow()
    expect(() =>
      decodeFollowUpQueueSnapshot({ ...snapshot, items: [...snapshot.items, ...snapshot.items] })
    ).toThrow()
  })

  test('queue event payloads bind to the authoritative host and never contain queued text', () => {
    const event = {
      schemaVersion: 1,
      eventId: 'queue-event-1',
      runtimeSessionId: 'session-1',
      generation: 2,
      seq: '1',
      occurredAt: '2026-10-15T05:00:00.000Z',
      receivedAt: '2026-10-15T05:00:00.000Z',
      source: 'host',
      sourceEventId: 'queue-1',
      confidence: 'authoritative',
      classification: 'workspace_metadata',
      kind: 'queue.updated',
      payload: {
        schemaVersion: 1,
        runtimeSessionId: 'session-1',
        generation: 2,
        version: 1,
        change: 'enqueue',
        items: [{ id: 'message-1', bytes: 9, state: 'queued' }],
      },
    }
    expect(decodeRuntimeEvent(event, { source: 'host' }).payload).toEqual(event.payload)
    expect(() => decodeRuntimeEvent({ ...event, generation: 3 }, { source: 'host' })).toThrow()
    expect(() => decodeRuntimeEvent({ ...event, source: 'native' }, { source: 'native' })).toThrow()
    expect(() =>
      decodeRuntimeEvent(
        {
          ...event,
          payload: { ...event.payload, items: [{ ...event.payload.items[0], text: 'private' }] },
        },
        { source: 'host' }
      )
    ).toThrow()
  })
})
