import { describe, expect, test } from 'bun:test'
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'

import { APPROVAL_DESCRIPTION_LIMIT, approvalDetails } from '../src/chat/model/approval'
import { LONG_APPROVAL_TAIL, longApprovalEvents } from '../src/chat/visual-fixture-data'
import { projectTranscriptEvents } from '../src/chat/presentation'

const approval = (events: readonly RuntimeEvent[]) =>
  projectTranscriptEvents(events).find((item) => item.kind === 'approval.requested')!

describe('approval request details', () => {
  test('a request that fits the card description adds no details', () => {
    expect(approvalDetails(undefined)).toBeUndefined()
    expect(approvalDetails('Apply the plan.')).toBeUndefined()
    expect(approvalDetails('x'.repeat(APPROVAL_DESCRIPTION_LIMIT))).toBeUndefined()
  })

  test('a request past the description limit is available in full', () => {
    const item = approval(longApprovalEvents)
    expect(item.text!.length).toBeGreaterThan(APPROVAL_DESCRIPTION_LIMIT)
    // The decisive part is beyond what the description can show.
    expect(item.text!.indexOf(LONG_APPROVAL_TAIL)).toBeGreaterThan(APPROVAL_DESCRIPTION_LIMIT)
    expect(approvalDetails(item.requestContext, item.requestContextIncomplete)).toEqual({
      kind: 'code',
      code: item.requestContext!,
      title: 'Full request',
    })
  })

  test('the details carry the redacted, bounded text and never the raw payload', () => {
    const secret = 'sk-supersecretvalue1234'
    const [source] = longApprovalEvents
    const [, request] = longApprovalEvents
    const long = `${'step '.repeat(120)}${secret} then /Users/example/private ${'z'.repeat(5_000)}`
    const item = approval([source!, { ...request!, payload: { name: 'Run', text: long } }])
    const details = approvalDetails(item.requestContext, item.requestContextIncomplete)

    expect(details).toBeDefined()
    expect(details!.code).toBe(item.requestContext!)
    expect(details!.code).not.toContain('supersecretvalue1234')
    expect(details!.code).not.toContain('/Users/example/private')
    expect(details!.code).toContain('[secret redacted]')
    expect(details!.code.length).toBeLessThan(long.length)
  })
})
