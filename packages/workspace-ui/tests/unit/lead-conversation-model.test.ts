import { expect, test } from 'bun:test'
import type { AgentSummary, ChannelSummary } from '@adea-ai/types'
import type { ApiMessageResponse } from '@adea-ai/api-client'
import {
  isWorkspaceLeadConversation,
  messageSubmissionOutcome,
} from '../../src/lead-conversation-model'

const channel = {
  id: 'topic',
  workspaceId: 'workspace',
  agentId: 'lead',
  kind: 'direct_agent',
  lifecycleState: 'active',
} as ChannelSummary
const lead = {
  id: 'lead',
  workspaceId: 'workspace',
  isWorkspaceLead: true,
  lifecycleState: 'active',
} as AgentSummary

test('only the designated same-workspace direct Agent uses explicit lead admission', () => {
  expect(isWorkspaceLeadConversation(channel, lead)).toBe(true)
  for (const kind of ['project', 'group'] as const)
    expect(isWorkspaceLeadConversation({ ...channel, kind }, lead)).toBe(false)
  for (const change of [
    { isWorkspaceLead: false },
    { workspaceId: 'other' },
    { id: 'other' },
    { lifecycleState: 'archived' } as const,
  ])
    expect(isWorkspaceLeadConversation(channel, { ...lead, ...change })).toBe(false)
  expect(isWorkspaceLeadConversation({ ...channel, lifecycleState: 'archived' }, lead)).toBe(false)
  expect(isWorkspaceLeadConversation(channel, undefined)).toBe(false)
})

test('lead setup and changed audience retain the draft; ordinary direct messages clear it normally', () => {
  const ordinary = { message: { id: 'message' } } as ApiMessageResponse
  const acceptedLead = {
    ...ordinary,
    leadTurn: {
      schemaVersion: 'pi-lead-intent/v1',
      intentId: 'intent',
      messageId: 'message',
      dispatchKey: 'lead-turn:intent',
      state: 'blocked',
      reasonCode: 'ADMISSION_SERVICE_UNAVAILABLE',
    },
  } as ApiMessageResponse
  expect(messageSubmissionOutcome(ordinary, true)).toEqual({ clearDraft: true })
  expect(messageSubmissionOutcome(ordinary, false)).toEqual({ clearDraft: false })
  expect(messageSubmissionOutcome(acceptedLead, true)).toEqual({ clearDraft: false })
  expect(messageSubmissionOutcome(acceptedLead, false)).toEqual({ clearDraft: false })
})
