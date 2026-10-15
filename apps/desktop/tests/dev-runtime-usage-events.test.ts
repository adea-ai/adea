import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
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
