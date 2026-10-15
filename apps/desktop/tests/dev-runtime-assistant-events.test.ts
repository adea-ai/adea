import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decodeRuntimeEvent, type Scope } from '../../../packages/types/src/dev-runtime'
import {
  createSessionEventLog,
  type SessionEventInput,
} from '../shell/src/dev-runtime/harness/events'

const scope: Scope = { accountId: 'account-1', workspaceId: 'workspace-1', runtimeNodeId: 'node-1' }
function input(overrides: Partial<SessionEventInput> = {}): SessionEventInput {
  return {
    runtimeSessionId: 'session-1',
    harnessRunId: 'run-1',
    generation: 1,
    source: 'acp',
    confidence: 'authoritative',
    classification: 'workspace_private',
    sourceEventId: 'delta-0',
    kind: 'turn.assistant_delta',
    payload: { messageId: 'message-1', deltaIndex: 0, text: 'Hello' },
    ...overrides,
  }
}
const final = input({
  kind: 'turn.assistant_message',
  sourceEventId: 'final',
  payload: { messageId: 'message-1', text: 'Hello world', supersedes: 'deltas' },
})
const result = input({
  kind: 'turn.result',
  sourceEventId: 'result',
  payload: { messageId: 'message-1', summary: 'Done' },
})

function withLog(run: (log: ReturnType<typeof createSessionEventLog>, dataDir: string) => void) {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-assistant-events-'))
  try {
    run(createSessionEventLog({ dataDir, scope }), dataDir)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

describe('canonical assistant event append', () => {
  test('refuses malformed events before persistence or publication', () =>
    withLog((log) => {
      const published: unknown[] = []
      log.subscribe('session-1', (event) => published.push(event))
      expect(() => log.append(input({ payload: { text: 'unbound' } }))).toThrow()
      expect(log.events()).toHaveLength(0)
      expect(published).toHaveLength(0)
      expect(log.latestSequence('session-1', 1)).toBe('0')
    }))

  test('orders interleaved messages and preserves identities on restart and inclusive replay', () =>
    withLog((log, dataDir) => {
      const first = log.append(input())!
      log.append(
        input({
          sourceEventId: 'other-0',
          payload: { messageId: 'message-2', deltaIndex: 0, text: 'Other' },
        })
      )
      log.append(
        input({
          sourceEventId: 'delta-1',
          payload: { messageId: 'message-1', deltaIndex: 1, text: ' world' },
        })
      )
      const settled = log.append(final)!
      log.append(result)
      const reopened = createSessionEventLog({ dataDir, scope })
      expect(reopened.read('session-1')).toEqual(log.events())
      const replay = reopened.read('session-1', { fromSequence: settled.seq, generation: 1 })
      expect(replay.map((event) => event.kind)).toEqual(['turn.assistant_message', 'turn.result'])
      expect(replay[0]!.payload).toEqual(final.payload)
      expect(replay[0]!.eventId).toBe(settled.eventId)
      expect((replay[0]!.payload as { messageId: string }).messageId).toBe(
        (first.payload as { messageId: string }).messageId
      )
      replay.forEach((event) => expect(decodeRuntimeEvent(event, { source: 'acp' })).toEqual(event))
      expect(reopened.append(final)).toBeUndefined()
      expect(reopened.events()).toHaveLength(5)
    }))

  test('rejects delta gaps, conflicting indexes and late text without consuming a sequence', () =>
    withLog((log) => {
      expect(() =>
        log.append(
          input({
            sourceEventId: 'gap',
            payload: { messageId: 'message-1', deltaIndex: 1, text: 'late' },
          })
        )
      ).toThrow()
      log.append(input())
      expect(() => log.append(input({ sourceEventId: 'reuse' }))).toThrow()
      log.append(final)
      expect(() =>
        log.append(
          input({
            sourceEventId: 'late',
            payload: { messageId: 'message-1', deltaIndex: 1, text: 'late' },
          })
        )
      ).toThrow()
      expect(() => log.append({ ...final, sourceEventId: 'second-final' })).toThrow()
      log.append(result)
      expect(() => log.append({ ...result, sourceEventId: 'second-result' })).toThrow()
      expect(log.events().map((event) => event.seq)).toEqual(['1', '2', '3'])
    }))

  test('canonical retry is a no-op but run and provenance changes are conflicts', () =>
    withLog((log) => {
      log.append(input())
      expect(
        log.append(input({ payload: { text: 'Hello', deltaIndex: 0, messageId: 'message-1' } }))
      ).toBeUndefined()
      for (const change of [
        { harnessRunId: 'run-other' },
        { confidence: 'bounded_projection' as const },
        { classification: 'public' as const },
        { payload: { messageId: 'message-1', deltaIndex: 0, text: 'changed' } },
      ]) {
        expect(() => log.append(input(change))).toThrow()
      }
      expect(log.events()).toHaveLength(1)
    }))

  test('message identities cannot supersede another run, generation, source or session', () =>
    withLog((log) => {
      log.append(input())
      for (const [index, change] of [
        { harnessRunId: 'run-2' },
        { generation: 2 },
        { source: 'native' as const },
        { runtimeSessionId: 'session-2' },
      ].entries()) {
        log.append({ ...final, ...change, sourceEventId: `other-final-${index}` })
      }
      expect(
        log.append(
          input({
            sourceEventId: 'delta-1',
            payload: { messageId: 'message-1', deltaIndex: 1, text: ' world' },
          })
        )
      ).toBeDefined()
      expect(log.events()).toHaveLength(6)
    }))

  test('a result can reference a message without fabricating a final and closes further text', () =>
    withLog((log) => {
      log.append(result)
      expect(log.events()[0]!.kind).toBe('turn.result')
      expect(() => log.append(final)).toThrow()
      expect(() => log.append(input())).toThrow()
    }))

  test('a retained final remains self-contained and fences late deltas after retention and restart', () =>
    withLog((_, dataDir) => {
      const log = createSessionEventLog({ dataDir, scope, maxPerSession: 2 })
      log.append(input())
      log.append(final)
      log.append(result)
      const reopened = createSessionEventLog({ dataDir, scope, maxPerSession: 2 })
      expect(reopened.read('session-1').map((event) => event.kind)).toEqual([
        'turn.assistant_message',
        'turn.result',
      ])
      expect(() => reopened.append(input({ sourceEventId: 'late' }))).toThrow()
    }))
})

describe('assistant append idempotency edges', () => {
  test('opaque source/session IDs cannot collide through tuple delimiters', () =>
    withLog((log) => {
      const first = input({
        runtimeSessionId: 'session-a',
        sourceEventId: 'source\u00001\u0000acp\u0000tail',
      })
      const second = input({
        runtimeSessionId: 'session-a\u00001\u0000acp\u0000source',
        sourceEventId: 'tail',
      })
      expect(log.append(first)).toBeDefined()
      expect(log.append(second)).toBeDefined()
      expect(log.events()).toHaveLength(2)
    }))

  test('a retry at uint64 exhaustion remains idempotent while new appends fail closed', () =>
    withLog((log, dataDir) => {
      log.append(input())
      const path = join(dataDir, 'dev-runtime', 'harness', 'session-events.json')
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      saved.records[0].seq = '18446744073709551615'
      writeFileSync(path, JSON.stringify(saved))
      const reopened = createSessionEventLog({ dataDir, scope })
      expect(reopened.append(input())).toBeUndefined()
      expect(() => reopened.append(final)).toThrow()
      expect(reopened.events()).toHaveLength(1)
      expect(reopened.latestSequence('session-1', 1)).toBe('18446744073709551615')
    }))
})
