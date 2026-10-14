import { describe, expect, test } from 'bun:test'
import type { HarnessRun, RuntimeEvent, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'

import type { RuntimeEventStream } from '../src/chat/model/event-stream'
import { createTranscriptAccumulator, type TranscriptAccumulator } from '../src/chat/model'
import {
  RESULT_CAP,
  RESULT_PAGE,
  RESUME_BLOCKED_COPY,
  buildAllSessionsView,
} from '../src/history/all-sessions-model'
import { turnIdForEvent } from '../src/history/history-pane'
import { buildHistoryTurns } from '../src/history/turns-model'
import {
  SCAN_MAX_SESSIONS,
  readEventWindow,
  scanAllSessions,
  type AllSessionsScan,
  type AllSessionsScanIO,
} from '../src/history/all-sessions-scan'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

function sessionOf(id: string, overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id,
    scope: SCOPE,
    projectId: 'project-1',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    displayName: `Session ${id}`,
    lifecycle: 'active',
    archived: false,
    projection: 'structured',
    generation: 1,
    version: 1,
    ...overrides,
  }
}

function runOf(
  runtimeSessionId: string,
  overrides: Partial<HarnessRun> & { id: string }
): HarnessRun {
  return {
    scope: SCOPE,
    runtimeSessionId,
    installationId: 'installation-1',
    agentProfile: { id: 'profile-1', version: 1, displayName: 'Agent', capabilityPolicyVersion: 1 },
    state: 'completed',
    generation: 1,
    startedAt: '2026-09-22T10:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

function eventOf(
  runtimeSessionId: string,
  seq: number,
  overrides: Partial<RuntimeEvent> = {}
): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: `${runtimeSessionId}-event-${seq}`,
    runtimeSessionId,
    generation: 1,
    seq: String(seq),
    occurredAt: new Date(Date.UTC(2026, 8, 22, 10, 0, seq)).toISOString(),
    receivedAt: '2026-09-22T10:00:10.000Z',
    source: 'host',
    sourceEventId: `${runtimeSessionId}-source-${seq}`,
    confidence: 'authoritative',
    classification: 'workspace_metadata',
    kind: 'turn.user_input',
    payload: { text: `prompt ${seq}` },
    ...overrides,
  }
}

function scanOf(input: {
  sessions: RuntimeSession[]
  runs?: HarnessRun[]
  events: Record<string, RuntimeEvent[]>
  partial?: boolean
}): AllSessionsScan {
  return {
    sessions: input.sessions,
    runs: input.runs ?? [],
    events: new Map(Object.entries(input.events)),
    searched: Object.keys(input.events).length,
    partial: input.partial ?? false,
    scannedAt: 0,
  }
}

function resumeOf(
  sessions: RuntimeSession[],
  events: Record<string, RuntimeEvent[]>,
  run: HarnessRun
) {
  return buildAllSessionsView(
    scanOf({ sessions, runs: [run], events: { a: events.a! } }),
    'terminal',
    RESULT_PAGE
  ).groups.find((group) => group.runtimeSessionId === 'a')!.resume
}

describe('buildAllSessionsView', () => {
  const sessions = [sessionOf('a', { displayName: 'Shell switcher' }), sessionOf('b')]
  const events = {
    a: [
      eventOf('a', 1, { payload: { text: 'add a terminal shell switcher' } }),
      eventOf('a', 2, {
        kind: 'turn.result',
        payload: { summary: 'Added the terminal Shell menu' },
      }),
      eventOf('a', 3, { kind: 'tool.requested', payload: { name: 'bun test terminal' } }),
    ],
    b: [eventOf('b', 4, { payload: { text: 'fix terminal resize' } })],
  }

  test('groups matches by session, newest group first, with whole-result counts', () => {
    const view = buildAllSessionsView(scanOf({ sessions, events }), 'terminal', RESULT_PAGE)
    expect(view.mode).toBe('results')
    expect(view.total).toBe(3 + 1)
    expect(view.groups.map((group) => group.runtimeSessionId)).toEqual(['b', 'a'])
    expect(view.groups.map((group) => group.matches)).toEqual([1, 3])
    expect(view.groups[1]!.rows.map((row) => row.kind)).toEqual(['tool', 'result', 'prompt'])
    expect(view.capped).toBe(false)
  })

  test('counts a session’s matches over the whole result, not only the shown page', () => {
    const many = Array.from({ length: 120 }, (_, index) =>
      eventOf('a', index + 1, { payload: { text: `terminal note ${index}` } })
    )
    const view = buildAllSessionsView(scanOf({ sessions, events: { a: many } }), 'terminal', 10)
    expect(view.shown).toBe(10)
    expect(view.total).toBe(120)
    expect(view.groups[0]!.matches).toBe(120)
    expect(view.groups[0]!.rows).toHaveLength(10)
  })

  test('an empty query lists the most recent prompts only, a few per session', () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      eventOf('a', index + 1, { payload: { text: `ask ${index}` } })
    )
    many.push(eventOf('a', 20, { kind: 'turn.result', payload: { summary: 'a reply' } }))
    const view = buildAllSessionsView(
      scanOf({ sessions, events: { a: many, b: events.b } }),
      '  ',
      RESULT_PAGE
    )
    expect(view.mode).toBe('recent')
    expect(view.groups.every((group) => group.rows.every((row) => row.kind === 'prompt'))).toBe(
      true
    )
    const shell = view.groups.find((group) => group.runtimeSessionId === 'a')!
    expect(shell.rows.map((row) => row.preview)).toEqual(['ask 7', 'ask 6', 'ask 5'])
    expect(shell.matches).toBe(3)
  })

  test('never lists credential-classified events, searching or not', () => {
    const scan = scanOf({
      sessions,
      events: {
        a: [
          eventOf('a', 1, { payload: { text: 'rotate the staging key' } }),
          eventOf('a', 2, { classification: 'credential', payload: { text: 'rotate to hunter2' } }),
        ],
      },
    })
    for (const query of ['', 'rotate', 'hunter2']) {
      const view = buildAllSessionsView(scan, query, RESULT_PAGE)
      expect(JSON.stringify(view)).not.toContain('hunter2')
    }
  })

  test('a fresher window replaces the scanned one for the open session', () => {
    const scan = scanOf({ sessions, events })
    const live = new Map([
      ['a', [eventOf('a', 9, { payload: { text: 'brand new terminal question' } })]],
    ])
    const view = buildAllSessionsView(scan, 'terminal', RESULT_PAGE, live)
    expect(view.groups.find((group) => group.runtimeSessionId === 'a')!.rows).toHaveLength(1)
  })

  test('pages 1,000 matches 50 at a time and stops at the cap with the total kept', () => {
    const rows = Array.from({ length: 4_812 }, (_, index) =>
      eventOf('a', index + 1, { payload: { text: `deploy note ${index}` } })
    )
    // The search model reads a 1,000-event window per session, so the total is
    // the window; fan the same text over sessions to pass the cap honestly.
    const many = Array.from({ length: 6 }, (_, index) => sessionOf(`s${index}`))
    const windows: Record<string, RuntimeEvent[]> = {}
    for (const session of many)
      windows[session.id] = rows.slice(0, 1_000).map((row) => ({
        ...row,
        eventId: `${session.id}-${row.eventId}`,
        runtimeSessionId: session.id,
      }))
    const scan = scanOf({ sessions: many, events: windows })
    const first = buildAllSessionsView(scan, 'deploy', RESULT_PAGE)
    expect(first.shown).toBe(RESULT_PAGE)
    expect(first.total).toBe(6_000)
    expect(first.capped).toBe(true)
    const second = buildAllSessionsView(scan, 'deploy', RESULT_PAGE * 2)
    expect(second.shown).toBe(RESULT_PAGE * 2)
    // Past the cap the count request is clamped, never the whole 6,000.
    const past = buildAllSessionsView(scan, 'deploy', 10_000)
    expect(past.shown).toBe(RESULT_CAP)
    expect(past.total).toBe(6_000)
    expect(new Set(past.groups.flatMap((group) => group.rows.map((row) => row.id))).size).toBe(
      RESULT_CAP
    )
  })

  describe('resume', () => {
    test('offers a resume for a finished, started run and names the next generation', () => {
      const resume = resumeOf(
        sessions,
        events,
        runOf('a', { id: 'run-1', state: 'failed', generation: 6 })
      )
      expect(resume).toMatchObject({
        kind: 'available',
        target: {
          runtimeSessionId: 'a',
          harnessRunId: 'run-1',
          nextGeneration: 7,
          title: 'Shell switcher',
        },
      })
    })

    test.each([
      ['cancelled', {}, RESUME_BLOCKED_COPY.cancelled],
      ['working', {}, RESUME_BLOCKED_COPY.non_terminal],
      ['unknown', {}, RESUME_BLOCKED_COPY.unknown_state],
      ['completed', { startedAt: undefined }, RESUME_BLOCKED_COPY.missing_start],
    ] as const)('a %s run explains why it cannot be resumed', (state, extra, copy) => {
      const run = { ...runOf('a', { id: 'run-1', state }), ...extra } as HarnessRun
      expect(resumeOf(sessions, events, run)).toEqual({ kind: 'blocked', reason: copy })
    })

    test('only the newest run decides', () => {
      const older = runOf('a', { id: 'old', state: 'cancelled', generation: 1 })
      const newer = runOf('a', { id: 'new', state: 'completed', generation: 2 })
      const view = buildAllSessionsView(
        scanOf({ sessions, runs: [older, newer], events: { a: events.a } }),
        'terminal',
        RESULT_PAGE
      )
      const resume = view.groups.find((group) => group.runtimeSessionId === 'a')!.resume
      expect(resume).toMatchObject({
        kind: 'available',
        target: { harnessRunId: 'new', runNumber: 2 },
      })
    })

    test('the verbatim reasons the design shows', () => {
      expect(RESUME_BLOCKED_COPY).toEqual({
        cancelled: 'This run was cancelled and cannot be resumed',
        non_terminal: 'This run is still active',
        missing_start: 'This run has no recorded start to resume from',
        unknown_state: 'This run’s state is unknown, so it cannot be resumed',
      })
    })
  })
})

function ioOf(overrides: Partial<AllSessionsScanIO> & { sessions: RuntimeSession[] }) {
  const { sessions, ...rest } = overrides
  const reads: string[] = []
  let live = 0
  let peak = 0
  const io: AllSessionsScanIO = {
    listSessions: async () => ({ items: sessions }),
    listRuns: async () => ({ items: [] }),
    readWindow: async (session) => {
      reads.push(session.id)
      live += 1
      peak = Math.max(peak, live)
      await new Promise((resolve) => setTimeout(resolve, 2))
      live -= 1
      return { events: [eventOf(session.id, 1)], bounded: false }
    },
    assertCurrent: () => {},
    ...rest,
  }
  return { io, reads, peak: () => peak }
}

describe('scanAllSessions', () => {
  test('reads the most recently active sessions first, a few at a time', async () => {
    const sessions = Array.from({ length: 30 }, (_, index) => sessionOf(`s${index}`))
    const runs = [
      runOf('s29', { id: 'r29', startedAt: '2026-09-23T10:00:00.000Z' }),
      runOf('s28', { id: 'r28', startedAt: '2026-09-22T10:00:00.000Z' }),
    ]
    const { io, reads, peak } = ioOf({ sessions, listRuns: async () => ({ items: runs }) })
    const scan = await scanAllSessions(io)
    expect(reads.slice(0, 2)).toEqual(['s29', 's28'])
    expect(reads).toHaveLength(SCAN_MAX_SESSIONS)
    expect(peak()).toBeLessThanOrEqual(4)
    expect(scan.searched).toBe(SCAN_MAX_SESSIONS)
    expect(scan.partial).toBe(true)
    expect(scan.sessions).toHaveLength(30)
  })

  test('is complete when every session fits and every window is whole', async () => {
    const sessions = [sessionOf('a'), sessionOf('b')]
    const { io } = ioOf({ sessions })
    const scan = await scanAllSessions(io, () => 42)
    expect(scan).toMatchObject({ searched: 2, partial: false, scannedAt: 42 })
  })

  test('skips archived and terminal-only sessions and says nothing is missing for them', async () => {
    const sessions = [
      sessionOf('a'),
      sessionOf('archived', { archived: true }),
      sessionOf('terminal', { projection: 'terminal_fallback' }),
    ]
    const { io, reads } = ioOf({ sessions })
    const scan = await scanAllSessions(io)
    expect(reads).toEqual(['a'])
    expect(scan.partial).toBe(false)
  })

  test('a bounded or unreadable window makes the scan partial, not failed', async () => {
    const { io } = ioOf({
      sessions: [sessionOf('a'), sessionOf('b'), sessionOf('c')],
      readWindow: async (session) => {
        if (session.id === 'b') throw new Error('socket closed')
        if (session.id === 'c') return undefined
        return { events: [eventOf('a', 1)], bounded: true }
      },
    })
    const scan = await scanAllSessions(io)
    expect(scan.searched).toBe(1)
    expect(scan.partial).toBe(true)
  })

  test('fails when no session could be read at all', async () => {
    const { io } = ioOf({ sessions: [sessionOf('a')], readWindow: async () => undefined })
    await expect(scanAllSessions(io)).rejects.toThrow()
  })

  test('a truncated list or runs page, or a repeated cursor, is reported as partial', async () => {
    const paged = ioOf({
      sessions: [],
      listSessions: async (cursor) => ({
        items: [sessionOf(cursor ?? 'first')],
        nextCursor: 'same',
      }),
    })
    const scan = await scanAllSessions(paged.io)
    expect(scan.partial).toBe(true)
    expect(scan.sessions.length).toBeLessThanOrEqual(3)
  })

  test('runs that cannot be read do not stop a search of prompts and replies', async () => {
    const { io } = ioOf({
      sessions: [sessionOf('a')],
      listRuns: async () => {
        throw new Error('dev.harness.read is not granted')
      },
    })
    const scan = await scanAllSessions(io)
    expect(scan.runs).toEqual([])
    expect(scan.searched).toBe(1)
  })

  test('stops when the workspace changes in flight', async () => {
    let calls = 0
    const { io } = ioOf({
      sessions: [sessionOf('a')],
      assertCurrent: () => {
        calls += 1
        if (calls > 2) throw new Error('context changed')
      },
    })
    await expect(scanAllSessions(io)).rejects.toThrow('context changed')
  })
})

function fakeStream() {
  let state: TranscriptAccumulator = createTranscriptAccumulator({
    runtimeSessionId: 'a',
    generation: 1,
  })
  const listeners = new Set<(next: TranscriptAccumulator) => void>()
  let closed = 0
  const stream: RuntimeEventStream = {
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => {
      closed += 1
    },
  }
  return {
    stream,
    closed: () => closed,
    push(next: Partial<TranscriptAccumulator>) {
      state = { ...state, ...next }
      for (const listener of listeners) listener(state)
    },
  }
}

describe('readEventWindow', () => {
  test('settles once frames stop after the stream opened, and closes the stream', async () => {
    const fake = fakeStream()
    const window = readEventWindow(fake.stream, { quietMs: 10, timeoutMs: 500 })
    fake.push({ expectedSequence: '1' })
    fake.push({ events: [eventOf('a', 1)], expectedSequence: '2' })
    await expect(window).resolves.toEqual({ events: [eventOf('a', 1)], bounded: false })
    expect(fake.closed()).toBe(1)
  })

  test('waits for the stream to open instead of settling an empty window early', async () => {
    const fake = fakeStream()
    const window = readEventWindow(fake.stream, { quietMs: 5, timeoutMs: 500 })
    await new Promise((resolve) => setTimeout(resolve, 40))
    fake.push({ expectedSequence: '1' })
    await expect(window).resolves.toEqual({ events: [], bounded: false })
  })

  test('a stream that never opens is unread at the timeout', async () => {
    const fake = fakeStream()
    await expect(
      readEventWindow(fake.stream, { quietMs: 5, timeoutMs: 20 })
    ).resolves.toBeUndefined()
    expect(fake.closed()).toBe(1)
  })

  test('a gap, conflict or older generation makes the window unread', async () => {
    for (const availability of [
      {
        status: 'resync_required',
        reason: 'sequence_gap',
        expectedSequence: '1',
        receivedSequence: '9',
      },
      { status: 'conflict', sourceEventId: 'x' },
      { status: 'stale_generation', generation: 3 },
    ] as const) {
      const fake = fakeStream()
      const window = readEventWindow(fake.stream, { quietMs: 5, timeoutMs: 500 })
      fake.push({ expectedSequence: '1', availability })
      await expect(window).resolves.toBeUndefined()
      expect(fake.closed()).toBe(1)
    }
  })

  test('a replay still running at the timeout is kept but reported as bounded', async () => {
    const fake = fakeStream()
    const window = readEventWindow(fake.stream, { quietMs: 30, timeoutMs: 60 })
    fake.push({ expectedSequence: '1' })
    let sequence = 1
    const feed = setInterval(() => {
      sequence += 1
      fake.push({ events: [eventOf('a', sequence - 1)], expectedSequence: String(sequence) })
    }, 10)
    const result = await window
    clearInterval(feed)
    expect(result?.bounded).toBe(true)
    expect(result?.events.length).toBeGreaterThan(0)
    expect(fake.closed()).toBe(1)
  })

  test('reports a window retention cut short as bounded', async () => {
    const fake = fakeStream()
    const window = readEventWindow(fake.stream, { quietMs: 5, timeoutMs: 500 })
    fake.push({
      expectedSequence: '5',
      retention: { maxEvents: 1_000, complete: false, reason: 'retention' },
    })
    await expect(window).resolves.toMatchObject({ bounded: true })
  })
})

describe('turnIdForEvent', () => {
  const events = [
    eventOf('a', 1, { payload: { text: 'first ask' } }),
    eventOf('a', 2, { kind: 'tool.requested', payload: { name: 'bash' } }),
    eventOf('a', 3, { kind: 'turn.result', payload: { summary: 'done' } }),
    eventOf('a', 4, { payload: { text: 'second ask' } }),
  ]
  const turns = buildHistoryTurns(events)

  test('a prompt maps to its own turn and later events to the latest prompt before them', () => {
    expect(turnIdForEvent(turns, events, 'a-event-1')).toBe('a-event-1')
    expect(turnIdForEvent(turns, events, 'a-event-3')).toBe('a-event-1')
    expect(turnIdForEvent(turns, events, 'a-event-4')).toBe('a-event-4')
  })

  test('an event the window does not hold has no turn', () => {
    expect(turnIdForEvent(turns, events, 'gone')).toBeUndefined()
  })
})
