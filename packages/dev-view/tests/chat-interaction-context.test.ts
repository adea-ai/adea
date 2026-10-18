import { expect, test } from 'bun:test'
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'
import { approvalDetails, interactionContextDisabledReason } from '../src/chat/model/approval'
import { projectTranscriptEvents } from '../src/chat/presentation'
import { decodeRuntimeEvent } from '@adea-ai/types/dev-runtime-wire'
import { groundedEvents, longApprovalEvents } from '../src/chat/visual-fixture-data'

function project(kind: RuntimeEvent['kind'], payload: unknown) {
  return projectTranscriptEvents([{ ...longApprovalEvents[1]!, kind, payload }])[0]!
}

test('approval beyond 4096 is explicitly incomplete and cannot be approved', () => {
  const decisive = 'Do not delete the archive.'
  const item = project('approval.requested', { text: `${'x'.repeat(4097)}${decisive}` })
  expect(item.requestContext?.length).toBe(4096)
  expect(item.requestContextIncomplete).toBe(true)
  expect(approvalDetails(item.requestContext, item.requestContextIncomplete)?.title).toContain(
    'incomplete'
  )
  expect(interactionContextDisabledReason(item)).toContain(
    'Complete request context is unavailable'
  )
})

test('complete bounded approval details preserve wording after the summary limit', () => {
  const text = `${'Read this condition. '.repeat(80)}\n\tKeep the archive.`
  const item = project('approval.requested', { text })
  expect(item.requestContext).toBe(text)
  expect(approvalDetails(item.requestContext)?.code).toBe(text)
  expect(interactionContextDisabledReason(item)).toBeUndefined()
})

test('long question wording outranks text and survives the 160-character label limit', () => {
  const question = `${'Consider the available options. '.repeat(25)}Which archive must remain?`
  const item = project('question.requested', { question, text: 'An incidental summary.' })
  expect(item.label.length).toBeLessThanOrEqual(160)
  expect(item.requestContext).toBe(question)
  expect(interactionContextDisabledReason(item)).toBeUndefined()
  expect(project('question.requested', { question }).requestContext).toBe(question)
})

test('question context beyond the bound or missing context cannot be answered', () => {
  expect(
    interactionContextDisabledReason(project('question.requested', { question: 'x'.repeat(5000) }))
  ).toBeDefined()
  expect(interactionContextDisabledReason(project('question.requested', {}))).toBeDefined()
})

test('copyable multiline tool output preserves exact safe LF/tab layout', () => {
  const text = '\tfirst line\nsecond\tcolumn\n'
  const item = project('tool.completed', { name: 'Read output', text })
  expect(item.output).toBe(text)
  expect(item.text).not.toBe(text)
})

test('copyable output and request context retain redaction and existing bounds', () => {
  const text = `first\n\tsk-supersecretvalue1234\n/Users/example/private\n${'x'.repeat(5000)}`
  for (const kind of ['tool.completed', 'approval.requested'] as const) {
    const item = project(kind, { text })
    const safe = kind === 'tool.completed' ? item.output! : item.requestContext!
    expect(safe.length).toBeLessThanOrEqual(4096)
    expect(safe).not.toContain('supersecretvalue1234')
    expect(safe).not.toContain('/Users/example/private')
    expect(safe).toContain('[secret redacted]')
    expect(safe).toContain('\n\t')
  }
})

test('a direct request prompt outranks incidental text', () => {
  const item = project('approval.requested', { prompt: 'Keep the archive.', text: 'Summary' })
  expect(item.requestContext).toBe('Keep the archive.')
  expect(interactionContextDisabledReason(item)).toBeUndefined()
})

test('the grounded browser fixture meets the current cited-response wire contract', () => {
  const answer = groundedEvents.find((event) => event.kind === 'turn.assistant_message')!
  expect(() => decodeRuntimeEvent(answer, { source: answer.source })).not.toThrow()
  expect(projectTranscriptEvents([answer])[0]?.references?.sources).toHaveLength(2)
})

test('context made empty by safe control removal cannot be approved', () => {
  expect(
    interactionContextDisabledReason(project('approval.requested', { text: '\u0001\u0002' }))
  ).toBeDefined()
})

for (const kind of ['approval.requested', 'question.requested'] as const) {
  const key = kind === 'approval.requested' ? 'prompt' : 'question'
  test(`${kind}: redaction expansion cannot hide an instruction while enabling a response`, () => {
    const raw = `${'Bearer a '.repeat(400)}Do not delete the archive.`
    expect(raw.length).toBeLessThan(4096)
    const item = project(kind, { [key]: raw })
    expect(item.requestContext?.length).toBe(4096)
    expect(item.requestContext).not.toContain('Do not delete the archive.')
    expect(item.requestContext).toContain('[secret redacted]')
    expect(item.requestContextIncomplete).toBe(true)
    expect(interactionContextDisabledReason(item)).toBeDefined()
    expect(approvalDetails(item.requestContext, item.requestContextIncomplete)?.title).toContain(
      'incomplete'
    )
  })

  test(`${kind}: exact sanitized boundary is complete; one more visible point is fenced`, () => {
    const expandedPrefix = 'Bearer [secret redacted] '
    const raw = `Bearer a ${'x'.repeat(4096 - expandedPrefix.length)}`
    const complete = project(kind, { [key]: `${raw}\u0001` })
    expect(complete.requestContext?.length).toBe(4096)
    expect(complete.requestContextIncomplete).toBe(false)
    expect(interactionContextDisabledReason(complete)).toBeUndefined()
    const clipped = project(kind, { [key]: `${raw}\u0001y` })
    expect(clipped.requestContext?.length).toBe(4096)
    expect(clipped.requestContextIncomplete).toBe(true)
    expect(interactionContextDisabledReason(clipped)).toBeDefined()
  })
}
