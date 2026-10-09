// Workspace-lead handoff supply (#1177): the resolver reads the designated
// lead, its direct channel, and the channel turn through canonical services
// only. Every miss resolves to an explicit reason; nothing is guessed.
import { describe, expect, test } from 'bun:test'

import type { LeadHandoffPort, LeadHandoffResolution } from '../src/lib/lead-handoff-supply'
import { resolveLeadHandoffSupply } from '../src/lib/lead-handoff-supply'

const LEAD = {
  id: '00000000-0000-4000-8000-0000000000b2',
  isWorkspaceLead: true,
  lifecycleState: 'active',
}

const CHANNEL = {
  id: '00000000-0000-4000-8000-0000000000c3',
  kind: 'direct_agent',
  agentId: LEAD.id,
  lifecycleState: 'active',
}

function turn(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'adea-lead-turn/v1',
    intentId: '00000000-0000-4000-8000-0000000000a1',
    messageId: '00000000-0000-4000-8000-0000000000d4',
    state: 'running',
    availability: 'available',
    dispatchId: 'dispatch_11111111111111111111111111111111',
    ...overrides,
  }
}

function port(overrides: Partial<LeadHandoffPort> = {}): LeadHandoffPort {
  return {
    getWorkspaceLead: async () => ({ lead: LEAD }) as never,
    listChannels: async () => [CHANNEL] as never,
    getChannelLeadTurn: async () => ({ leadTurn: turn() }) as never,
    cancelLeadTurn: async () => ({ leadTurn: turn() }) as never,
    ...overrides,
  }
}

function offline(): Promise<never> {
  return Promise.reject(new Error('offline'))
}

describe('resolveLeadHandoffSupply', () => {
  test('resolves agent, channel turn, and cancellability from canonical reads', async () => {
    const resolution = await resolveLeadHandoffSupply(port(), 'workspace-1')
    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.leadAgent).toMatchObject({ id: LEAD.id, isWorkspaceLead: true })
    expect(resolution.leadTurn).toMatchObject({
      intentId: '00000000-0000-4000-8000-0000000000a1',
      agentId: LEAD.id,
      dispatchId: 'dispatch_11111111111111111111111111111111',
      state: 'running',
      canCancel: true,
    })
  })

  test('terminal turns resolve as non-cancellable', async () => {
    const resolution = await resolveLeadHandoffSupply(
      port({
        getChannelLeadTurn: async () => ({ leadTurn: turn({ state: 'completed' }) }) as never,
      }),
      'workspace-1'
    )
    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.leadTurn?.canCancel).toBe(false)
  })

  test('a missing lead resolves to no-lead without guessing', async () => {
    const resolution: LeadHandoffResolution = await resolveLeadHandoffSupply(
      port({ getWorkspaceLead: async () => ({ lead: null }) as never }),
      'workspace-1'
    )
    expect(resolution).toEqual({ status: 'unresolved', reason: 'no-lead' })
  })

  test('a non-designated or inactive roster entry is unavailable', async () => {
    for (const lead of [
      { ...LEAD, isWorkspaceLead: false },
      { ...LEAD, lifecycleState: 'archived' },
    ]) {
      const resolution = await resolveLeadHandoffSupply(
        port({ getWorkspaceLead: async () => ({ lead }) as never }),
        'workspace-1'
      )
      expect(resolution).toMatchObject({ status: 'unresolved', reason: 'lead-unavailable' })
    }
  })

  test('no lead channel resolves to no-channel with the agent retained', async () => {
    const resolution = await resolveLeadHandoffSupply(
      port({ listChannels: async () => [] }),
      'workspace-1'
    )
    expect(resolution.status).toBe('unresolved')
    if (resolution.status !== 'unresolved') return
    expect(resolution.reason).toBe('no-channel')
    expect(resolution.leadAgent?.id).toBe(LEAD.id)
  })

  test('several lead channels fail closed as ambiguous instead of picking one', async () => {
    const second = { ...CHANNEL, id: '00000000-0000-4000-8000-0000000000e5' }
    const resolution = await resolveLeadHandoffSupply(
      port({ listChannels: async () => [CHANNEL, second] as never }),
      'workspace-1'
    )
    expect(resolution).toMatchObject({ status: 'unresolved', reason: 'ambiguous-channels' })
  })

  test('a channel without a turn resolves to no-turn', async () => {
    const resolution = await resolveLeadHandoffSupply(
      port({ getChannelLeadTurn: async () => ({ leadTurn: null }) as never }),
      'workspace-1'
    )
    expect(resolution).toMatchObject({ status: 'unresolved', reason: 'no-turn' })
  })

  test('a transport failure at any step resolves to request-failed', async () => {
    const failing: Record<'lead' | 'channels' | 'turn', LeadHandoffPort> = {
      lead: port({ getWorkspaceLead: offline }),
      channels: port({ listChannels: offline }),
      turn: port({ getChannelLeadTurn: offline }),
    }
    for (const step of ['lead', 'channels', 'turn'] as const) {
      const resolution = await resolveLeadHandoffSupply(failing[step], 'workspace-1')
      expect(resolution).toMatchObject({ status: 'unresolved', reason: 'request-failed' })
    }
  })
})

describe('composed with the handoff derivation', () => {
  test('resolved facts drive a coordinating view end to end', async () => {
    const { deriveDirectSessionHandoff, deriveHandoffInputFromConversation } =
      await import('@adea-ai/dev-view/chat/model')
    const resolution = await resolveLeadHandoffSupply(port(), 'workspace-1')
    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    const view = deriveDirectSessionHandoff(
      deriveHandoffInputFromConversation({
        conversation: {
          runtimeSessionId: 'session-1',
          scope: {
            accountId: '00000000-0000-4000-8000-000000000001',
            workspaceId: 'workspace-1',
            runtimeNodeId: '00000000-0000-4000-8000-000000000003',
          },
          projectId: 'project-1',
          repoId: 'repo-1',
          worktreeId: 'worktree-1',
          title: 'Session',
          status: 'active',
          archived: false,
          projection: 'structured',
          generation: 3,
          version: 7,
          draft: '',
          draftBlocks: [],
          events: [],
          retention: { maxEvents: 1000, complete: true },
        },
        connected: true,
        leadTurn: resolution.leadTurn,
        leadAgent: resolution.leadAgent,
      })
    )
    expect(view.mode).toBe('coordination_handoff')
    expect(view.controls.lead_stop.available).toBe(true)
    expect(view.coordination?.intentId).toBe('00000000-0000-4000-8000-0000000000a1')
  })

  test('an unresolved roster falls back to attachment without inventing', async () => {
    const { deriveDirectSessionHandoff, deriveHandoffInputFromConversation } =
      await import('@adea-ai/dev-view/chat/model')
    const resolution = await resolveLeadHandoffSupply(
      port({ getWorkspaceLead: async () => ({ lead: null }) as never }),
      'workspace-1'
    )
    expect(resolution.status).toBe('unresolved')
    const view = deriveDirectSessionHandoff(
      deriveHandoffInputFromConversation({
        conversation: {
          runtimeSessionId: 'session-1',
          scope: {
            accountId: '00000000-0000-4000-8000-000000000001',
            workspaceId: 'workspace-1',
            runtimeNodeId: '00000000-0000-4000-8000-000000000003',
          },
          projectId: 'project-1',
          repoId: 'repo-1',
          worktreeId: 'worktree-1',
          title: 'Session',
          status: 'active',
          archived: false,
          projection: 'structured',
          generation: 3,
          version: 7,
          draft: '',
          draftBlocks: [],
          events: [],
          retention: { maxEvents: 1000, complete: true },
        },
        connected: true,
        leadTurn: resolution.status === 'resolved' ? resolution.leadTurn : undefined,
        leadAgent: resolution.status === 'resolved' ? resolution.leadAgent : undefined,
      })
    )
    expect(view.mode).toBe('attached')
    expect(view.controls.lead_stop.available).toBe(false)
  })
})
