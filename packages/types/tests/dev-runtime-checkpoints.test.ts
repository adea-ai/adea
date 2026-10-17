import { describe, expect, test } from 'bun:test'
import { decodeRuntimeEvent, devOperationDecoders } from '../src/dev-runtime'
import {
  decodeConversationCheckpoint,
  decodeCheckpointRestoreOutcome,
} from '../src/dev-runtime-checkpoints'

const checkpoint = {
  schemaVersion: 1,
  checkpointId: 'checkpoint-1',
  name: 'Before refactor',
  createdAt: '2026-10-15T05:00:00Z',
  harnessInstallationId: 'installation-1',
  restore: { supported: false, reason: 'harness_restore_unavailable' },
} as const
const outcome = {
  schemaVersion: 1,
  restoreId: 'restore-1',
  checkpointId: 'checkpoint-1',
  checkpointEventId: 'event-1',
  requestedGeneration: 1,
  status: 'resolved',
  restoredGeneration: 2,
  completedAt: '2026-10-15T05:01:00Z',
  providerRestoreId: 'proof-1',
  restoredAt: '2026-10-15T05:01:00Z',
} as const

describe('conversation checkpoints', () => {
  test('requires named timestamped evidence and truthful restore capability', () => {
    expect(decodeConversationCheckpoint(checkpoint)).toEqual(checkpoint)
    expect(
      decodeConversationCheckpoint({ ...checkpoint, restore: { supported: true } })
    ).toBeDefined()
    for (const invalid of [
      { ...checkpoint, name: '' },
      { ...checkpoint, name: '   ' },
      { ...checkpoint, createdAt: '2026-02-30T00:00:00Z' },
      { ...checkpoint, schemaVersion: 2 },
      { ...checkpoint, restore: { supported: false } },
      { ...checkpoint, restore: { supported: true, reason: 'harness_restore_unavailable' } },
      { ...checkpoint, authority: 'caller' },
    ])
      expect(() => decodeConversationCheckpoint(invalid)).toThrow()
  })

  test('requires correlated, explicit resolved/failed outcomes without fictional success', () => {
    expect(decodeCheckpointRestoreOutcome(outcome)).toEqual(outcome)
    const { restoredGeneration: _, providerRestoreId: _proof, restoredAt: _at, ...base } = outcome
    expect(
      decodeCheckpointRestoreOutcome({ ...base, status: 'failed', code: 'capability_unavailable' })
    ).toBeDefined()
    for (const invalid of [
      { ...outcome, restoredGeneration: 1 },
      { ...outcome, checkpointEventId: '' },
      { ...outcome, status: 'failed', code: 'capability_unavailable' },
      { ...base, status: 'failed', code: 'invented' },
    ])
      expect(() => decodeCheckpointRestoreOutcome(invalid)).toThrow()
  })

  test('restored generation remains a safe integer exactly one above a valid request', () => {
    for (const requestedGeneration of [0, 1, Number.MAX_SAFE_INTEGER - 1]) {
      const next = requestedGeneration + 1
      expect(
        decodeCheckpointRestoreOutcome({
          ...outcome,
          requestedGeneration,
          restoredGeneration: next,
        })
      ).toMatchObject({ restoredGeneration: next })
      for (const restoredGeneration of [
        -1,
        0,
        0.5,
        next + 0.5,
        NaN,
        Infinity,
        -Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        String(next),
        null,
        {},
        [],
        true,
      ])
        if (restoredGeneration !== next)
          expect(() =>
            decodeCheckpointRestoreOutcome({ ...outcome, requestedGeneration, restoredGeneration })
          ).toThrow()
    }
    for (const requestedGeneration of [
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      '1',
      null,
    ])
      expect(() => decodeCheckpointRestoreOutcome({ ...outcome, requestedGeneration })).toThrow()
  })

  test('pins the strict restore command with required generation and no authority fields', () => {
    const body = {
      runtimeSessionId: 'session-1',
      expectedGeneration: 1,
      checkpointEventId: 'event-1',
    }
    expect(devOperationDecoders['dev.session.restoreCheckpoint'].request(body)).toEqual(body)
    const reply = {
      schemaVersion: 1,
      operation: 'dev.session.restoreCheckpoint',
      requestId: '00000000-0000-4000-8000-000000000004',
      ok: true,
      observedAt: '2026-10-15T05:01:00Z',
      value: outcome,
    }
    expect(devOperationDecoders['dev.session.restoreCheckpoint'].reply(reply)).toEqual(reply)
    for (const invalid of [
      { ...body, authorized: true },
      { ...body, expectedGeneration: undefined },
      { ...body, checkpointEventId: '' },
    ])
      expect(() => devOperationDecoders['dev.session.restoreCheckpoint'].request(invalid)).toThrow()
  })

  test('the canonical wire requires authoritative private generation/run-bound checkpoint evidence', () => {
    const event = {
      schemaVersion: 1,
      eventId: 'event-1',
      runtimeSessionId: 'session-1',
      harnessRunId: 'run-1',
      generation: 1,
      seq: '1',
      occurredAt: checkpoint.createdAt,
      receivedAt: checkpoint.createdAt,
      source: 'native',
      sourceEventId: 'native-1',
      confidence: 'authoritative',
      classification: 'workspace_private',
      kind: 'checkpoint.observed',
      payload: checkpoint,
    } as const
    expect(decodeRuntimeEvent(event, { source: 'native' })).toEqual(event)
    expect(
      decodeRuntimeEvent({ ...event, payload: { text: 'Legacy marker' } }, { source: 'native' })
    ).toBeDefined()
    for (const invalid of [
      { ...event, confidence: 'untrusted_hint' },
      { ...event, classification: 'public' },
      { ...event, harnessRunId: undefined },
      { ...event, payload: { restore: { supported: true } } },
    ])
      expect(() => decodeRuntimeEvent(invalid, { source: 'native' })).toThrow()
    expect(
      decodeRuntimeEvent(
        { ...event, source: 'host', kind: 'checkpoint.restore_resolved', payload: outcome },
        { source: 'host' }
      )
    ).toBeDefined()
    expect(() =>
      decodeRuntimeEvent(
        { ...event, source: 'host', kind: 'checkpoint.restore_failed', payload: outcome },
        { source: 'host' }
      )
    ).toThrow()
    expect(() =>
      decodeRuntimeEvent(
        { ...event, kind: 'checkpoint.restore_resolved', payload: outcome },
        { source: 'native' }
      )
    ).toThrow()
    expect(() =>
      decodeRuntimeEvent(
        {
          ...event,
          source: 'host',
          generation: 2,
          kind: 'checkpoint.restore_resolved',
          payload: outcome,
        },
        { source: 'host' }
      )
    ).toThrow()
  })
})
