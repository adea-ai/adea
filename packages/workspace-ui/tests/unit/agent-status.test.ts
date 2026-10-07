import { describe, expect, test } from 'bun:test'
import type { AgentSummary } from '@adea-ai/types'

import { agentStatusModel } from '../../src/agent-status'

const agent: AgentSummary = {
  createdAt: '2026-08-30T00:00:00.000Z',
  id: 'agent-1',
  lifecycleState: 'active',
  name: 'Planner',
  presentationMetadata: {},
  profile: { id: 'general', state: 'available', version: '1' },
  updatedAt: '2026-08-30T00:00:00.000Z',
  workspaceId: 'workspace-1',
}

describe('truthful Agent status model', () => {
  test('never infers runtime or working state from persisted existence', () => {
    const status = agentStatusModel(agent)
    expect(status.configuration.label).toBe('Configured')
    expect(status.runtime.label).toBe('Runtime unknown')
    expect(status.execution.label).toBe('Activity unknown')
    expect(JSON.stringify(status)).not.toMatch(/online|working/i)
  })

  test('keeps profile problems on the configuration axis', () => {
    expect(
      agentStatusModel({ ...agent, profile: { ...agent.profile, state: 'missing' } }).configuration
        .label
    ).toBe('Needs configuration')
  })

  test('a configured profile never masks an archived or invalid Agent lifecycle', () => {
    expect(agentStatusModel({ ...agent, lifecycleState: 'archived' }).configuration.detail).toBe(
      'Archived Agent.'
    )
    expect(
      agentStatusModel({ ...agent, lifecycleState: 'configuration_error' }).configuration.detail
    ).toBe('Review configuration.')
  })

  test('offers specific remediation and keeps catalog failure distinct from missing configuration', () => {
    for (const state of [
      'missing',
      'deprecated',
      'revoked',
      'incompatible',
      'unapproved',
    ] as const) {
      const status = agentStatusModel({ ...agent, profile: { ...agent.profile, state } })
      expect(status.configuration.label).toBe('Needs configuration')
      expect(status.configuration.detail).toContain('Customize')
      expect(status.configuration.detail).toContain(state === 'unapproved' ? 'approved' : state)
    }
    const unavailable = agentStatusModel({
      ...agent,
      profile: { ...agent.profile, state: 'unavailable' },
    })
    expect(unavailable.configuration.label).toBe('Profile unavailable')
    expect(unavailable.configuration.detail).toContain('selected version is unchanged')
    expect(unavailable.runtime.label).toBe('Runtime unknown')
  })
})
