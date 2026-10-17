import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RuntimeSession, Scope } from '../../../packages/types/src/dev-runtime'
import {
  encodeCbor,
  RUNTIME_EVENT_CBOR_BYTES_MAX,
} from '../../../packages/types/src/dev-runtime-wire'
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

  test('source-event identity compares tuple fields even when fields contain NUL', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-interaction-tuple-'))
    dirs.push(dataDir)
    const firstSession: RuntimeSession = { ...initialSession, id: 'collision' }
    const secondSession: RuntimeSession = {
      ...initialSession,
      id: 'collision\u00001\u0000native',
    }
    const sessions = new Map([
      [firstSession.id, firstSession],
      [secondSession.id, secondSession],
    ])
    const log = createSessionEventLog({
      dataDir,
      scope,
      resolveSession: (id) => sessions.get(id),
    })

    const first = log.append(
      request({
        runtimeSessionId: firstSession.id,
        sourceEventId: '1\u0000native\u0000tail',
      })
    )!
    const second = log.append(
      request({
        runtimeSessionId: secondSession.id,
        sourceEventId: 'tail',
      })
    )!

    expect(second.runtimeSessionId).toBe(secondSession.id)
    expect(second.seq).toBe('1')
    expect(second.eventId).not.toBe(first.eventId)
    expect(log.events()).toHaveLength(2)
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

  test('rejects oversized whole-event CBOR before persistence/publication or sequence consumption', () => {
    const oversizedAnswers = [
      'a'.repeat(65_536),
      'a'.repeat(65_139),
      'a'.repeat(65_500),
      '🧪'.repeat(20_000),
    ]
    for (const text of oversizedAnswers) {
      const { log } = setup()
      const requested = log.append(
        request({
          kind: 'question.requested',
          payload: {
            schemaVersion: 1,
            requestId: 'request-1',
            eligibility,
            questions: [{ id: 'notes', prompt: 'Any notes?', required: false, kind: 'text' }],
          },
        })
      )!
      const published: unknown[] = []
      log.subscribe(initialSession.id, (event) => published.push(event))
      expect(() =>
        log.append(
          outcome(requested.eventId, {
            kind: 'question.resolved',
            sourceEventId: 'oversized-response',
            payload: {
              schemaVersion: 1,
              requestId: 'request-1',
              requestEventId: requested.eventId,
              decision: 'answered',
              answers: [{ questionId: 'notes', text }],
            },
          })
        )
      ).toThrow()
      expect(log.events()).toHaveLength(1)
      expect(published).toHaveLength(0)
      expect(
        log.append(
          outcome(requested.eventId, {
            kind: 'question.resolved',
            sourceEventId: 'valid-response',
            payload: {
              schemaVersion: 1,
              requestId: 'request-1',
              requestEventId: requested.eventId,
              decision: 'answered',
              answers: [{ questionId: 'notes', text: 'ok' }],
            },
          })
        )?.seq
      ).toBe('2')
      expect(published).toHaveLength(1)
    }
  })

  test('an exact-fit retry at sequence 9 is checked against its retained envelope', () => {
    const { log } = setup()
    const occurredAt = '2026-10-15T05:00:00.000Z'
    const requested = log.append(
      request({
        kind: 'question.requested',
        sourceEventId: 'exact-fit-request',
        occurredAt,
        payload: {
          schemaVersion: 1,
          requestId: 'request-1',
          eligibility,
          questions: [{ id: 'notes', prompt: 'Any notes?', required: false, kind: 'text' }],
        },
      })
    )!
    for (let seq = 2; seq <= 8; seq += 1)
      log.append({
        runtimeSessionId: initialSession.id,
        generation: 1,
        sourceEventId: `sequence-padding-${seq}`,
        kind: 'run.ready',
        occurredAt,
      })
    expect(log.latestSequence(initialSession.id)).toBe('8')

    const envelope = {
      schemaVersion: 1,
      eventId: '00000000-0000-4000-8000-000000000000',
      runtimeSessionId: initialSession.id,
      harnessRunId: 'run-1',
      generation: 1,
      seq: '9',
      occurredAt,
      receivedAt: occurredAt,
      source: 'native',
      sourceEventId: 'exact-fit-outcome',
      confidence: 'authoritative',
      classification: 'workspace_private',
      kind: 'question.resolved',
      payload: {
        schemaVersion: 1,
        requestId: 'request-1',
        requestEventId: requested.eventId,
        decision: 'answered',
        answers: [{ questionId: 'notes', text: '' }],
      },
    } as const
    const exactTextLength = RUNTIME_EVENT_CBOR_BYTES_MAX - encodeCbor(envelope).byteLength - 2
    const exactPayload = {
      ...envelope.payload,
      answers: [{ questionId: 'notes', text: 'a'.repeat(exactTextLength) }],
    }
    expect(encodeCbor({ ...envelope, payload: exactPayload }).byteLength).toBe(
      RUNTIME_EVENT_CBOR_BYTES_MAX
    )

    const exactInput = outcome(requested.eventId, {
      kind: 'question.resolved',
      sourceEventId: envelope.sourceEventId,
      occurredAt,
      payload: exactPayload,
    })
    const published: unknown[] = []
    log.subscribe(initialSession.id, (event) => published.push(event))
    const accepted = log.append(exactInput)!
    expect(accepted.seq).toBe('9')
    expect(encodeCbor(accepted).byteLength).toBe(RUNTIME_EVENT_CBOR_BYTES_MAX)
    expect(encodeCbor({ ...accepted, seq: '10' }).byteLength).toBe(RUNTIME_EVENT_CBOR_BYTES_MAX + 1)
    expect(log.append(exactInput)).toBeUndefined()
    expect(log.latestSequence(initialSession.id)).toBe('9')
    expect(log.events()).toHaveLength(9)
    expect(published).toHaveLength(1)

    expect(() =>
      log.append({
        ...exactInput,
        payload: {
          ...exactPayload,
          answers: [{ questionId: 'notes', text: 'changed retry' }],
        },
      })
    ).toThrow()
    for (const changedMetadata of [
      { ...exactInput, harnessRunId: 'run-2' },
      { ...exactInput, confidence: 'bounded_projection' as const },
      { ...exactInput, classification: 'workspace_metadata' as const },
    ])
      expect(() => log.append(changedMetadata)).toThrow()
    expect(() =>
      log.append({
        ...exactInput,
        source: 'acp',
        payload: {
          ...exactPayload,
          answers: [{ questionId: 'notes', text: 'small changed source' }],
        },
      })
    ).toThrow()
    expect(log.events()).toHaveLength(9)
    expect(published).toHaveLength(1)
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
