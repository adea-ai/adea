import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RuntimeSession, Scope } from '../../../packages/types/src/dev-runtime'
import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import { registerHarnessRuntime } from '../shell/src/dev-runtime/harness/register'
import {
  createSessionEventLog,
  type SessionEventInput,
} from '../shell/src/dev-runtime/harness/events'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const initialSession: RuntimeSession = {
  id: 'session-1',
  scope,
  projectId: 'project-1',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  activeHarnessRunId: 'run-1',
  generation: 1,
  version: 1,
  lifecycle: 'active',
  archived: false,
  projection: 'structured',
}
const eligibility = { eligible: false, reason: 'response_unavailable' } as const
const payload = {
  schemaVersion: 1,
  requestId: 'request-1',
  prompt: 'Allow this action?',
  eligibility,
}
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-interactions-'))
  dirs.push(dataDir)
  let session: RuntimeSession | undefined = initialSession
  const options = {
    dataDir,
    scope,
    resolveSession: (id: string) => (id === session?.id ? session : undefined),
  }
  return {
    options,
    log: createSessionEventLog(options),
    setSession: (value: RuntimeSession | undefined) => {
      session = value
    },
  }
}

function request(overrides: Partial<SessionEventInput> = {}): SessionEventInput {
  return {
    runtimeSessionId: initialSession.id,
    harnessRunId: 'run-1',
    generation: 1,
    source: 'native',
    sourceEventId: 'source-request-1',
    kind: 'approval.requested',
    confidence: 'authoritative',
    classification: 'workspace_private',
    payload,
    ...overrides,
  }
}
function outcome(
  requestEventId: string,
  overrides: Partial<SessionEventInput> = {}
): SessionEventInput {
  return request({
    kind: 'approval.resolved',
    sourceEventId: 'source-outcome-1',
    payload: {
      schemaVersion: 1,
      requestId: 'request-1',
      requestEventId,
      decision: 'denied',
    },
    ...overrides,
  })
}

describe('host interaction admission and correlation', () => {
  test('persists the exact request/decision correlation and replays idempotently across restart', () => {
    const { log, options } = setup()
    const requested = log.append(request())!
    const resolved = log.append(outcome(requested.eventId))!
    expect(resolved.payload).toEqual({
      schemaVersion: 1,
      requestId: 'request-1',
      requestEventId: requested.eventId,
      decision: 'denied',
    })
    expect(resolved.seq).toBe('2')
    const restarted = createSessionEventLog(options)
    expect(restarted.append(outcome(requested.eventId))).toBeUndefined()
    expect(restarted.events()).toHaveLength(2)
    expect(() =>
      restarted.append(outcome(requested.eventId, { sourceEventId: 'second-outcome' }))
    ).toThrow()
    expect(restarted.events()).toHaveLength(2)
  })

  test('cannot append structured interactions without the canonical session resolver', () => {
    const { options } = setup()
    const log = createSessionEventLog({ dataDir: options.dataDir, scope })
    expect(() => log.append(request())).toThrow()
    expect(log.events()).toHaveLength(0)
  })

  test('the harness composition supplies the canonical resolver and fences a later takeover', () => {
    const { options, setSession } = setup()
    const authority = createChannelAuthority({
      shellHost: '127.0.0.1:4795',
      shellOrigin: 'http://127.0.0.1:4795',
      authorizeCommand: async () => {},
    })
    const runtime = registerHarnessRuntime({ ...options, authority, persistSession: setSession })
    expect(runtime.events.append(request())).toBeDefined()
    setSession({ ...initialSession, generation: 2 })
    expect(() => runtime.events.append(request({ sourceEventId: 'after-takeover' }))).toThrow()
    expect(runtime.events.events()).toHaveLength(1)
  })

  test('refuses missing/foreign/archived sessions, stale generations, and replaced harness runs before publication', () => {
    for (const session of [
      undefined,
      { ...initialSession, scope: { ...scope, workspaceId: 'foreign' } },
      { ...initialSession, archived: true },
      { ...initialSession, lifecycle: 'completed' as const },
      { ...initialSession, lifecycle: 'cancelled' as const },
      { ...initialSession, lifecycle: 'disconnected' as const },
      { ...initialSession, generation: 2 },
      { ...initialSession, activeHarnessRunId: 'run-2' },
    ]) {
      const { log, setSession } = setup()
      setSession(session)
      const published: unknown[] = []
      log.subscribe(initialSession.id, (event) => published.push(event))
      expect(() => log.append(request())).toThrow()
      expect(log.events()).toHaveLength(0)
      expect(published).toHaveLength(0)
    }
  })

  test('retains optional known actor/time on observed approval, and expiration after completion', () => {
    const { log, setSession } = setup()
    const requested = log.append(request())!
    const known = {
      schemaVersion: 1,
      requestId: 'request-1',
      requestEventId: requested.eventId,
      decision: 'approved',
      actorId: 'owner-1',
      decidedAt: '2026-10-15T05:00:00Z',
    }
    expect(log.append(outcome(requested.eventId, { payload: known }))?.payload).toEqual(known)
    const nextRequest = log.append(
      request({ sourceEventId: 'request-2', payload: { ...payload, requestId: 'request-2' } })
    )!
    setSession({ ...initialSession, lifecycle: 'completed' })
    expect(log.append(request())).toBeUndefined()
    const expired = {
      schemaVersion: 1,
      requestId: 'request-2',
      requestEventId: nextRequest.eventId,
      decision: 'expired',
    }
    expect(
      log.append(
        outcome(nextRequest.eventId, {
          kind: 'approval.expired',
          sourceEventId: 'expired-2',
          payload: expired,
        })
      )?.payload
    ).toEqual(expired)
    expect(log.events()).toHaveLength(4)
  })

  test('separates identical session/request ids across authority scopes', () => {
    const { log, options } = setup()
    const requested = log.append(request())!
    const foreignScope = { ...scope, workspaceId: '00000000-0000-4000-8000-000000000004' }
    const foreignLog = createSessionEventLog({
      ...options,
      scope: foreignScope,
      resolveSession: () => ({ ...initialSession, scope: foreignScope }),
    })
    expect(() => foreignLog.append(outcome(requested.eventId))).toThrow()
    const foreignRequest = foreignLog.append(request())!
    expect(() => log.append(outcome(foreignRequest.eventId))).toThrow()
    expect(log.events()).toHaveLength(1)
    expect(foreignLog.events()).toHaveLength(1)
  })

  test('an event replay cannot silently change its harness binding within a generation', () => {
    const { log, setSession } = setup()
    log.append(request())
    setSession({ ...initialSession, activeHarnessRunId: 'run-2' })
    expect(() => log.append(request({ harnessRunId: 'run-2' }))).toThrow()
    expect(log.events()).toHaveLength(1)
  })

  test('refuses forged eligibility, terminal semantic events, and non-authoritative or public claims', () => {
    const { log } = setup()
    for (const invalid of [
      request({ payload: { ...payload, eligibility: { eligible: true } } }),
      request({ payload: { prompt: 'Legacy', eligibility } }),
      request({ source: 'terminal_fallback' }),
      request({ confidence: 'untrusted_hint' }),
      request({ classification: 'public' }),
      request({ harnessRunId: undefined }),
    ])
      expect(() => log.append(invalid)).toThrow()
    expect(log.events()).toHaveLength(0)
  })

  test('matches request id, canonical event id, interaction kind, source, run, and generation', () => {
    const { log, setSession } = setup()
    const requested = log.append(request())!
    for (const invalid of [
      outcome('unknown-event'),
      outcome(requested.eventId, {
        payload: {
          schemaVersion: 1,
          requestId: 'other-request',
          requestEventId: requested.eventId,
          decision: 'approved',
        },
      }),
      outcome(requested.eventId, { source: 'authenticated_hook' }),
      outcome(requested.eventId, {
        kind: 'question.expired',
        payload: {
          schemaVersion: 1,
          requestId: 'request-1',
          requestEventId: requested.eventId,
          decision: 'expired',
        },
      }),
      request({ sourceEventId: 'same-request-new-event' }),
    ])
      expect(() => log.append(invalid)).toThrow()
    setSession({ ...initialSession, generation: 2 })
    expect(() => log.append(outcome(requested.eventId))).toThrow()
    expect(log.events()).toHaveLength(1)
  })

  test('validates question responses against their retained schema and permits explicit optional skips', () => {
    const { log } = setup()
    const requested = log.append(
      request({
        kind: 'question.requested',
        payload: {
          schemaVersion: 1,
          requestId: 'request-1',
          eligibility,
          questions: [
            {
              id: 'target',
              prompt: 'Which target?',
              kind: 'choice',
              required: true,
              multiple: false,
              options: [{ id: 'web', label: 'Web' }],
            },
            { id: 'notes', prompt: 'Any notes?', kind: 'text', required: false },
          ],
        },
      })
    )!
    const resolution = {
      schemaVersion: 1,
      requestId: 'request-1',
      requestEventId: requested.eventId,
      decision: 'answered',
    }
    expect(() =>
      log.append(
        outcome(requested.eventId, {
          kind: 'question.resolved',
          payload: { ...resolution, answers: [] },
        })
      )
    ).toThrow()
    expect(log.events()).toHaveLength(1)
    const resolved = log.append(
      outcome(requested.eventId, {
        kind: 'question.resolved',
        payload: {
          ...resolution,
          answers: [
            { questionId: 'target', optionIds: ['web'] },
            { questionId: 'notes', skipped: true },
          ],
        },
      })
    )!
    expect(resolved.seq).toBe('2')
  })

  test('expiry has its own decision and cannot close an unretained request', () => {
    const { options } = setup()
    const log = createSessionEventLog({ ...options, maxPerSession: 1 })
    const requested = log.append(request())!
    log.append({
      runtimeSessionId: initialSession.id,
      generation: 1,
      sourceEventId: 'evict-request',
      kind: 'run.ready',
    })
    expect(() =>
      log.append(
        outcome(requested.eventId, {
          kind: 'approval.expired',
          payload: {
            schemaVersion: 1,
            requestId: 'request-1',
            requestEventId: requested.eventId,
            decision: 'expired',
          },
        })
      )
    ).toThrow()
    expect(log.events()).toHaveLength(1)
  })
})

test('session resolver callbacks cannot change the validated interaction that is persisted', () => {
  const { options } = setup()
  const original = structuredClone(payload)
  const log = createSessionEventLog({
    ...options,
    resolveSession: () => {
      original.prompt = 'Changed after admission'
      return initialSession
    },
  })
  const appended = log.append(request({ payload: original }))!
  expect((appended.payload as { prompt: string }).prompt).toBe('Allow this action?')
  expect((log.events()[0]!.payload as { prompt: string }).prompt).toBe('Allow this action?')
  expect(Object.isFrozen(appended)).toBe(true)
  expect(Object.isFrozen(appended.payload)).toBe(true)
  expect(Reflect.set(appended.payload as object, 'prompt', 'Changed through returned alias')).toBe(
    false
  )
  const replayed = createSessionEventLog(options).events()[0]!
  expect((replayed.payload as { prompt: string }).prompt).toBe('Allow this action?')
  expect(Object.isFrozen(replayed.payload)).toBe(true)
})

test('hidden payload serialization hooks are rejected before persistence or invocation', () => {
  const { log } = setup()
  const original = structuredClone(payload)
  let invoked = 0
  Object.defineProperty(original, 'toJSON', {
    value: () => {
      invoked += 1
      return { forged: true }
    },
  })
  expect(() => log.append(request({ payload: original }))).toThrow()
  expect(invoked).toBe(0)
  expect(log.events()).toHaveLength(0)
})
