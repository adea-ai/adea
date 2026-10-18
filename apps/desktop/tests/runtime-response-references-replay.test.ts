import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decodeCbor,
  decodeRuntimeEvent,
  encodeCbor,
  type RuntimeEvent,
} from '../../../packages/types/src/dev-runtime-wire'
import {
  createSessionEventLog,
  type SessionEventInput,
} from '../shell/src/dev-runtime/harness/events'

// Real durable log + canonical stream codec; no worker or harness is launched.
const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const create = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-refs1389-'))
  dirs.push(dataDir)
  return { dataDir, log: createSessionEventLog({ dataDir, scope }) }
}
// Each response is its own assistant message (#1386): a second final under one
// message identity is a lifecycle violation, so identity follows the source event.
const input = (overrides: Partial<SessionEventInput> = {}): SessionEventInput => ({
  runtimeSessionId: 'session-a',
  generation: 1,
  harnessRunId: 'run-a',
  source: 'acp',
  sourceEventId: 'response-a',
  kind: 'turn.assistant_message',
  classification: 'workspace_private',
  payload: {
    messageId: `message-${overrides.sourceEventId ?? 'response-a'}`,
    supersedes: 'deltas',
    text: 'The evidence supports this.',
    references: {
      schemaVersion: 1,
      sources: [
        { id: 'source-a', title: 'Evidence', url: 'https://example.com/', snippet: 'A fact.' },
      ],
      citations: [{ sourceId: 'source-a', start: 0, end: 26 }],
    },
  },
  ...overrides,
})

describe('response references through durable append and replay', () => {
  test('live, restarted and CBOR replay preserve exact response-local references and identity', () => {
    const { dataDir, log } = create()
    const live: RuntimeEvent[] = []
    log.subscribe('session-a', (event) => live.push(event))
    const appended = log.append(input())!
    expect(live).toEqual([appended])
    const reopened = createSessionEventLog({ dataDir, scope })
    const replay = reopened.read('session-a', { generation: 1, fromSequence: '1' })
    expect(replay).toEqual(live)
    expect(reopened.append(input())).toBeUndefined()
    const bytes = encodeCbor(replay[0])
    expect(bytes.byteLength).toBeLessThan(65_536)
    expect(decodeRuntimeEvent(decodeCbor(bytes).value, { source: 'acp' })).toEqual(appended)
  })

  test('rejects unsafe source bytes before persistence, sequencing, retention or live delivery', () => {
    const { dataDir } = create()
    const log = createSessionEventLog({ dataDir, scope, maxPerSession: 1 })
    log.append(input())
    const file = join(dataDir, 'dev-runtime/harness/session-events.json')
    const before = readFileSync(file, 'utf8')
    const seen: RuntimeEvent[] = []
    log.subscribe('session-a', (event) => seen.push(event))
    expect(() =>
      log.append(
        input({
          sourceEventId: 'bad',
          payload: {
            messageId: 'message-bad',
            supersedes: 'deltas',
            text: 'claim',
            references: {
              schemaVersion: 1,
              sources: [{ id: 'bad', title: 'Bad', url: 'javascript:alert(1)' }],
              citations: [],
            },
          },
        })
      )
    ).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(log.latestSequence('session-a', 1)).toBe('1')
    expect(seen).toEqual([])
    expect(log.append(input({ sourceEventId: 'next' }))!.seq).toBe('2')
  })

  test('a source from another message, run, generation, session or workspace cannot resolve a citation', () => {
    const { dataDir, log } = create()
    log.append(input())
    for (const overrides of [
      { sourceEventId: 'other-message' },
      { harnessRunId: 'other-run', sourceEventId: 'other-run' },
      { generation: 2 },
      { runtimeSessionId: 'other-session' },
    ])
      expect(() =>
        log.append(
          input({
            ...overrides,
            payload: {
              messageId: 'message-claim',
              supersedes: 'deltas',
              text: 'claim',
              references: {
                schemaVersion: 1,
                sources: [],
                citations: [{ sourceId: 'source-a', start: 0, end: 5 }],
              },
            },
          })
        )
      ).toThrow()
    const other = createSessionEventLog({
      dataDir,
      scope: { ...scope, workspaceId: 'other-workspace' },
    })
    expect(other.read('session-a')).toEqual([])
    expect(() =>
      other.append(
        input({
          payload: {
            messageId: 'message-claim',
            supersedes: 'deltas',
            text: 'claim',
            references: {
              schemaVersion: 1,
              sources: [],
              citations: [{ sourceId: 'source-a', start: 0, end: 5 }],
            },
          },
        })
      )
    ).toThrow()
  })

  test('keeps citations after a bounded replay window evicts earlier messages', () => {
    const { dataDir } = create()
    const log = createSessionEventLog({ dataDir, scope, maxPerSession: 1 })
    log.append(input())
    const retained = log.append(input({ sourceEventId: 'response-b' }))!
    expect(log.read('session-a')).toEqual([retained])
    expect(createSessionEventLog({ dataDir, scope }).read('session-a')).toEqual([retained])
  })

  test('changed source/citation content under one source event ID remains an idempotency conflict', () => {
    const { log } = create()
    const retained = log.append(input())!
    for (const [url, end] of [
      ['https://example.org/', 26],
      ['https://example.com/', 27],
    ] as const) {
      let error: unknown
      try {
        log.append(
          input({
            payload: {
              messageId: 'message-response-a',
              supersedes: 'deltas',
              text: 'The evidence supports this.',
              references: {
                schemaVersion: 1,
                sources: [{ id: 'source-a', title: 'Evidence', url, snippet: 'A fact.' }],
                citations: [{ sourceId: 'source-a', start: 0, end }],
              },
            },
          })
        )
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({ code: 'idempotency_conflict' })
    }
    expect(log.read('session-a')).toEqual([retained])
  })

  test('replay refuses tampered reference data without rewriting retained evidence', () => {
    const { dataDir, log } = create()
    log.append(input())
    const file = join(dataDir, 'dev-runtime/harness/session-events.json')
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    stored.records[0].payload.references.sources[0].url = 'file:///private'
    const tampered = JSON.stringify(stored)
    writeFileSync(file, tampered)
    const reopened = createSessionEventLog({ dataDir, scope })
    expect(() => reopened.read('session-a')).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(tampered)
  })

  test('preserves no-source finals and unrelated opaque records unchanged on replay', () => {
    const { dataDir, log } = create()
    const legacy = log.append(
      input({
        payload: { messageId: 'message-plain', supersedes: 'deltas', text: 'No producer sources.' },
      })
    )!
    const future = log.append(
      input({
        sourceEventId: 'future',
        // The canonical log refuses kinds outside the wire vocabulary; an
        // unrelated known kind must stay opaque to the reference contract.
        kind: 'run.completed',
        payload: { references: { future: true } },
      })
    )!
    const reopened = createSessionEventLog({ dataDir, scope })
    expect(reopened.read('session-a')).toEqual([legacy, future])
    expect(reopened.read('session-a')[0]!.payload).not.toHaveProperty('references')
  })
})
