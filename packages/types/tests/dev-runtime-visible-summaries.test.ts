import { describe, expect, test } from 'bun:test'
import { decodeRuntimeEvent, type RuntimeEvent } from '../src/dev-runtime-wire'
import {
  decodeRuntimeVisibleSummary,
  type RuntimeVisibleSummaryKind,
} from '../src/dev-runtime-visible-summaries'
import * as runtime from '../src/dev-runtime'

const summary = () => ({
  schemaVersion: 1,
  provenance: 'source_reported',
  visibility: 'user_visible',
  format: 'snapshot',
  summaryId: 'summary-1',
  revision: 0,
  text: 'Checked the published evidence.',
  status: 'streaming',
})
const step = () => ({
  schemaVersion: 1,
  provenance: 'source_reported',
  visibility: 'user_visible',
  format: 'snapshot',
  methodId: 'method-1',
  stepId: 'step-1',
  position: 0,
  revision: 0,
  title: 'Check sources',
  text: 'Compared the published versions.',
  status: 'running',
})
const event = (
  kind: string,
  payload: unknown,
  overrides: Partial<RuntimeEvent> = {}
): RuntimeEvent => ({
  schemaVersion: 1,
  eventId: 'event-1',
  runtimeSessionId: 'session-1',
  harnessRunId: 'run-1',
  generation: 1,
  seq: '1',
  occurredAt: '2026-10-15T05:00:00.000Z',
  receivedAt: '2026-10-15T05:00:01.000Z',
  source: 'acp',
  sourceEventId: 'source-1',
  confidence: 'authoritative',
  classification: 'workspace_private',
  kind: kind as RuntimeEvent['kind'],
  payload,
  ...overrides,
})
const decode = (kind: string, payload: unknown) =>
  decodeRuntimeEvent(event(kind, payload), { source: 'acp' })

describe('user-visible summary wire contracts', () => {
  test('exports its isolated decoder and refuses unknown direct decoder kinds', () => {
    expect(runtime.decodeRuntimeVisibleSummary).toBe(decodeRuntimeVisibleSummary)
    expect(() =>
      decodeRuntimeVisibleSummary('future.summary' as RuntimeVisibleSummaryKind, step())
    ).toThrow()
  })

  test('preserves exact Unicode and accepts numeric boundary values', () => {
    const payload = {
      ...summary(),
      text: 'A 🌍 — public summary',
      revision: 2 ** 31 - 1,
      durationMs: 86_400_000,
    }
    expect(decode('turn.reasoning_summary', payload).payload).toEqual(payload)
    expect(decode('turn.method_step_summary', { ...step(), position: 127 }).payload).toHaveProperty(
      'position',
      127
    )
  })
  test.each([
    ['turn.reasoning_summary', summary],
    ['turn.method_step_summary', step],
  ] as const)('accepts a source-reported visible snapshot: %s', (kind, make) => {
    const payload = make()
    expect(decode(kind, payload).payload).toEqual(payload)
    expect(decode(kind, { ...payload, status: 'completed', durationMs: 0 }).payload).toEqual({
      ...payload,
      status: 'completed',
      durationMs: 0,
    })
    expect(payload).not.toHaveProperty('durationMs')
  })

  test('keeps the two shapes separate', () => {
    expect(() => decode('turn.reasoning_summary', step())).toThrow()
    expect(() => decode('turn.method_step_summary', summary())).toThrow()
  })

  test.each([
    ['turn.reasoning_summary', summary],
    ['turn.method_step_summary', step],
  ] as const)(
    'refuses hidden, inferred, unversioned and raw reasoning fields: %s',
    (kind, make) => {
      for (const payload of [
        { ...make(), visibility: 'hidden' },
        { ...make(), provenance: 'inferred' },
        { ...make(), schemaVersion: 2 },
        { ...make(), format: 'delta' },
        { ...make(), chainOfThought: 'private analysis' },
        { ...make(), analysis: 'private analysis' },
        { ...make(), rawReasoning: 'private analysis' },
        { text: 'Unmarked private analysis' },
        null,
      ])
        expect(() => decode(kind, payload)).toThrow()
    }
  )

  test('binds known summaries to a real run and supported structured provenance', () => {
    for (const overrides of [
      { confidence: 'untrusted_hint' as const },
      { classification: 'credential' as const },
      { classification: 'workspace_metadata' as const },
    ]) {
      expect(() =>
        decodeRuntimeEvent(event('turn.reasoning_summary', summary(), overrides), { source: 'acp' })
      ).toThrow()
    }
    expect(() =>
      decodeRuntimeEvent(event('turn.reasoning_summary', summary(), { harnessRunId: undefined }), {
        source: 'acp',
      })
    ).toThrow()
    for (const source of ['host', 'terminal_fallback'] as const) {
      expect(() =>
        decodeRuntimeEvent(
          event('turn.reasoning_summary', summary(), { source, confidence: 'bounded_projection' }),
          { source }
        )
      ).toThrow()
    }
    expect(() =>
      decodeRuntimeEvent(event('turn.reasoning_summary', summary()), { source: 'native' })
    ).toThrow()
  })

  test('requires explicit statuses; unknown stays unknown and timing stays absent', () => {
    for (const status of ['streaming', 'completed', 'failed', 'cancelled', 'unknown'])
      expect(decode('turn.reasoning_summary', { ...summary(), status }).payload).toEqual({
        ...summary(),
        status,
      })
    for (const status of ['pending', 'running', 'completed', 'failed', 'cancelled', 'unknown'])
      expect(decode('turn.method_step_summary', { ...step(), status }).payload).toEqual({
        ...step(),
        status,
      })
    expect(() => decode('turn.reasoning_summary', { ...summary(), status: 'thinking' })).toThrow()
    expect(() => decode('turn.method_step_summary', { ...step(), status: 'streaming' })).toThrow()
  })

  test('bounds revision, timing, ordinal, fields and UTF-8 payload', () => {
    for (const revision of [-1, 0.5, 2 ** 31, NaN])
      expect(() => decode('turn.reasoning_summary', { ...summary(), revision })).toThrow()
    for (const durationMs of [-1, 0.5, 86_400_001, Infinity, '12'])
      expect(() => decode('turn.reasoning_summary', { ...summary(), durationMs })).toThrow()
    for (const position of [-1, 128, 0.5])
      expect(() => decode('turn.method_step_summary', { ...step(), position })).toThrow()
    expect(() =>
      decode('turn.reasoning_summary', { ...summary(), text: 'x'.repeat(4097) })
    ).toThrow()
    expect(() =>
      decode('turn.method_step_summary', { ...step(), title: 'x'.repeat(513) })
    ).toThrow()
    expect(() =>
      decode('turn.method_step_summary', { ...step(), text: '\u0000'.repeat(4096) })
    ).toThrow()
    expect(() => decode('turn.reasoning_summary', { ...summary(), text: '\ud800' })).toThrow()
    expect(() =>
      decode('turn.reasoning_summary', { ...summary(), summaryId: 'x'.repeat(129) })
    ).toThrow()
    expect(() =>
      decode('turn.method_step_summary', { ...step(), status: 'pending', durationMs: 1 })
    ).toThrow()
  })

  test('leaves unknown-summary-like ordinary payloads opaque', () => {
    for (const payload of [{ text: 'Answer only.' }, { reasoning: 'opaque legacy data' }, {}]) {
      expect(decode('tool.progress', payload).payload).toEqual(payload)
      expect(decode('turn.user_input', payload).payload).toEqual(payload)
    }
    const message = { messageId: 'message-1', text: 'Answer only.', supersedes: 'deltas' }
    expect(decode('turn.assistant_message', message).payload).toEqual(message)
    expect(decode('turn.result', { messageId: 'message-1' }).payload).toEqual({
      messageId: 'message-1',
    })
  })
})
