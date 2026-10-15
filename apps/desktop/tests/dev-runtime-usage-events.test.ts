import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decodeRuntimeEvent } from '../../../packages/types/src/dev-runtime-wire'
import { createSessionEventLog } from '../shell/src/dev-runtime/harness/events'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

describe('usage producer admission', () => {
  test('rejects an accessor that would serialize a required context figure away', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-accessor-usage-'))
    try {
      const log = createSessionEventLog({ dataDir, scope })
      const received: unknown[] = []
      log.subscribe('session-1', (event) => received.push(event))
      let reads = 0
      const context = { total: null }
      Object.defineProperty(context, 'used', {
        enumerable: true,
        get: () => (++reads <= 2 ? null : undefined),
      })
      expect(() =>
        log.append({
          runtimeSessionId: 'session-1',
          generation: 1,
          kind: 'usage.observed',
          sourceEventId: 'accessor',
          payload: {
            schemaVersion: 1,
            model: { providerId: 'provider-a', modelId: 'model-a' },
            generation: 1,
            context,
          },
        })
      ).toThrow()
      expect(log.events()).toEqual([])
      expect(received).toEqual([])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('persists and delivers a detached immutable usage snapshot', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-snapshot-usage-'))
    try {
      const log = createSessionEventLog({ dataDir, scope })
      const payload = {
        schemaVersion: 1,
        model: { providerId: 'provider-a', modelId: 'model-a' },
        generation: 1,
        context: { used: 10, total: 100 },
      }
      const accepted = log.append({
        runtimeSessionId: 'session-1',
        generation: 1,
        kind: 'usage.observed',
        sourceEventId: 'snapshot',
        payload,
      })!
      payload.context.used = -1
      payload.model.modelId = 'changed-after-admission'
      expect(accepted.payload).toMatchObject({
        model: { modelId: 'model-a' },
        context: { used: 10, total: 100 },
      })
      expect(Object.isFrozen(accepted)).toBe(true)
      expect(Object.isFrozen(accepted.payload)).toBe(true)
      expect(createSessionEventLog({ dataDir, scope }).read('session-1')).toEqual([accepted])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('retains a pre-upgrade opaque usage generation and blocks replay without skipping its sequence', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-legacy-usage-'))
    try {
      const directory = join(dataDir, 'dev-runtime', 'harness')
      mkdirSync(directory, { recursive: true })
      const file = join(directory, 'session-events.json')
      const base = {
        schemaVersion: 1,
        eventId: 'event-1',
        runtimeSessionId: 'legacy-session',
        generation: 1,
        seq: '1',
        occurredAt: '2026-10-15T05:00:00.000Z',
        receivedAt: '2026-10-15T05:00:01.000Z',
        source: 'host',
        sourceEventId: 'source-1',
        confidence: 'authoritative',
        classification: 'workspace_metadata',
        kind: 'session.ready',
        payload: {},
        scope,
      }
      const records = [
        base,
        {
          ...base,
          eventId: 'event-2',
          sourceEventId: 'source-2',
          seq: '2',
          kind: 'usage.observed',
          payload: { tokens: 123 },
        },
        { ...base, eventId: 'event-3', sourceEventId: 'source-3', seq: '3', kind: 'run.completed' },
        { ...base, eventId: 'healthy-session', runtimeSessionId: 'healthy-session' },
      ]
      const original = JSON.stringify({ schemaVersion: 1, savedAt: base.receivedAt, records })
      writeFileSync(file, original, { mode: 0o600 })
      const log = createSessionEventLog({ dataDir, scope })
      for (const fromSequence of ['0', '2', '3', '999']) {
        expect(() => log.read('legacy-session', { generation: 1, fromSequence })).toThrow(
          'recovery'
        )
      }
      expect(() => log.latestSequence('legacy-session', 1)).toThrow('recovery')
      expect(() => log.events()).toThrow('recovery')
      expect(() =>
        log.append({
          runtimeSessionId: 'legacy-session',
          generation: 1,
          kind: 'run.ready',
          sourceEventId: 'new',
        })
      ).toThrow('recovery')
      expect(readFileSync(file, 'utf8')).toBe(original)
      expect(log.read('healthy-session', { generation: 1 })).toHaveLength(1)
      const resumed = log.append({
        runtimeSessionId: 'legacy-session',
        generation: 2,
        kind: 'run.resumed',
        sourceEventId: 'resumed',
      })!
      expect(resumed.seq).toBe('1')
      expect(log.read('legacy-session', { generation: 2 })).toEqual([resumed])
      expect(JSON.parse(readFileSync(file, 'utf8')).records.slice(0, 4)).toEqual(records)
      const restarted = createSessionEventLog({ dataDir, scope })
      expect(() => restarted.read('legacy-session', { generation: 1 })).toThrow('recovery')
      expect(restarted.read('legacy-session', { generation: 2 })).toEqual([resumed])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('rejects invalid usage before persistence, sequence allocation, or notification', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-usage-events-'))
    try {
      const log = createSessionEventLog({ dataDir, scope })
      const received: unknown[] = []
      log.subscribe('session-1', (event) => received.push(event))
      const input = {
        runtimeSessionId: 'session-1',
        generation: 1,
        sourceEventId: 'usage-1',
        kind: 'usage.observed',
      } as const
      const payload = {
        schemaVersion: 1,
        model: { providerId: 'provider-a', modelId: 'model-a' },
        generation: 1,
        context: { used: null, total: null },
      }
      for (const invalid of [
        {},
        { ...payload, generation: 2 },
        { ...payload, context: { used: -1, total: 100 } },
      ]) {
        expect(() => log.append({ ...input, payload: invalid })).toThrow()
        expect(log.latestSequence('session-1', 1)).toBe('0')
        expect(log.events()).toEqual([])
        expect(received).toEqual([])
      }
      expect(() => log.append({ ...input, payload, confidence: 'untrusted_hint' })).toThrow()
      const accepted = log.append({ ...input, payload })!
      expect(accepted.seq).toBe('1')
      expect(decodeRuntimeEvent(accepted, { source: 'host' }).payload).toEqual(payload)
      expect(received).toEqual([accepted])
      expect(createSessionEventLog({ dataDir, scope }).read('session-1')).toEqual([accepted])
      expect(log.append({ ...input, payload })).toBeUndefined()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
