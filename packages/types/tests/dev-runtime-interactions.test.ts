import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  decodeRuntimeEnvelope,
  decodeRuntimeEvent,
  encodeCbor,
  RUNTIME_EVENT_CBOR_BYTES_MAX,
  validateRuntimeEventReplayCandidate,
} from '../src/dev-runtime-wire'
import {
  assertRuntimeEventFrameSize as publicAssertRuntimeEventFrameSize,
  RUNTIME_EVENT_CBOR_BYTES_MAX as publicRuntimeEventCborBytesMax,
} from '../src/dev-runtime'
import {
  decodeRuntimeInteractionPayload,
  validateRuntimeQuestionAnswers,
} from '../src/dev-runtime-interactions'

const eligibility = { eligible: false, reason: 'response_unavailable' } as const
const questions = [
  {
    id: 'target',
    prompt: 'Which target?',
    required: true,
    kind: 'choice',
    multiple: false,
    options: [
      { id: 'web', label: 'Web' },
      { id: 'desktop', label: 'Desktop' },
    ],
  },
  { id: 'notes', prompt: 'Any notes?', required: false, kind: 'text' },
] as const
const requested = { schemaVersion: 1, requestId: 'request-1', questions, eligibility } as const
const resolved = {
  schemaVersion: 1,
  requestId: 'request-1',
  requestEventId: 'event-1',
  decision: 'answered',
  answers: [{ questionId: 'target', optionIds: ['web'] }],
} as const

describe('versioned runtime interaction payloads', () => {
  test('exposes the shared runtime event frame bound through the public runtime barrel', () => {
    expect(publicRuntimeEventCborBytesMax).toBe(RUNTIME_EVENT_CBOR_BYTES_MAX)
    expect(publicAssertRuntimeEventFrameSize).toBeDefined()
  })

  test('decodes multiple questions, optional text, and bounded labelled options', () => {
    expect(decodeRuntimeInteractionPayload('question.requested', requested)).toEqual(requested)
    expect(decodeRuntimeInteractionPayload('question.resolved', resolved)).toEqual(resolved)
    expect(() => validateRuntimeQuestionAnswers(requested, resolved)).not.toThrow()
  })

  test('retains legacy payloads as opaque, with no structured eligibility claim', () => {
    for (const payload of ['Which target?', { text: 'Which target?' }, null])
      expect(decodeRuntimeInteractionPayload('question.requested', payload)).toBeUndefined()
    expect(
      decodeRuntimeInteractionPayload('turn.assistant_message', { schemaVersion: 2 })
    ).toBeUndefined()
    expect(() => decodeRuntimeInteractionPayload('question.requested', { eligibility })).toThrow()
  })

  test('requires known versions, exact keys, unique question and option ids, and real booleans', () => {
    for (const payload of [
      { ...requested, schemaVersion: 2 },
      { ...requested, trusted: true },
      { ...requested, requestId: '' },
      { ...requested, questions: [] },
      { ...requested, questions: Array(33).fill(questions[0]) },
      { ...requested, questions: [questions[0], questions[0]] },
      { ...requested, questions: [{ ...questions[0], required: 'yes' }] },
      { ...requested, questions: [{ ...questions[0], options: [] }] },
      {
        ...requested,
        questions: [
          { ...questions[0], options: [questions[0].options[0], questions[0].options[0]] },
        ],
      },
      { ...requested, questions: [{ ...questions[1], options: [] }] },
      { ...requested, eligibility: { eligible: true } },
      { ...requested, eligibility: { ...eligibility, inputOwner: 'forged' } },
    ])
      expect(() => decodeRuntimeInteractionPayload('question.requested', payload)).toThrow()
  })

  test('requires correlation and a kind-specific decision; unknown actor and time stay absent', () => {
    const outcome = {
      schemaVersion: 1,
      requestId: 'request-1',
      requestEventId: 'event-1',
      decision: 'denied',
    }
    expect(decodeRuntimeInteractionPayload('approval.resolved', outcome)).toEqual(outcome)
    expect(
      decodeRuntimeInteractionPayload('approval.resolved', {
        ...outcome,
        actorId: 'owner-1',
        decidedAt: '2026-10-15T05:00:00.000Z',
      })
    ).toMatchObject({ actorId: 'owner-1' })
    expect(
      decodeRuntimeInteractionPayload('approval.expired', { ...outcome, decision: 'expired' })
    ).toBeDefined()
    for (const invalid of [
      { ...outcome, requestEventId: undefined },
      { ...outcome, requestId: '' },
      { ...outcome, decision: 'answered' },
      { ...outcome, actorId: '' },
      { ...outcome, decidedAt: '2026-02-30T00:00:00Z' },
      { ...outcome, approved: true },
    ])
      expect(() => decodeRuntimeInteractionPayload('approval.resolved', invalid)).toThrow()
    expect(() => decodeRuntimeInteractionPayload('approval.expired', outcome)).toThrow()
    expect(() =>
      decodeRuntimeInteractionPayload('question.expired', { ...outcome, decision: 'approved' })
    ).toThrow()
  })

  test('validates required answers, optional skips, option membership, and choice multiplicity', () => {
    for (const answers of [
      [],
      [{ questionId: 'notes', text: 'Only notes' }],
      [{ questionId: 'target', skipped: true }],
      [{ questionId: 'target', optionIds: ['unknown'] }],
      [{ questionId: 'target', optionIds: ['web', 'desktop'] }],
      [{ questionId: 'target', optionIds: ['web', 'web'] }],
      [{ questionId: 'target', text: 'web' }],
      [{ questionId: 'foreign', text: 'value' }],
    ])
      expect(() => validateRuntimeQuestionAnswers(requested, { ...resolved, answers })).toThrow()
    expect(() =>
      validateRuntimeQuestionAnswers(requested, {
        ...resolved,
        answers: [...resolved.answers, { questionId: 'notes', skipped: true }],
      })
    ).not.toThrow()
    expect(() =>
      validateRuntimeQuestionAnswers(
        {
          ...requested,
          questions: [{ ...questions[0], multiple: true }],
        },
        { ...resolved, answers: [{ questionId: 'target', optionIds: ['web', 'desktop'] }] }
      )
    ).not.toThrow()
  })

  test('the canonical event decoder enforces versioned payloads and authoritative provenance', () => {
    const event = {
      schemaVersion: 1,
      eventId: 'event-1',
      runtimeSessionId: 'session-1',
      harnessRunId: 'run-1',
      generation: 1,
      seq: '1',
      occurredAt: '2026-10-15T05:00:00Z',
      receivedAt: '2026-10-15T05:00:01Z',
      source: 'native',
      sourceEventId: 'native-1',
      confidence: 'authoritative',
      classification: 'workspace_private',
      kind: 'question.requested',
      payload: requested,
    } as const
    expect(decodeRuntimeEvent(event, { source: 'native' })).toEqual(event)
    expect(() =>
      decodeRuntimeEvent(
        { ...event, payload: { ...requested, eligibility: { eligible: true } } },
        { source: 'native' }
      )
    ).toThrow()
    expect(() =>
      decodeRuntimeEvent({ ...event, confidence: 'untrusted_hint' }, { source: 'native' })
    ).toThrow()
    expect(() =>
      decodeRuntimeEvent({ ...event, classification: 'public' }, { source: 'native' })
    ).toThrow()
    expect(() =>
      decodeRuntimeEvent({ ...event, harnessRunId: undefined }, { source: 'native' })
    ).toThrow()
  })

  test('bounds the whole canonical-CBOR interaction event, including UTF-8 and envelope bytes', () => {
    const event = {
      schemaVersion: 1,
      eventId: 'event-2',
      runtimeSessionId: 'session-1',
      harnessRunId: 'run-1',
      generation: 1,
      seq: '2',
      occurredAt: '2026-10-15T05:00:00Z',
      receivedAt: '2026-10-15T05:00:01Z',
      source: 'native',
      sourceEventId: 'native-2',
      confidence: 'authoritative',
      classification: 'workspace_private',
      kind: 'question.resolved',
      payload: {
        ...resolved,
        answers: [{ questionId: 'notes', text: '' }],
      },
    } as const
    const exactFit = {
      ...event,
      payload: {
        ...event.payload,
        answers: [{ questionId: 'notes', text: 'a'.repeat(65_138) }],
      },
    }
    expect(encodeCbor(exactFit).byteLength).toBe(RUNTIME_EVENT_CBOR_BYTES_MAX)
    expect(decodeRuntimeEvent(exactFit, { source: 'native' })).toEqual(exactFit)

    const answers = [
      'a'.repeat(65_139),
      'a'.repeat(65_500),
      'a'.repeat(65_536),
      '🧪'.repeat(20_000),
    ]
    for (const text of answers) {
      const candidate = {
        ...event,
        payload: {
          ...event.payload,
          answers: [{ questionId: 'notes', text }],
        },
      }
      expect(text.length).toBeLessThanOrEqual(65_536)
      expect(encodeCbor(candidate).byteLength).toBeGreaterThan(RUNTIME_EVENT_CBOR_BYTES_MAX)
      expect(() =>
        validateRuntimeEventReplayCandidate(candidate, { source: 'native' })
      ).not.toThrow()
      expect(() => decodeRuntimeEvent(candidate, { source: 'native' })).toThrow()
    }
  })
})

describe('interaction validators stay out of the lean browser decoder', () => {
  const envelope = {
    schemaVersion: 1,
    eventId: 'event-1',
    runtimeSessionId: 'session-1',
    harnessRunId: 'run-1',
    generation: 1,
    seq: '1',
    occurredAt: '2026-10-15T05:00:00.000Z',
    receivedAt: '2026-10-15T05:00:01.000Z',
    source: 'native',
    sourceEventId: 'source-1',
    confidence: 'authoritative',
    classification: 'workspace_private',
    kind: 'question.requested',
    payload: { schemaVersion: 1, requestId: 'request-1', questions: [], eligibility },
  }

  test('only the complete decoder interprets a versioned interaction payload', () => {
    expect(() => decodeRuntimeEvent(envelope, { source: 'native' })).toThrow('questions')
    expect(decodeRuntimeEnvelope(envelope, { source: 'native' })).toBe(envelope)
    const lowConfidence = { ...envelope, payload: requested, confidence: 'untrusted_hint' }
    expect(() => decodeRuntimeEvent(lowConfidence, { source: 'native' })).toThrow('authoritative')
    expect(decodeRuntimeEnvelope(lowConfidence, { source: 'native' })).toBe(lowConfidence)
  })

  test('the browser entry bundle excludes the interaction validators', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-interactions-'))
    try {
      const entry = join(directory, 'entry.ts')
      writeFileSync(
        entry,
        `import { decodeRuntimeEnvelope } from ${JSON.stringify(
          resolve(import.meta.dir, '../src/dev-runtime-wire.ts')
        )}\nglobalThis.lean = [decodeRuntimeEnvelope]\n`
      )
      const result = await Bun.build({ entrypoints: [entry], minify: true, target: 'browser' })
      expect(result.success).toBe(true)
      const text = await result.outputs[0]!.text()
      for (const marker of [
        'structured interactions require',
        'requires a versioned host fact',
        'required question is unanswered',
        'response_unavailable',
      ])
        expect(text).not.toContain(marker)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('inert interaction snapshots', () => {
  test('caller aliases cannot change nested validated facts', () => {
    const input = {
      schemaVersion: 1,
      requestId: 'request-1',
      eligibility: { eligible: false, reason: 'response_unavailable' },
      questions: [
        {
          id: 'target',
          prompt: 'Which?',
          required: true,
          kind: 'choice',
          multiple: false,
          options: [{ id: 'web', label: 'Web' }],
        },
      ],
    }
    const snapshot = decodeRuntimeInteractionPayload('question.requested', input)
    const serialized = JSON.stringify(snapshot)
    input.questions[0]!.options[0]!.label = 'Changed after validation'
    input.eligibility.eligible = true
    expect(JSON.stringify(snapshot)).toBe(serialized)
    expect(snapshot).not.toBe(input)
    expect(Object.isFrozen(snapshot)).toBe(true)
    const copied = snapshot as {
      questions: readonly { options: readonly unknown[] }[]
      eligibility: object
    }
    expect(Object.isFrozen(copied.questions)).toBe(true)
    expect(Object.isFrozen(copied.questions[0])).toBe(true)
    expect(Object.isFrozen(copied.questions[0]!.options[0])).toBe(true)
    expect(Object.isFrozen(copied.eligibility)).toBe(true)
  })

  test('rejects non-enumerable serialization hooks on every nesting level without invoking them', () => {
    for (const target of ['root', 'eligibility', 'questions', 'question', 'options', 'option']) {
      const input = structuredClone(requested)
      const choice = input.questions[0]!
      const object =
        target === 'root'
          ? input
          : target === 'eligibility'
            ? input.eligibility
            : target === 'questions'
              ? input.questions
              : target === 'question'
                ? choice
                : target === 'options'
                  ? choice.options
                  : choice.options[0]!
      let invoked = 0
      Object.defineProperty(object, 'toJSON', {
        value: () => {
          invoked += 1
          return {}
        },
      })
      expect(() => decodeRuntimeInteractionPayload('question.requested', input)).toThrow()
      expect(invoked).toBe(0)
    }
  })

  test('rejects accessors without reading them', () => {
    for (const target of ['root', 'question', 'option', 'array']) {
      const input = structuredClone(requested)
      const choice = input.questions[0]!
      let reads = 0
      const object =
        target === 'root'
          ? input
          : target === 'question'
            ? choice
            : target === 'option'
              ? choice.options[0]!
              : choice.options
      const key =
        target === 'root'
          ? 'requestId'
          : target === 'question'
            ? 'prompt'
            : target === 'option'
              ? 'label'
              : '0'
      const value = Object.getOwnPropertyDescriptor(object, key)!.value
      Object.defineProperty(object, key, {
        enumerable: true,
        get: () => {
          reads += 1
          return value
        },
      })
      expect(() => decodeRuntimeInteractionPayload('question.requested', input)).toThrow()
      expect(reads).toBe(0)
    }
  })
})

test('legacy objects cannot smuggle structured facts through serialization hooks', () => {
  for (const value of [{ text: 'opaque' }, ['opaque']]) {
    let invoked = 0
    Object.defineProperty(value, 'toJSON', {
      value: () => {
        invoked += 1
        return requested
      },
    })
    expect(() => decodeRuntimeInteractionPayload('question.requested', value)).toThrow()
    expect(invoked).toBe(0)
  }
})

test('ordinary legacy JSON retains generic array/object bounds and stays opaque', () => {
  for (const value of [
    Array(64).fill('opaque'),
    Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`field-${i}`, i])),
  ])
    expect(decodeRuntimeInteractionPayload('question.requested', value)).toBeUndefined()
})
