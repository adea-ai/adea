import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSessionEventLog } from '../shell/src/dev-runtime/harness/events'
import { transcriptPromptText } from '../shell/src/dev-runtime/harness/transcript-content'

const scope = { accountId: 'account-a', workspaceId: 'workspace-a', runtimeNodeId: 'node-a' }
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
function fixture(maxPerSession = 20) {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-history-'))
  dirs.push(dataDir)
  const log = createSessionEventLog({ dataDir, scope, maxPerSession })
  const append = (n: number, runtimeSessionId = 'session-a', generation = 1) => {
    for (let i = 0; i < n; i++)
      log.append({
        runtimeSessionId,
        generation,
        sourceEventId: `event-${generation}-${i}-${log.latestSequence(runtimeSessionId, generation)}`,
        kind: 'turn.user_input',
        payload: { text: `prompt ${i}` },
      })
  }
  return { log, append, dataDir }
}

describe('authorized transcript history storage', () => {
  test('byte budgets shorten pages without skipping events, and oversized single payloads are explicit', () => {
    const { log } = fixture()
    for (let n = 1; n <= 4; n++)
      log.append({
        runtimeSessionId: 'session-a',
        generation: 1,
        sourceEventId: `large-${n}`,
        kind: 'turn.assistant_message',
        payload: { parts: Array.from({ length: 10 }, () => 'x'.repeat(10_000)) },
      })
    const first = log.history('session-a', { generation: 1, limit: 500 })
    expect(first.items.map((e) => e.seq)).toEqual(['4'])
    const next = log.history('session-a', { generation: 1, cursor: first.nextCursor })
    expect(next.items.map((e) => e.seq)).toEqual(['3'])
    log.append({
      runtimeSessionId: 'session-a',
      generation: 1,
      sourceEventId: 'oversized',
      kind: 'turn.assistant_message',
      payload: { parts: Array.from({ length: 24 }, () => 'y'.repeat(10_000)) },
    })
    const oversized = log.history('session-a', { generation: 1, limit: 1 })
    expect(oversized.items[0]!.payload).toEqual({ omitted: 'history_payload_limit' })
    expect(oversized.items[0]!.seq).toBe('5')
  })

  test('an unexplained missing event is refused instead of turning into a pagination boundary', () => {
    const { log, append, dataDir } = fixture()
    append(6)
    const file = join(dataDir, 'dev-runtime', 'harness', 'session-events.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.records = saved.records.filter((e: { seq: string }) => e.seq !== '4')
    writeFileSync(file, JSON.stringify(saved))
    try {
      log.history('session-a', { generation: 1, beforeSequence: '5' })
      throw new Error('expected refusal')
    } catch (error) {
      expect((error as { code: string }).code).toBe('resync_required')
    }
  })

  test('prompt projection preserves whitespace, filters before truncation, and respects UTF-8 boundaries', () => {
    expect(transcriptPromptText('hello\n\tworld\u0000')).toEqual({
      text: 'hello\n\tworld',
      textTruncated: false,
    })
    const large = transcriptPromptText('😀'.repeat(5000))
    expect(new TextEncoder().encode(large.text).byteLength).toBe(16_384)
    expect(large.text.endsWith('😀')).toBe(true)
    expect(large.textTruncated).toBe(true)
    const secret = transcriptPromptText(`${'x'.repeat(16_375)} Bearer abcdefghijklmnopqrstuvwxyz`)
    expect(secret.text).not.toContain('abcdefgh')
    expect(transcriptPromptText('-----BEGIN PRIVATE KEY-----\nsecret material')).toEqual({
      text: '[secret redacted]',
      textTruncated: false,
    })
    expect(transcriptPromptText(`https://${'u'.repeat(3000)}:password@example.com`)).toEqual({
      text: 'https://[secret redacted]@example.com',
      textTruncated: false,
    })
  })
  test('walks backward in bounded pages, returns ascending events, and replays across restart', () => {
    const { log, append, dataDir } = fixture()
    append(9)
    const first = log.history('session-a', { generation: 1, beforeSequence: '8', limit: 3 })
    expect(first.items.map((e) => e.seq)).toEqual(['5', '6', '7'])
    expect(first.historyStart).toBe('generation_start')
    append(2)
    const restarted = createSessionEventLog({ dataDir, scope })
    const second = restarted.history('session-a', { generation: 1, cursor: first.nextCursor })
    expect(second.items.map((e) => e.seq)).toEqual(['2', '3', '4'])
    expect(restarted.history('session-a', { generation: 1, cursor: first.nextCursor })).toEqual(
      second
    )
    const last = log.history('session-a', { generation: 1, cursor: second.nextCursor })
    expect(last.items.map((e) => e.seq)).toEqual(['1'])
    expect(last.nextCursor).toBeUndefined()
  })

  test('rejects tampered, malformed, foreign scope/session/generation and changed-query cursors', () => {
    const { log, append, dataDir } = fixture()
    append(6)
    append(3, 'session-b')
    append(3, 'session-a', 2)
    const cursor = log.history('session-a', { generation: 1, limit: 2 }).nextCursor!
    for (const bad of ['garbage', `${cursor}x`, `${cursor.slice(0, 8)}x${cursor.slice(9)}`])
      expect(() => log.history('session-a', { generation: 1, cursor: bad })).toThrow()
    expect(() => log.history('session-b', { generation: 1, cursor })).toThrow()
    expect(() => log.history('session-a', { generation: 2, cursor })).toThrow()
    expect(() => log.history('session-a', { generation: 1, cursor, limit: 3 })).toThrow()
    expect(() => log.history('session-a', { generation: 1, cursor, beforeSequence: '5' })).toThrow()
    for (const foreign of [
      { ...scope, accountId: 'account-b' },
      { ...scope, workspaceId: 'workspace-b' },
      { ...scope, runtimeNodeId: 'node-b' },
    ]) {
      const other = createSessionEventLog({ dataDir, scope: foreign })
      expect(other.history('session-a', { generation: 1 }).items).toEqual([])
      expect(() => other.history('session-a', { generation: 1, cursor })).toThrow()
    }
  })

  test('names retention boundaries and refuses a cursor after its retained floor is pruned', () => {
    const { log, append } = fixture(5)
    append(8)
    const page = log.history('session-a', { generation: 1, limit: 2 })
    expect(page.retainedFromSequence).toBe('4')
    expect(page.historyStart).toBe('retention_boundary')
    append(1)
    expect(() => log.history('session-a', { generation: 1, cursor: page.nextCursor })).toThrow()
    const exhausted = log.history('session-a', { generation: 1, beforeSequence: '5' })
    expect(exhausted.items).toEqual([])
    expect(exhausted.nextCursor).toBeUndefined()
    expect(log.history('missing', { generation: 1 }).historyStart).toBe('unavailable')
  })

  test('filters credentials/private paths, omits restricted payloads and bounds encoded pages', () => {
    const { log } = fixture()
    log.append({
      runtimeSessionId: 'session-a',
      generation: 1,
      sourceEventId: 'private',
      kind: 'turn.user_input',
      payload: {
        text: 'hello Bearer abc.def token-abcdefghijk /Users/alice/private password=hunter2\nnext',
      },
    })
    log.append({
      runtimeSessionId: 'session-a',
      generation: 1,
      sourceEventId: 'credential',
      kind: 'turn.user_input',
      classification: 'credential',
      payload: { text: 'invisible credential' },
    })
    log.append({
      runtimeSessionId: 'session-a',
      generation: 1,
      sourceEventId: 'restricted',
      kind: 'turn.user_input',
      classification: 'restricted_local',
      payload: { text: 'invisible restricted' },
    })
    const page = log.history('session-a', { generation: 1 })
    const json = JSON.stringify(page)
    for (const secret of ['abc.def', 'token-abcdefghijk', '/Users/alice', 'hunter2', 'invisible'])
      expect(json).not.toContain(secret)
    expect((page.items[0]!.payload as { text: string }).text).toContain('\nnext')
    expect(page.items.slice(1).map((e) => e.payload)).toEqual([{}, {}])
    log.append({
      runtimeSessionId: 'session-a',
      generation: 1,
      sourceEventId: 'large',
      kind: 'turn.assistant_message',
      payload: { text: 'a'.repeat(250_000) },
    })
    expect(
      new TextEncoder().encode(JSON.stringify(log.history('session-a', { generation: 1 })))
        .byteLength
    ).toBeLessThan(256 * 1024)
  })
})
