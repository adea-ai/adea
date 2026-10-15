import { describe, expect, test } from 'bun:test'
import { decodeRuntimeActivityPayload as decodePublicActivityPayload } from '@adea-ai/types/dev-runtime-activity'

import {
  decodeRuntimeActivityPayload,
  runtimeActivityEventKinds,
} from '../src/dev-runtime-activity'
import { decodeRuntimeActivityEvent, decodeRuntimeEvent, encodeCbor } from '../src/dev-runtime-wire'

const examples = {
  'test_run.observed': {
    schemaVersion: 1,
    testRunId: 'tests-1',
    status: 'running',
    summary: { total: 100, passed: 75, failed: 2 },
    suites: [{ suiteId: 'suite-1', name: 'Unit', status: 'running' }],
    tests: [{ testId: 'test-1', suiteId: 'suite-1', name: 'adds', status: 'passed' }],
    failures: [{ failureId: 'failure-1', testId: 'test-not-in-this-page', message: 'Expected 2' }],
    complete: false,
  },
  'terminal.output': {
    schemaVersion: 1,
    terminalId: 'term-1',
    commandId: 'command-1',
    sequence: '1',
    phase: 'output',
    status: 'running',
    stream: 'stdout',
    text: 'hello\n\u001b[32mworld\u001b[0m',
    cwd: '.',
  },
  'failure.observed': {
    schemaVersion: 1,
    failureId: 'failure-1',
    name: 'TypeError',
    message: 'A failure',
    stack: {
      raw: 'TypeError: A failure\n at source',
      frames: [
        { functionName: 'run', path: 'src/app.ts', line: 10, column: 2 },
        { url: 'https://example.com/assets/app.js', line: 25 },
        { functionName: 'nativeCall', native: true },
      ],
    },
  },
  'files.changed': {
    schemaVersion: 1,
    changeSetId: 'change-1',
    complete: false,
    summary: { files: 20, additions: 150, deletions: 3 },
    files: [
      { path: 'src/app.ts', change: 'modified', additions: 1, deletions: 0 },
      { path: 'src/new name.ts', previousPath: 'src/old.ts', change: 'renamed' },
    ],
  },
  'plan.observed': {
    schemaVersion: 1,
    planId: 'plan-1',
    status: 'in_progress',
    title: 'A plan',
    summary: { total: 50, completed: 40 },
    complete: false,
    items: [{ id: 'item-1', title: 'One item', status: 'completed' }],
  },
  'task.observed': {
    schemaVersion: 1,
    taskId: 'task-1',
    title: 'A task',
    status: 'pending',
    parentTaskId: 'parent-task',
    planId: 'plan-1',
    url: 'https://example.com/task/1',
    todos: [{ id: 'todo-1', title: 'One todo', status: 'completed' }],
  },
} as const
type Kind = keyof typeof examples

function envelope(
  kind: Kind,
  payload: unknown = examples[kind],
  extra: Record<string, unknown> = {}
) {
  return {
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
    kind,
    payload,
    ...extra,
  }
}
const decode = (kind: Kind, payload: unknown) => decodeRuntimeActivityPayload(payload, kind)
const proof = { source: 'acp', ownedActivityKinds: runtimeActivityEventKinds } as const

describe('structured runtime activity contract', () => {
  test('rejects ill-formed Unicode rather than letting CBOR replace distinct source text', () => {
    for (const text of ['\ud800', '\ud801', '\udfff', 'a\ud800b', '\udc00\ud800']) {
      expect(() => decode('terminal.output', { ...examples['terminal.output'], text })).toThrow(
        'Unicode'
      )
      expect(() => encodeCbor({ text })).toThrow('Unicode')
      expect(() =>
        decodeRuntimeActivityEvent(
          envelope('terminal.output', undefined, { sourceEventId: text }),
          proof
        )
      ).toThrow('Unicode')
    }
    const text = 'a😀b�'
    expect(decode('terminal.output', { ...examples['terminal.output'], text })).toMatchObject({
      text,
    })
  })

  test('all bidi control characters are forbidden in paths and raw or escaped source URLs', () => {
    for (const code of [0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069]) {
      const control = String.fromCodePoint(code)
      const path = `src/${control}app.ts`
      expect(() =>
        decode('files.changed', {
          schemaVersion: 1,
          changeSetId: 'c',
          files: [{ path, change: 'modified' }],
        })
      ).toThrow('path')
      expect(() =>
        decode('terminal.output', { ...examples['terminal.output'], cwd: path })
      ).toThrow('cwd')
      for (const url of [
        `https://example.com/${control}app.ts`,
        `https://example.com/${encodeURIComponent(control)}app.ts`,
      ]) {
        expect(() => decode('task.observed', { ...examples['task.observed'], url })).toThrow('url')
        expect(() =>
          decode('failure.observed', {
            schemaVersion: 1,
            failureId: 'f',
            message: 'F',
            stack: { frames: [{ url }] },
          })
        ).toThrow('url')
      }
    }
  })
  test('the focused public package entry validates the same producer payloads', () => {
    for (const kind of runtimeActivityEventKinds)
      expect(decodePublicActivityPayload(examples[kind], kind)).toEqual(examples[kind])
  })
  test('all six payloads round-trip without filling missing producer facts', () => {
    for (const kind of runtimeActivityEventKinds) {
      expect(decode(kind, examples[kind])).toEqual(examples[kind])
      expect(decodeRuntimeActivityEvent(envelope(kind), proof)).toEqual(envelope(kind))
    }
    const empty = decode('test_run.observed', {
      schemaVersion: 1,
      testRunId: 'r',
      status: 'unknown',
    })
    expect(empty).not.toHaveProperty('summary')
    expect(empty).not.toHaveProperty('tests')
    const task = decode('task.observed', {
      schemaVersion: 1,
      taskId: 't',
      title: 'T',
      status: 'unknown',
    })
    expect(task).not.toHaveProperty('todos')
  })

  test('counts and parent statuses are producer claims even when lists are partial or disagree', () => {
    expect(decode('test_run.observed', examples['test_run.observed'])).toMatchObject({
      status: 'running',
      summary: { total: 100, passed: 75, failed: 2 },
      tests: [{ status: 'passed' }],
    })
    expect(decode('plan.observed', examples['plan.observed'])).toMatchObject({
      status: 'in_progress',
      summary: { total: 50 },
    })
    expect(decode('task.observed', examples['task.observed'])).toMatchObject({ status: 'pending' })
    const terminal = decode('terminal.output', {
      ...examples['terminal.output'],
      phase: 'finished',
      status: 'unknown',
      exitCode: 0,
    })
    expect(terminal).toMatchObject({ phase: 'finished', status: 'unknown', exitCode: 0 })
    expect(decode('files.changed', { ...examples['files.changed'], files: [] })).toMatchObject({
      summary: { files: 20 },
    })
  })

  test('requires source-matched, authoritative, explicitly owned producer provenance', () => {
    const observed = envelope('test_run.observed')
    expect(() => decodeRuntimeActivityEvent(observed, { source: 'acp' })).toThrow('ownership')
    expect(() =>
      decodeRuntimeActivityEvent(observed, { ...proof, ownedActivityKinds: ['task.observed'] })
    ).toThrow('ownership')
    expect(() => decodeRuntimeActivityEvent(observed, { ...proof, source: 'native' })).toThrow(
      'provenance'
    )
    for (const source of ['host', 'terminal_fallback'] as const) {
      expect(() =>
        decodeRuntimeActivityEvent(envelope('test_run.observed', undefined, { source }), {
          ...proof,
          source,
        })
      ).toThrow()
    }
    for (const confidence of ['untrusted_hint', 'bounded_projection']) {
      expect(() =>
        decodeRuntimeActivityEvent(envelope('test_run.observed', undefined, { confidence }), proof)
      ).toThrow('confidence')
    }
    expect(() =>
      decodeRuntimeActivityEvent(
        envelope('test_run.observed', {
          ...examples['test_run.observed'],
          ownedActivityKinds: runtimeActivityEventKinds,
        }),
        proof
      )
    ).toThrow('unknown key')
  })

  test('authenticated hook frames retain the existing tighter 8 KiB ceiling', () => {
    const payload = { ...examples['terminal.output'], text: 'x'.repeat(9000) }
    expect(decodeRuntimeActivityEvent(envelope('terminal.output', payload), proof).payload).toEqual(
      payload
    )
    const hook = { source: 'authenticated_hook', ownedActivityKinds: ['terminal.output'] } as const
    expect(() =>
      decodeRuntimeActivityEvent(
        envelope('terminal.output', payload, { source: hook.source }),
        hook
      )
    ).toThrow('8 KiB')
    expect(
      decodeRuntimeActivityEvent(
        envelope('terminal.output', { ...payload, text: 'small' }, { source: hook.source }),
        hook
      ).payload
    ).toMatchObject({ text: 'small' })
  })

  test('legacy rows remain opaque and never become validated activity records', () => {
    for (const kind of runtimeActivityEventKinds) {
      const legacy = envelope(kind, { text: 'opaque old observation' })
      expect(decodeRuntimeEvent(legacy, { source: 'acp' })).toEqual(legacy)
      expect(() => decodeRuntimeActivityEvent(legacy, proof)).toThrow('schemaVersion')
      expect(() =>
        decodeRuntimeEvent(envelope(kind, { ...examples[kind], schemaVersion: 2 }), proof)
      ).toThrow('schemaVersion')
    }
    expect(() =>
      decodeRuntimeActivityEvent({ ...envelope('task.observed'), kind: 'run.ready' }, proof)
    ).toThrow('kind')
  })

  test('generic replay can retain a bounded structured row without granting producer-owned fact semantics', () => {
    const row = envelope('test_run.observed')
    expect(decodeRuntimeEvent(row, { source: 'acp' })).toEqual(row)
    expect(() => decodeRuntimeActivityEvent(row, { source: 'acp' })).toThrow('ownership')
  })

  test('rejects malformed counts, records, statuses, duplicate identities, and extra authority', () => {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2']) {
      expect(() =>
        decode('test_run.observed', { ...examples['test_run.observed'], summary: { total: value } })
      ).toThrow()
      expect(() =>
        decode('files.changed', { ...examples['files.changed'], summary: { additions: value } })
      ).toThrow()
    }
    for (const kind of runtimeActivityEventKinds) {
      expect(() => decode(kind, { ...examples[kind], trusted: true })).toThrow('unknown key')
      expect(() => decode(kind, { ...examples[kind], schemaVersion: 0 })).toThrow('schemaVersion')
      expect(() => decode(kind, null)).toThrow()
    }
    expect(() =>
      decode('test_run.observed', { ...examples['test_run.observed'], status: 'success' })
    ).toThrow('status')
    expect(() =>
      decode('test_run.observed', {
        ...examples['test_run.observed'],
        tests: [{ name: 'No identity', status: 'passed' }],
      })
    ).toThrow('testId')
    expect(() =>
      decode('test_run.observed', {
        ...examples['test_run.observed'],
        tests: [examples['test_run.observed'].tests[0], examples['test_run.observed'].tests[0]],
      })
    ).toThrow('duplicate')
    expect(() =>
      decode('plan.observed', { ...examples['plan.observed'], items: [{ id: 'i', title: 'I' }] })
    ).toThrow('status')
    expect(() =>
      decode('task.observed', { ...examples['task.observed'], parentTaskId: 'task-1' })
    ).toThrow('parentTaskId')
    expect(() =>
      decode('failure.observed', { ...examples['failure.observed'], stack: { frames: [{}] } })
    ).toThrow('frame')
    expect(() =>
      decode('failure.observed', {
        ...examples['failure.observed'],
        stack: { frames: [{ path: 'src/a.ts', column: 1 }] },
      })
    ).toThrow('line')
  })

  test('rejects unsafe or ambiguous paths and source/task URLs without normalizing them', () => {
    for (const path of [
      '/etc/passwd',
      '../secret',
      'a/../secret',
      'a//b',
      'a/./b',
      'C:/secret',
      '\\server\\file',
      '~/.ssh/id',
      'a\u0000b',
      'a/%2e%2e/key',
      '.git/config',
      'a\\b',
      'a/b.',
    ]) {
      expect(() =>
        decode('files.changed', {
          schemaVersion: 1,
          changeSetId: 'c',
          files: [{ path, change: 'modified' }],
        })
      ).toThrow('path')
      expect(() =>
        decode('failure.observed', {
          schemaVersion: 1,
          failureId: 'f',
          message: 'F',
          stack: { frames: [{ path }] },
        })
      ).toThrow('path')
      expect(() =>
        decode('terminal.output', { ...examples['terminal.output'], cwd: path })
      ).toThrow('cwd')
    }
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'http://example.com/a',
      'https://u:p@example.com/a',
      'https://localhost/a',
      'https://127.0.0.1/a',
      'https://[::1]/a',
      'https://example.local/a',
      'https://example.com/%0a',
      ' https://example.com/a',
      'https://example.com/%zz',
      'https://example.com/%E2%80%AE',
      'https://example.com/%5cpath',
      'https:example.com/source.ts',
      'https:///example.com/source.ts',
      'https://@example.com/source.ts',
    ]) {
      expect(() =>
        decode('failure.observed', {
          schemaVersion: 1,
          failureId: 'f',
          message: 'F',
          stack: { frames: [{ url }] },
        })
      ).toThrow('url')
      expect(() => decode('task.observed', { ...examples['task.observed'], url })).toThrow('url')
    }
    expect(() =>
      decode('files.changed', {
        ...examples['files.changed'],
        files: [{ path: 'new.ts', change: 'renamed' }],
      })
    ).toThrow('previousPath')
    expect(() =>
      decode('files.changed', {
        ...examples['files.changed'],
        files: [{ path: 'new.ts', change: 'added', previousPath: 'old.ts' }],
      })
    ).toThrow('previousPath')
  })

  test('validates command phases and canonical uint64 output sequence without interpreting output text', () => {
    for (const sequence of ['01', '-1', '18446744073709551616', 1]) {
      expect(() => decode('terminal.output', { ...examples['terminal.output'], sequence })).toThrow(
        'sequence'
      )
    }
    expect(() =>
      decode('terminal.output', {
        ...examples['terminal.output'],
        phase: 'started',
        status: 'succeeded',
      })
    ).toThrow('status')
    expect(() =>
      decode('terminal.output', { ...examples['terminal.output'], text: undefined })
    ).toThrow('text')
    expect(() =>
      decode('terminal.output', { ...examples['terminal.output'], exitCode: 0 })
    ).toThrow('exitCode')
    const text = '<script>alert(1)</script>\nhttps://localhost/\u001b[31m'
    expect(decode('terminal.output', { ...examples['terminal.output'], text })).toMatchObject({
      text,
    })
  })

  test('bounds total bytes, collection sizes, strings, depth and nodes before publishing facts', () => {
    expect(() =>
      decode('terminal.output', { ...examples['terminal.output'], text: 'x'.repeat(16_385) })
    ).toThrow()
    expect(() =>
      decode('test_run.observed', {
        ...examples['test_run.observed'],
        tests: Array.from({ length: 257 }, (_, i) => ({
          testId: `t-${i}`,
          name: 'T',
          status: 'passed',
        })),
      })
    ).toThrow()
    expect(() =>
      decode('test_run.observed', {
        ...examples['test_run.observed'],
        failures: Array.from({ length: 64 }, (_, i) => ({
          failureId: `f-${i}`,
          message: '😀'.repeat(4096),
        })),
      })
    ).toThrow('encoded')
    expect(() =>
      decode('failure.observed', {
        ...examples['failure.observed'],
        stack: { frames: Array.from({ length: 65 }, () => ({ native: true })) },
      })
    ).toThrow()
    expect(() =>
      decode('plan.observed', {
        ...examples['plan.observed'],
        items: Array.from({ length: 129 }, (_, i) => ({
          id: `i-${i}`,
          title: 'I',
          status: 'pending',
        })),
      })
    ).toThrow()
    const cycle: unknown[] = []
    cycle.push(cycle)
    expect(() =>
      decode('test_run.observed', { ...examples['test_run.observed'], summary: cycle })
    ).toThrow()
    expect(() =>
      decode('test_run.observed', { ...examples['test_run.observed'], summary: new Date() })
    ).toThrow()
    expect(() =>
      decode('test_run.observed', { ...examples['test_run.observed'], tests: Array(2) })
    ).toThrow()
    expect(() =>
      decode('test_run.observed', {
        ...examples['test_run.observed'],
        summary: Array.from({ length: 128 }, () => Array.from({ length: 32 }, () => null)),
      })
    ).toThrow('node count')
    expect(() =>
      decode('test_run.observed', {
        ...examples['test_run.observed'],
        summary: Array.from({ length: 13 }).reduce<unknown>((value) => [value], null),
      })
    ).toThrow('nesting')
  })

  test('admits exactly 64 KiB of encoded JSON and refuses the next byte', () => {
    const payload = {
      schemaVersion: 1,
      testRunId: 'r',
      status: 'unknown',
      failures: Array.from({ length: 8 }, (_, index) => ({
        failureId: `f-${index}`,
        message: index < 7 ? 'x'.repeat(8192) : 'x',
      })),
    }
    const initial = new TextEncoder().encode(JSON.stringify(payload)).byteLength
    payload.failures[7]!.message += 'x'.repeat(64 * 1024 - initial)
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBe(64 * 1024)
    expect(decode('test_run.observed', payload)).toEqual(payload)
    payload.failures[7]!.message += 'x'
    expect(() => decode('test_run.observed', payload)).toThrow('encoded')
  })
})
