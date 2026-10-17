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

const scope = { accountId: 'a', workspaceId: 'w', runtimeNodeId: 'n' }
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const summary = (revision = 0, status = 'streaming', text = 'Checked the published evidence.') => ({
  schemaVersion: 1,
  provenance: 'source_reported',
  visibility: 'user_visible',
  format: 'snapshot',
  summaryId: 'summary-1',
  revision,
  text,
  status,
})
const message = (
  payload: unknown = summary(),
  sourceEventId = 'summary-frame-0',
  overrides: Partial<SessionEventInput> = {}
): SessionEventInput => ({
  runtimeSessionId: 'session-1',
  harnessRunId: 'run-1',
  generation: 1,
  source: 'acp',
  confidence: 'authoritative',
  classification: 'workspace_private',
  kind: 'turn.reasoning_summary' as RuntimeEvent['kind'],
  sourceEventId,
  payload,
  ...overrides,
})
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-visible-summary-'))
  dirs.push(dataDir)
  const observations = new Map<string, string>()
  const observation = (input: SessionEventInput) => ({
    scope,
    runtimeSessionId: input.runtimeSessionId,
    harnessRunId: input.harnessRunId,
    generation: input.generation,
    source: input.source,
    sourceEventId: input.sourceEventId,
    confidence: input.confidence,
    classification: input.classification,
    kind: input.kind,
    payload: input.payload,
  })
  const verifyVisibleSummary = (value: unknown) => {
    const input = value as { sourceEventId: string }
    return observations.get(input.sourceEventId) === JSON.stringify(value)
  }
  const options = { dataDir, scope, verifyVisibleSummary }
  const observe = (input: SessionEventInput) => {
    observations.set(input.sourceEventId, JSON.stringify(observation(input)))
    return input
  }
  return { dataDir, options, observe, log: createSessionEventLog(options) }
}

describe('source-visible summary admission and replay', () => {
  test('self-declared public text is refused without a trusted source observation verifier', () => {
    const { dataDir, log } = fixture()
    expect(() => log.append(message())).toThrow()
    expect(() => createSessionEventLog({ dataDir, scope }).append(message())).toThrow()
    expect(log.read('session-1')).toEqual([])
    expect(log.latestSequence('session-1')).toBe('0')
  })

  test('nonboolean verification fails closed and a verifier cannot mutate admitted bytes', () => {
    const { options } = fixture()
    for (const result of [false, undefined, 'true', Promise.resolve(true)]) {
      const log = createSessionEventLog({
        ...options,
        verifyVisibleSummary: (() => result) as never,
      })
      expect(() => log.append(message())).toThrow()
    }
    const log = createSessionEventLog({
      ...options,
      verifyVisibleSummary: (observation) => {
        ;(observation.payload as { text: string }).text = 'Mutated by verifier'
        return true
      },
    })
    expect(log.append(message())!.payload).toEqual(summary())
  })

  test('streams exact full snapshots with source timing, then replays after restart and CBOR encoding', () => {
    const { log, observe, options } = fixture()
    const seen: RuntimeEvent[] = []
    log.subscribe('session-1', (event) => seen.push(event))
    const first = log.append(observe(message()))!
    const final = log.append(
      observe(
        message(
          { ...summary(2, 'completed', 'Compared the published evidence.'), durationMs: 1234 },
          'summary-frame-2'
        )
      )
    )!
    expect(first.payload).not.toHaveProperty('durationMs')
    expect(seen).toEqual([first, final])
    expect(createSessionEventLog(options).read('session-1')).toEqual(seen)
    for (const event of seen)
      expect(decodeRuntimeEvent(decodeCbor(encodeCbor(event)).value, { source: 'acp' })).toEqual(
        event
      )
    expect(log.append(message())).toBeUndefined()
  })

  test('binds the verifier to exact scope, run, source identity, classification and text', () => {
    const { log, observe, options } = fixture()
    observe(message())
    for (const overrides of [
      { harnessRunId: 'run-2' },
      { generation: 2 },
      { runtimeSessionId: 'session-2' },
      { source: 'native' as const },
      { sourceEventId: 'unobserved' },
      { classification: 'public' as const },
      { payload: summary(0, 'streaming', 'Unverified text') },
    ])
      expect(() => log.append(message(summary(), 'summary-frame-0', overrides))).toThrow()
    const foreign = createSessionEventLog({ ...options, scope: { ...scope, workspaceId: 'other' } })
    expect(() => foreign.append(message())).toThrow()
    expect(log.events()).toEqual([])
  })

  test('invalid updates consume no sequence, retention slot or delivery', () => {
    const { observe, options } = fixture()
    const log = createSessionEventLog({ ...options, maxPerSession: 1 })
    log.append(observe(message({ ...summary(), durationMs: 100 })))
    const file = join(options.dataDir, 'dev-runtime/harness/session-events.json')
    const retained = readFileSync(file, 'utf8')
    let delivered = 0
    log.subscribe('session-1', () => delivered++)
    for (const payload of [summary(0), { ...summary(1), durationMs: 99 }])
      expect(() => log.append(observe(message(payload, 'bad-update')))).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(retained)
    expect(log.latestSequence('session-1')).toBe('1')
    expect(delivered).toBe(0)
  })

  test('missing timing on a later source snapshot remains unknown', () => {
    const { log, observe } = fixture()
    log.append(observe(message({ ...summary(), durationMs: 100 })))
    const next = log.append(observe(message(summary(1, 'unknown'), 'unknown-timing')))!
    expect(next.payload).not.toHaveProperty('durationMs')
    expect(next.payload).toHaveProperty('status', 'unknown')
  })

  test('terminal summaries refuse late changes and a new run/generation has independent identity', () => {
    const { log, observe } = fixture()
    log.append(observe(message(summary(0, 'completed'))))
    expect(() => log.append(observe(message(summary(1), 'late')))).toThrow()
    expect(
      log.append(observe(message(summary(), 'next-run', { harnessRunId: 'run-2' })))
    ).toBeDefined()
    expect(
      log.append(observe(message(summary(), 'next-generation', { generation: 2 })))
    ).toBeDefined()
  })

  test('method-step updates retain position and status independently from reasoning summaries', () => {
    const { log, observe } = fixture()
    const payload = {
      schemaVersion: 1,
      provenance: 'source_reported',
      visibility: 'user_visible',
      format: 'snapshot',
      methodId: 'method-1',
      stepId: 'step-1',
      position: 0,
      revision: 0,
      title: 'Check sources',
      text: 'Compared source versions.',
      status: 'running',
    }
    const kind = 'turn.method_step_summary' as RuntimeEvent['kind']
    log.append(observe(message(payload, 'step-0', { kind })))
    expect(() =>
      log.append(observe(message({ ...payload, revision: 1, position: 1 }, 'moved-step', { kind })))
    ).toThrow()
    expect(
      log.append(
        observe(
          message({ ...payload, revision: 1, status: 'completed', durationMs: 10 }, 'step-1', {
            kind,
          })
        )
      )
    ).toBeDefined()
    expect(log.append(observe(message(summary(), 'reasoning-0')))).toBeDefined()
  })

  test('a bounded suffix replays a complete snapshot without reconstructing earlier text', () => {
    const { options, observe } = fixture()
    const log = createSessionEventLog({ ...options, maxPerSession: 1 })
    log.append(observe(message()))
    const retained = log.append(
      observe(message(summary(10, 'streaming', 'Complete newer snapshot.'), 'latest'))
    )!
    expect(
      createSessionEventLog({ ...options, verifyVisibleSummary: undefined }).read('session-1')
    ).toEqual([retained])
  })

  test('replay refuses hidden or malformed retained summary bytes and preserves the file', () => {
    const { log, observe, options } = fixture()
    log.append(observe(message()))
    const file = join(options.dataDir, 'dev-runtime/harness/session-events.json')
    const record = JSON.parse(readFileSync(file, 'utf8'))
    record.records[0].payload.visibility = 'hidden'
    const raw = JSON.stringify(record)
    writeFileSync(file, raw)
    expect(() => createSessionEventLog(options).read('session-1')).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(raw)
  })

  test('replay refuses retained revision, duration, terminal-status and position regressions', () => {
    for (const mutation of ['revision', 'duration', 'terminal', 'position']) {
      const { log, observe, options } = fixture()
      const kind = (
        mutation === 'position' ? 'turn.method_step_summary' : 'turn.reasoning_summary'
      ) as RuntimeEvent['kind']
      const payload =
        mutation === 'position'
          ? {
              schemaVersion: 1,
              provenance: 'source_reported',
              visibility: 'user_visible',
              format: 'snapshot',
              methodId: 'm',
              stepId: 's',
              position: 0,
              revision: 0,
              title: 'Check',
              text: 'Public method step.',
              status: 'running',
              durationMs: 100,
            }
          : { ...summary(), durationMs: 100 }
      log.append(observe(message(payload, 'frame-0', { kind })))
      log.append(
        observe(message({ ...payload, revision: 1, durationMs: 200 }, 'frame-1', { kind }))
      )
      const file = join(options.dataDir, 'dev-runtime/harness/session-events.json')
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      if (mutation === 'revision') stored.records[1].payload.revision = 0
      if (mutation === 'duration') stored.records[1].payload.durationMs = 99
      if (mutation === 'terminal') stored.records[0].payload.status = 'completed'
      if (mutation === 'position') stored.records[1].payload.position = 1
      const raw = JSON.stringify(stored)
      writeFileSync(file, raw)
      expect(() => createSessionEventLog(options).read('session-1')).toThrow()
      expect(readFileSync(file, 'utf8')).toBe(raw)
    }
  })

  test('ordinary messages, run completion and unrelated kinds never generate a summary', () => {
    const { log, options } = fixture()
    for (const kind of ['turn.assistant_message', 'run.completed', 'future.summary'])
      log.append(
        message(
          {
            text: 'Opaque text.',
            analysis: 'Not a public summary.',
            ...(kind === 'turn.assistant_message'
              ? { messageId: 'message-1', supersedes: 'deltas' }
              : {}),
          },
          kind,
          {
            kind: kind as RuntimeEvent['kind'],
            source: 'host',
          }
        )
      )
    const retained = createSessionEventLog(options).read('session-1')
    expect(retained.map((event) => event.kind)).toEqual([
      'turn.assistant_message',
      'run.completed',
      'future.summary',
    ])
  })
})
