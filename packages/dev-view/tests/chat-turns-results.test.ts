import { describe, expect, test } from 'bun:test'
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'

import { projectTranscriptEvents } from '../src/chat/presentation'
import { buildChatTurns, type ChatTurnEntry, type ChatTurnResult } from '../src/chat/model/turns'

let sequence = 0
function activity(
  kind: RuntimeEvent['kind'],
  payload: Record<string, unknown>,
  id: string,
  over: Partial<RuntimeEvent> = {}
) {
  sequence += 1
  return {
    schemaVersion: 1,
    eventId: id,
    runtimeSessionId: 'session-1',
    harnessRunId: 'run-1',
    generation: 1,
    seq: String(sequence),
    occurredAt: '2026-10-14T10:00:00.000Z',
    receivedAt: '2026-10-14T10:00:00.000Z',
    source: 'native',
    sourceEventId: `s${sequence}`,
    confidence: 'authoritative',
    classification: 'workspace_private',
    kind,
    payload: { schemaVersion: 1, ...payload },
    ...over,
  } satisfies RuntimeEvent
}

const prompt = (id: string) =>
  ({
    ...activity('turn.user_input', {}, id, { source: 'host' }),
    payload: { text: 'go' },
  }) satisfies RuntimeEvent

const chunk = (
  id: string,
  seq: number,
  text: string,
  over: Record<string, unknown> = {},
  event: Partial<RuntimeEvent> = {}
) =>
  activity(
    'terminal.output',
    {
      terminalId: 't1',
      commandId: 'c1',
      sequence: String(seq),
      phase: 'output',
      status: 'running',
      stream: 'stdout',
      text,
      ...over,
    },
    id,
    event
  )

const finished = (id: string, seq: number, over: Record<string, unknown> = {}) =>
  activity(
    'terminal.output',
    {
      terminalId: 't1',
      commandId: 'c1',
      sequence: String(seq),
      phase: 'finished',
      status: 'succeeded',
      stream: 'combined',
      exitCode: 0,
      durationMs: 900,
      ...over,
    },
    id
  )

const run = (id: string, status: string, summary: Record<string, number>) =>
  activity('test_run.observed', { testRunId: 'r1', status, summary }, id)

const failure = (id: string, failureId: string) =>
  activity('failure.observed', { failureId, message: 'boom' }, id)

const build = (events: readonly RuntimeEvent[]) => buildChatTurns(projectTranscriptEvents(events))
const results = (entries: readonly ChatTurnEntry[]) =>
  entries.filter((entry): entry is ChatTurnResult => entry.type === 'result')

describe('structured results', () => {
  test('terminal chunks extend one entry by sequence and the finish closes it', () => {
    const { turns, entryByEventId } = build([
      prompt('u1'),
      activity(
        'terminal.output',
        {
          terminalId: 't1',
          commandId: 'c1',
          sequence: '1',
          phase: 'started',
          status: 'running',
          stream: 'combined',
          command: 'bun test',
        },
        'k1'
      ),
      chunk('k2', 2, 'pass one\n'),
      chunk('k3', 3, 'pass two\n', { stream: 'stderr' }),
      chunk('k4', 2, 'a replayed chunk\n'),
      finished('k5', 4),
      chunk('k6', 5, 'after the end\n'),
    ])
    const [entry] = results(turns[0]!.entries)
    expect(turns[0]!.entries).toHaveLength(1)
    expect(entry).toMatchObject({
      id: 'k1',
      eventIds: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'],
      result: {
        type: 'terminal',
        command: 'bun test',
        phase: 'finished',
        status: 'succeeded',
        exitCode: 0,
        durationMs: 900,
        text: 'pass one\npass two\n',
        cut: false,
      },
    })
    expect(entry?.result.type === 'terminal' ? [...entry.result.streams].toSorted() : []).toEqual([
      'combined',
      'stderr',
      'stdout',
    ])
    expect(['k1', 'k2', 'k3', 'k4', 'k5', 'k6'].map((id) => entryByEventId.get(id))).toEqual(
      Array(6).fill('k1')
    )
  })

  test('a secret split across two chunks is redacted once the chunks are joined', () => {
    const { turns } = build([
      prompt('u1'),
      chunk('k1', 1, 'token sk-abcd'),
      chunk('k2', 2, 'efgh12345678 and /home/someone/project\n'),
    ])
    const text = results(turns[0]!.entries)[0]?.result
    const shown = text?.type === 'terminal' ? text.text : ''
    expect(shown).not.toContain('sk-abcd')
    expect(shown).not.toContain('efgh12345678')
    expect(shown).not.toContain('/home/someone')
    expect(shown).toContain('[secret redacted]')
    expect(shown).toContain('[private path]')
  })

  test('output past the display bound keeps its start and says that later output is not shown', () => {
    const { turns } = build([
      prompt('u1'),
      chunk('k1', 1, `first line\n${'x'.repeat(10_000)}`),
      chunk('k2', 2, 'y'.repeat(10_000)),
      chunk('k3', 3, 'last line\n'),
    ])
    const result = results(turns[0]!.entries)[0]?.result
    expect(result).toMatchObject({ type: 'terminal', cut: true })
    expect(result?.type === 'terminal' ? result.text.startsWith('first line') : false).toBe(true)
    expect(result?.type === 'terminal' ? result.text.length : 0).toBeLessThanOrEqual(16_384)
  })

  test('the same terminal and command in another run is another result', () => {
    const { turns } = build([
      prompt('u1'),
      chunk('k1', 1, 'a'),
      chunk('k2', 1, 'b', {}, { harnessRunId: 'run-2' }),
    ])
    expect(results(turns[0]!.entries).map((entry) => entry.id)).toEqual(['k1', 'k2'])
  })

  test('a test run is replaced by later snapshots until the producer ends it', () => {
    const { turns } = build([
      prompt('u1'),
      run('r-1', 'running', { passed: 1 }),
      run('r-2', 'running', { passed: 3, failed: 1 }),
      run('r-3', 'failed', { passed: 3, failed: 1 }),
      run('r-4', 'running', { passed: 99 }),
    ])
    expect(results(turns[0]!.entries)).toHaveLength(1)
    expect(results(turns[0]!.entries)[0]).toMatchObject({
      id: 'r-1',
      eventIds: ['r-1', 'r-2', 'r-3', 'r-4'],
      result: { type: 'test_run', status: 'failed', summary: { passed: 3, failed: 1 } },
    })
  })

  test('nothing is computed: counts and completeness appear only when the producer sent them', () => {
    const { turns } = build([
      prompt('u1'),
      activity(
        'test_run.observed',
        {
          testRunId: 'r1',
          status: 'failed',
          tests: [
            { testId: 'a', name: 'adds', status: 'passed' },
            { testId: 'b', name: 'subtracts', status: 'failed', failureIds: ['f1'] },
          ],
          failures: [
            {
              failureId: 'f1',
              message: 'expected 2, got 3',
              name: 'AssertionError',
              testId: 'b',
              stack: {
                frames: [{ functionName: 'subtract', path: 'src/math.ts', line: 7, column: 3 }],
              },
            },
          ],
        },
        'r-1'
      ),
    ])
    const result = results(turns[0]!.entries)[0]?.result
    expect(result?.type === 'test_run' ? result.summary : 'x').toBeUndefined()
    expect(result?.type === 'test_run' ? result.complete : 'x').toBeUndefined()
    expect(result).toMatchObject({
      tests: [{ name: 'adds' }, { name: 'subtracts' }],
      failures: [
        {
          message: 'expected 2, got 3',
          frames: [{ label: 'subtract src/math.ts', line: 7, column: 3 }],
        },
      ],
    })
  })

  test('a failure is a fact and keeps its own entry', () => {
    const { turns } = build([prompt('u1'), failure('f1', 'x'), failure('f2', 'x')])
    expect(results(turns[0]!.entries).map((entry) => entry.id)).toEqual(['f1', 'f2'])
  })

  test('changed files, plans and tasks fold by their own identity', () => {
    const { turns } = build([
      prompt('u1'),
      activity(
        'files.changed',
        {
          changeSetId: 'cs1',
          files: [{ path: 'a.ts', change: 'modified', additions: 2, deletions: 1 }],
        },
        'c1'
      ),
      activity(
        'files.changed',
        {
          changeSetId: 'cs1',
          complete: true,
          files: [
            { path: 'a.ts', change: 'modified' },
            { path: 'b.ts', change: 'renamed', previousPath: 'old.ts' },
          ],
        },
        'c2'
      ),
      activity(
        'files.changed',
        { changeSetId: 'cs1', files: [{ path: 'late.ts', change: 'added' }] },
        'c3'
      ),
      activity(
        'plan.observed',
        {
          planId: 'p1',
          status: 'in_progress',
          items: [{ id: 'i1', title: 'Write', status: 'pending' }],
        },
        'p-1'
      ),
      activity(
        'plan.observed',
        {
          planId: 'p1',
          status: 'completed',
          items: [{ id: 'i1', title: 'Write', status: 'completed' }],
        },
        'p-2'
      ),
      activity('task.observed', { taskId: 'k1', title: 'Ship', status: 'pending' }, 'k-1'),
    ])
    const found = results(turns[0]!.entries)
    expect(found.map((entry) => entry.id)).toEqual(['c1', 'p-1', 'k-1'])
    expect(found[0]).toMatchObject({
      eventIds: ['c1', 'c2', 'c3'],
      result: {
        type: 'files',
        files: [{ path: 'a.ts' }, { path: 'b.ts', previousPath: 'old.ts' }],
      },
    })
    expect(found[1]).toMatchObject({
      result: { type: 'plan', status: 'completed', items: [{ status: 'completed' }] },
    })
  })

  test('display text is redacted and bounded', () => {
    const { turns } = build([
      prompt('u1'),
      activity(
        'task.observed',
        {
          taskId: 'k1',
          title: 'Rotate sk-abcdefgh12345678 now',
          status: 'pending',
          description: 'see /home/someone/x',
        },
        'k-1'
      ),
    ])
    const result = results(turns[0]!.entries)[0]?.result
    expect(result).toMatchObject({
      title: 'Rotate [secret redacted] now',
      description: 'see [private path]',
    })
  })

  test('a claim the wire gate refuses stays a quiet line with no payload content', () => {
    const { turns } = build([
      prompt('u1'),
      chunk('k1', 1, 'from the host', {}, { source: 'host' }),
      chunk('k2', 1, 'not authoritative', {}, { confidence: 'derived' }),
      activity('task.observed', { taskId: 'k1', title: 123 as never, status: 'pending' }, 'k3'),
      {
        ...activity('task.observed', {}, 'k4'),
        payload: { title: 'a legacy payload', status: 'pending' },
      },
    ])
    expect(turns[0]!.entries.map((entry) => entry.type)).toEqual([
      'activity',
      'activity',
      'activity',
      'activity',
    ])
    expect(JSON.stringify(turns[0]!.entries)).not.toContain('from the host')
    expect(JSON.stringify(turns[0]!.entries)).not.toContain('a legacy payload')
  })
})
