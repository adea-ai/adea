import { describe, expect, test } from 'bun:test'

import {
  decodeRuntimeEvent,
  decodeCbor,
  encodeCbor,
  type RuntimeEvent,
} from '../src/dev-runtime-wire'

const delta = { messageId: 'message-1', deltaIndex: 0, text: 'Hello' }
const final = { messageId: 'message-1', text: 'Hello world', supersedes: 'deltas' }
const result = { messageId: 'message-1', summary: 'Done' }

function event(kind: RuntimeEvent['kind'], payload: unknown): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: 'event-1',
    runtimeSessionId: 'session-1',
    harnessRunId: 'run-1',
    generation: 1,
    seq: '1',
    occurredAt: '2026-10-15T00:00:00.000Z',
    receivedAt: '2026-10-15T00:00:00.000Z',
    source: 'acp',
    sourceEventId: 'source-1',
    confidence: 'authoritative',
    classification: 'workspace_private',
    kind,
    payload,
  }
}

const kinds = ['turn.assistant_delta', 'turn.assistant_message', 'turn.result'] as const
const payloads = [delta, final, result]

describe('assistant event identity contract', () => {
  test('all three kinds carry the same stable identity through CBOR replay', () => {
    for (const messageId of ['message-1', 'message-🚀']) {
      const decoded = kinds.map((kind, index) => {
        const input = {
          ...event(kind, { ...payloads[index], messageId }),
          eventId: `event-${index}`,
          sourceEventId: `source-${index}`,
          seq: String(index + 1),
        }
        return decodeRuntimeEvent(decodeCbor(encodeCbor(input)).value, { source: 'acp' })
      })
      expect(decoded.map((entry) => (entry.payload as { messageId: string }).messageId)).toEqual([
        messageId,
        messageId,
        messageId,
      ])
      expect(decoded[1]!.payload).toMatchObject({ supersedes: 'deltas' })
    }
  })

  test('refuses missing, blank, oversized and control-bearing message identities on every kind', () => {
    for (const kind of kinds) {
      for (const messageId of [
        undefined,
        '',
        ' ',
        'x'.repeat(257),
        'bad\nidentity',
        '\u0085',
        'bad id',
        '\ud800',
        '\udfff',
        42,
        null,
      ]) {
        const payload = { ...payloads[kinds.indexOf(kind)], messageId }
        expect(() => decodeRuntimeEvent(event(kind, payload), { source: 'acp' })).toThrow(
          'messageId'
        )
      }
    }
  })

  test('requires a run binding and explicit final supersession', () => {
    for (const kind of kinds) {
      expect(() =>
        decodeRuntimeEvent(
          { ...event(kind, payloads[kinds.indexOf(kind)]), harnessRunId: undefined },
          { source: 'acp' }
        )
      ).toThrow('harnessRunId')
    }
    for (const supersedes of [undefined, false, [], 'messages', 'message-2']) {
      expect(() =>
        decodeRuntimeEvent(event('turn.assistant_message', { ...final, supersedes }), {
          source: 'acp',
        })
      ).toThrow('supersedes')
    }
  })

  test('validates delta order fields and self-contained final text', () => {
    for (const deltaIndex of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0', undefined]) {
      expect(() =>
        decodeRuntimeEvent(event('turn.assistant_delta', { ...delta, deltaIndex }), {
          source: 'acp',
        })
      ).toThrow('deltaIndex')
    }
    for (const text of [undefined, 42, null]) {
      for (const kind of ['turn.assistant_delta', 'turn.assistant_message'] as const) {
        expect(() =>
          decodeRuntimeEvent(
            event(kind, { ...(kind === 'turn.assistant_delta' ? delta : final), text }),
            { source: 'acp' }
          )
        ).toThrow('text')
      }
    }
    expect(() =>
      decodeRuntimeEvent(event('turn.result', { ...result, summary: 42 }), { source: 'acp' })
    ).toThrow('summary')
  })

  test('refuses ill-formed Unicode strings in text a UTF-8 stream replay would rewrite', () => {
    for (const invalid of ['\ud800', '\udc00', 'a\ud800b', 'a\udc00b']) {
      for (const [kind, payload] of [
        ['turn.assistant_delta', { ...delta, text: invalid }],
        ['turn.assistant_message', { ...final, text: invalid }],
        ['turn.result', { ...result, summary: invalid }],
      ] as const)
        expect(() => decodeRuntimeEvent(event(kind, payload), { source: 'acp' })).toThrow(
          'ill-formed Unicode string'
        )
    }
    const paired = { ...final, text: 'rocket 🚀 ok' }
    expect(
      decodeRuntimeEvent(event('turn.assistant_message', paired), { source: 'acp' }).payload
    ).toEqual(paired)
  })

  test('event sequences stay canonical within the uint64 boundary', () => {
    const input = event('turn.assistant_delta', delta)
    expect(
      decodeRuntimeEvent({ ...input, seq: '18446744073709551615' }, { source: 'acp' }).seq
    ).toBe('18446744073709551615')
    for (const seq of ['01', '-1', '1.0', '18446744073709551616']) {
      expect(() => decodeRuntimeEvent({ ...input, seq }, { source: 'acp' })).toThrow('uint64')
    }
  })

  test('identity never promotes terminal fallback into authoritative or result events', () => {
    const input = {
      ...event('turn.assistant_delta', delta),
      source: 'terminal_fallback',
      confidence: 'bounded_projection',
    }
    expect(decodeRuntimeEvent(input, { source: 'terminal_fallback' }).payload).toEqual(delta)
    expect(() =>
      decodeRuntimeEvent({ ...input, confidence: 'authoritative' }, { source: 'terminal_fallback' })
    ).toThrow('authoritative')
    expect(() =>
      decodeRuntimeEvent(
        { ...input, kind: 'turn.result', payload: result },
        { source: 'terminal_fallback' }
      )
    ).toThrow('event kind')
  })
})

const wire = (id: string) => new TextDecoder().decode(new TextEncoder().encode(id))

describe('envelope identifiers are well-formed Unicode', () => {
  const lone = ['\ud800', '\udc00', 'a\ud83d', '\ude80b']
  for (const key of ['eventId', 'runtimeSessionId', 'sourceEventId', 'harnessRunId'] as const)
    test(`${key} rejects ill-formed Unicode strings and keeps valid scalars`, () => {
      for (const bad of lone)
        expect(() =>
          decodeRuntimeEvent(
            { ...event('turn.assistant_delta', delta), [key]: bad },
            { source: 'acp' }
          )
        ).toThrow('ill-formed Unicode string')
      const good = {
        ...event('turn.assistant_delta', delta),
        [key]: 'id-🚀-é',
      }
      expect(decodeRuntimeEvent(good, { source: 'acp' })).toEqual(good)
      expect(decodeCbor(encodeCbor(good)).value).toEqual(good)
    })

  test('distinct lone-surrogate run ids cannot collapse to one wire identity', () => {
    expect(wire('r\ud800')).toBe(wire('r\ud801'))
    for (const id of ['r\ud800', 'r\ud801'])
      expect(() =>
        decodeRuntimeEvent({ ...event('turn.result', result), harnessRunId: id }, { source: 'acp' })
      ).toThrow('ill-formed Unicode string')
  })
})
