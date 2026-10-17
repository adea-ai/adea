import {
  exactKeys,
  fail,
  literal,
  record,
  stringValue,
  timestamp,
} from './dev-runtime-validation-internal'

export const runtimeInteractionKinds = [
  'approval.requested',
  'approval.resolved',
  'approval.expired',
  'question.requested',
  'question.resolved',
  'question.expired',
] as const
export type RuntimeInteractionKind = (typeof runtimeInteractionKinds)[number]

/** A host fact, never permission inferred from a request or a callback's presence.
 * Positive eligibility requires the still-unavailable M11 response command. */
export type RuntimeResponseEligibility = Readonly<{
  eligible: false
  reason: 'response_unavailable'
}>
export type RuntimeQuestionOption = Readonly<{ id: string; label: string; description?: string }>
export type RuntimeQuestion = Readonly<{ id: string; prompt: string; required: boolean }> &
  (
    | Readonly<{ kind: 'text' }>
    | Readonly<{
        kind: 'choice'
        multiple: boolean
        options: readonly RuntimeQuestionOption[]
      }>
  )
export type RuntimeQuestionAnswer = Readonly<{ questionId: string }> &
  (
    | Readonly<{ text: string }>
    | Readonly<{ optionIds: readonly string[] }>
    | Readonly<{ skipped: true }>
  )
type Request = Readonly<{
  schemaVersion: 1
  requestId: string
  eligibility: RuntimeResponseEligibility
}>
export type RuntimeQuestionRequest = Request & Readonly<{ questions: readonly RuntimeQuestion[] }>
export type RuntimeApprovalRequest = Request & Readonly<{ prompt: string }>
type Outcome = Readonly<{
  schemaVersion: 1
  requestId: string
  /** The canonical event id, distinct from the source protocol's request id. */
  requestEventId: string
  actorId?: string
  decidedAt?: string
}>
export type RuntimeApprovalResolution = Outcome & Readonly<{ decision: 'approved' | 'denied' }>
export type RuntimeQuestionResolution = Outcome &
  Readonly<{
    decision: 'answered'
    answers: readonly RuntimeQuestionAnswer[]
  }>
export type RuntimeInteractionExpiry = Outcome & Readonly<{ decision: 'expired' }>
export type RuntimeInteractionPayload =
  | RuntimeApprovalRequest
  | RuntimeQuestionRequest
  | RuntimeApprovalResolution
  | RuntimeQuestionResolution
  | RuntimeInteractionExpiry

function boundedArray(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail(path, `expected array length ${min}..${max}`)
  return value
}

function id(value: unknown, path: string): string {
  const text = stringValue(value, path, 1, 256)
  if (!text.trim()) fail(path, 'expected nonblank id')
  return text
}

function unique(value: string, seen: Set<string>, path: string): void {
  if (seen.has(value)) fail(path, 'duplicate id')
  seen.add(value)
}

function validateQuestion(value: unknown, path: string): void {
  const item = record(value, path)
  literal(item.kind, ['text', 'choice'], `${path}.kind`)
  exactKeys(
    item,
    [
      'id',
      'prompt',
      'required',
      'kind',
      ...(item.kind === 'choice' ? ['multiple', 'options'] : []),
    ],
    [],
    path
  )
  id(item.id, `${path}.id`)
  stringValue(item.prompt, `${path}.prompt`, 1, 4096)
  if (typeof item.required !== 'boolean') fail(`${path}.required`, 'expected boolean')
  if (item.kind === 'text') return
  if (typeof item.multiple !== 'boolean') fail(`${path}.multiple`, 'expected boolean')
  const optionIds = new Set<string>()
  boundedArray(item.options, `${path}.options`, 1, 32).forEach((entry, index) => {
    const optionPath = `${path}.options[${index}]`
    const option = record(entry, optionPath)
    exactKeys(option, ['id', 'label'], ['description'], optionPath)
    unique(id(option.id, `${optionPath}.id`), optionIds, optionPath)
    stringValue(option.label, `${optionPath}.label`, 1, 512)
    if (option.description !== undefined)
      stringValue(option.description, `${optionPath}.description`, 1, 2048)
  })
}

/** Copy bounded data descriptors before validation; getters/toJSON never execute. */
function interactionSnapshot(value: unknown): unknown {
  let nodes = 0
  let units = 0
  const seen = new Set<object>()
  const copy = (entry: unknown, path: string, depth: number): unknown => {
    if (++nodes > 8192 || depth > 8) fail(path, 'interaction snapshot bounds exceeded')
    if (typeof entry === 'string') {
      units += entry.length
      if (entry.length > 65_536 || units > 256 * 1024)
        fail(path, 'interaction snapshot string bounds exceeded')
      return entry
    }
    if (entry === null || typeof entry === 'boolean') return entry
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry
    if (typeof entry !== 'object' || entry === null) fail(path, 'expected JSON data')
    if (seen.has(entry)) fail(path, 'cyclic interaction payload')
    const array = Array.isArray(entry)
    if (array) {
      if (Object.getPrototypeOf(entry) !== Array.prototype || entry.length > 32)
        fail(path, 'expected bounded plain array')
    } else record(entry, path)
    if ('toJSON' in entry) fail(path, 'serialization hooks are not interaction data')
    const keys = Reflect.ownKeys(entry)
    if (keys.length > 33) fail(path, 'interaction property bounds exceeded')
    const values = new Map<string, unknown>()
    for (const key of keys) {
      if (typeof key !== 'string') fail(path, 'symbol properties are not interaction data')
      const descriptor = Object.getOwnPropertyDescriptor(entry, key)!
      if (array && key === 'length') continue
      if (!descriptor.enumerable || !('value' in descriptor))
        fail(path, 'expected enumerable data properties')
      if (key.length > 256) fail(path, 'interaction key bounds exceeded')
      values.set(key, descriptor.value)
    }
    seen.add(entry)
    try {
      if (array) {
        if (values.size !== entry.length)
          fail(path, 'expected dense array without extra properties')
        const result: unknown[] = []
        for (let index = 0; index < entry.length; index += 1) {
          if (!values.has(String(index))) fail(path, 'expected dense array')
          result.push(copy(values.get(String(index)), `${path}[${index}]`, depth + 1))
        }
        return Object.freeze(result)
      }
      // No inherited fields or serialization hooks can survive the snapshot.
      const result: Record<string, unknown> = Object.create(null)
      for (const [key, child] of values) result[key] = copy(child, `${path}.${key}`, depth + 1)
      return Object.freeze(result)
    } finally {
      seen.delete(entry)
    }
  }
  const snapshot = copy(value, 'interaction', 0)
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 256 * 1024)
    fail('interaction', 'maximum encoded payload size exceeded')
  return snapshot
}

/** Legacy interactions deliberately return undefined, never a guessed decision.
 * This validates the wire shape; the host event log owns scope/correlation checks. */
export function decodeRuntimeInteractionPayload(
  kind: string,
  value: unknown
): RuntimeInteractionPayload | undefined {
  if (!(runtimeInteractionKinds as readonly string[]).includes(kind)) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = record(value, 'interaction')
  const version = Object.getOwnPropertyDescriptor(source, 'schemaVersion')
  if (!version) {
    if ('eligibility' in source) fail('interaction.eligibility', 'requires a versioned host fact')
    return undefined
  }
  if (!version.enumerable || !('value' in version))
    fail('interaction.schemaVersion', 'expected enumerable data property')
  const item = record(interactionSnapshot(source), 'interaction')
  if (item.schemaVersion !== 1) fail('interaction.schemaVersion', 'expected 1')
  id(item.requestId, 'interaction.requestId')
  if (kind.endsWith('.requested')) {
    const question = kind === 'question.requested'
    exactKeys(
      item,
      ['schemaVersion', 'requestId', 'eligibility', question ? 'questions' : 'prompt'],
      [],
      'interaction'
    )
    const eligibility = record(item.eligibility, 'interaction.eligibility')
    exactKeys(eligibility, ['eligible', 'reason'], [], 'interaction.eligibility')
    literal(eligibility.eligible, [false], 'interaction.eligibility.eligible')
    literal(eligibility.reason, ['response_unavailable'], 'interaction.eligibility.reason')
    if (question) {
      const questionIds = new Set<string>()
      boundedArray(item.questions, 'interaction.questions', 1, 32).forEach((entry, index) => {
        const path = `interaction.questions[${index}]`
        validateQuestion(entry, path)
        unique((entry as RuntimeQuestion).id, questionIds, path)
      })
    } else stringValue(item.prompt, 'interaction.prompt', 1, 4096)
  } else {
    const answered = kind === 'question.resolved'
    exactKeys(
      item,
      [
        'schemaVersion',
        'requestId',
        'requestEventId',
        'decision',
        ...(answered ? ['answers'] : []),
      ],
      ['actorId', 'decidedAt'],
      'interaction'
    )
    id(item.requestEventId, 'interaction.requestEventId')
    literal(
      item.decision,
      kind.endsWith('.expired') ? ['expired'] : answered ? ['answered'] : ['approved', 'denied'],
      'interaction.decision'
    )
    if (item.actorId !== undefined) id(item.actorId, 'interaction.actorId')
    if (item.decidedAt !== undefined) timestamp(item.decidedAt, 'interaction.decidedAt')
    if (answered) validateAnswers(item.answers)
  }
  return item as RuntimeInteractionPayload
}

function validateAnswers(value: unknown): void {
  const questionIds = new Set<string>()
  boundedArray(value, 'interaction.answers', 0, 32).forEach((entry, index) => {
    const path = `interaction.answers[${index}]`
    const answer = record(entry, path)
    const fields = ['text', 'optionIds', 'skipped'].filter((key) => key in answer)
    if (fields.length !== 1) fail(path, 'expected exactly one answer form')
    exactKeys(answer, ['questionId', fields[0]!], [], path)
    unique(id(answer.questionId, `${path}.questionId`), questionIds, path)
    if ('text' in answer) stringValue(answer.text, `${path}.text`, 1, 65_536)
    if ('skipped' in answer) literal(answer.skipped, [true], `${path}.skipped`)
    if ('optionIds' in answer) {
      const optionIds = new Set<string>()
      boundedArray(answer.optionIds, `${path}.optionIds`, 1, 32).forEach((optionId) => {
        unique(id(optionId, `${path}.optionIds`), optionIds, `${path}.optionIds`)
      })
    }
  })
}

/** Validates answers against the exact retained request, not a renderer's copy. */
export function validateRuntimeQuestionAnswers(request: unknown, outcome: unknown): void {
  const requested = decodeRuntimeInteractionPayload('question.requested', request) as
    | RuntimeQuestionRequest
    | undefined
  const resolved = decodeRuntimeInteractionPayload('question.resolved', outcome) as
    | RuntimeQuestionResolution
    | undefined
  if (!requested || !resolved) fail('interaction', 'structured request and outcome required')
  if (requested.requestId !== resolved.requestId)
    fail('interaction.requestId', 'does not match request')
  const answers = new Map(resolved.answers.map((answer) => [answer.questionId, answer]))
  for (const question of requested.questions) {
    const answer = answers.get(question.id)
    if (!answer || 'skipped' in answer) {
      if (question.required) fail('interaction.answers', 'required question is unanswered')
    } else if (question.kind === 'text') {
      if (!('text' in answer)) fail('interaction.answers', 'expected text answer')
    } else {
      if (!('optionIds' in answer)) fail('interaction.answers', 'expected choice answer')
      if (!question.multiple && answer.optionIds.length !== 1)
        fail('interaction.answers', 'expected single choice')
      if (
        answer.optionIds.some(
          (optionId) => !question.options.some((option) => option.id === optionId)
        )
      )
        fail('interaction.answers', 'unknown option id')
    }
    answers.delete(question.id)
  }
  if (answers.size) fail('interaction.answers', 'unknown question id')
}
