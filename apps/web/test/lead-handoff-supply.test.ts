// Workspace-lead handoff supply (#1177): the resolver reads the designated
// lead, its direct channel, and the channel turn through canonical services
// only. Every miss resolves to an explicit reason; nothing is guessed.
import { describe, expect, test } from 'bun:test'

import type { LeadHandoffPort, LeadHandoffResolution } from '../src/lib/lead-handoff-supply'
import {
  buildHandoffRequestBody,
  createOrderedScope,
  requestLeadHandoff,
  resolveLeadHandoffSupply,
} from '../src/lib/lead-handoff-supply'

const LEAD = {
  id: '00000000-0000-4000-8000-0000000000b2',
  isWorkspaceLead: true,
  lifecycleState: 'active',
}

const TASK = '00000000-0000-4000-8000-0000000000f1'
const SESSION = { runtimeSessionId: 'session-1' }

const CHANNEL = {
  id: '00000000-0000-4000-8000-0000000000c3',
  kind: 'direct_agent',
  agentId: LEAD.id,
  taskId: null,
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
    handoffTarget: {
      runtimeSessionId: 'session-1',
      taskId: TASK,
      observedGeneration: 3,
    },
    ...overrides,
  }
}

function observedTurn(overrides: Record<string, unknown> = {}) {
  return turn({ runtimeSessionId: 'session-1', ...overrides })
}

const calls = { lead: 0, channels: 0, turn: 0, cancel: 0 }

function port(overrides: Partial<LeadHandoffPort> = {}): LeadHandoffPort {
  return {
    getWorkspaceLead: async () => {
      calls.lead += 1
      return { lead: LEAD } as never
    },
    listChannels: async () => {
      calls.channels += 1
      return [CHANNEL] as never
    },
    getChannelLeadTurn: async () => {
      calls.turn += 1
      return { leadTurn: turn() } as never
    },
    cancelLeadTurn: async () => {
      calls.cancel += 1
      return { leadTurn: turn() } as never
    },
    ...overrides,
  }
}

function offline(): Promise<never> {
  return Promise.reject(new Error('offline'))
}

describe('resolveLeadHandoffSupply', () => {
  test('resolves agent, channel turn, and cancellability from canonical reads', async () => {
    const resolution = await resolveLeadHandoffSupply(port(), 'workspace-1', 'task-1', SESSION)
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
      'workspace-1',
      'task-1',
      SESSION
    )
    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.leadTurn?.canCancel).toBe(false)
  })

  test('a missing lead resolves to no-lead without guessing', async () => {
    const resolution: LeadHandoffResolution = await resolveLeadHandoffSupply(
      port({ getWorkspaceLead: async () => ({ lead: null }) as never }),
      'workspace-1',
      'task-1',
      SESSION
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
        'workspace-1',
        'task-1',
        SESSION
      )
      expect(resolution).toMatchObject({ status: 'unresolved', reason: 'lead-unavailable' })
    }
  })

  test('no lead channel resolves to no-channel with the agent retained', async () => {
    const resolution = await resolveLeadHandoffSupply(
      port({ listChannels: async () => [] }),
      'workspace-1',
      'task-1',
      SESSION
    )
    expect(resolution.status).toBe('unresolved')
    if (resolution.status !== 'unresolved') return
    expect(resolution.reason).toBe('no-channel')
    expect(resolution.leadAgent?.id).toBe(LEAD.id)
  })

  test('a linked channel without a turn resolves with the channel for admission', async () => {
    const resolution = await resolveLeadHandoffSupply(
      port({ getChannelLeadTurn: async () => ({ leadTurn: null }) as never }),
      'workspace-1',
      'task-1',
      SESSION
    )
    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.channelId).toBe('00000000-0000-4000-8000-0000000000c3')
    expect(resolution.leadTurn).toBeUndefined()
  })

  test('a transport failure at any step resolves to request-failed', async () => {
    const failing: Record<'lead' | 'channels' | 'turn', LeadHandoffPort> = {
      lead: port({ getWorkspaceLead: offline }),
      channels: port({ listChannels: offline }),
      turn: port({ getChannelLeadTurn: offline }),
    }
    for (const step of ['lead', 'channels', 'turn'] as const) {
      const resolution = await resolveLeadHandoffSupply(
        failing[step],
        'workspace-1',
        'task-1',
        SESSION
      )
      expect(resolution).toMatchObject({ status: 'unresolved', reason: 'request-failed' })
    }
  })
})

describe('channel selection and exact binding', () => {
  test('a session without a task or reference costs zero reads and attaches', async () => {
    calls.lead = 0
    calls.channels = 0
    calls.turn = 0
    const resolution = await resolveLeadHandoffSupply(port(), 'workspace-1', undefined, undefined)
    expect(resolution).toEqual({ status: 'unresolved', reason: 'no-link' })
    expect([calls.lead, calls.channels, calls.turn]).toEqual([0, 0, 0])
  })

  test('task-carrying channels can never coordinate', async () => {
    const scoped = { ...CHANNEL, taskId: 'task-1' }
    const resolution = await resolveLeadHandoffSupply(
      port({ listChannels: async () => [scoped, CHANNEL] as never }),
      'workspace-1',
      'task-1',
      SESSION
    )
    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.channelId).toBe(CHANNEL.id)
    expect(resolution.leadTurn?.intentId).toBe('00000000-0000-4000-8000-0000000000a1')
  })

  test('channels of other agents do not coordinate', async () => {
    const foreign = {
      ...CHANNEL,
      id: '00000000-0000-4000-8000-0000000000e5',
      agentId: '00000000-0000-4000-8000-0000000000f6',
    }
    const resolution = await resolveLeadHandoffSupply(
      port({ listChannels: async () => [foreign] as never }),
      'workspace-1',
      'task-1',
      SESSION
    )
    expect(resolution).toMatchObject({ status: 'unresolved', reason: 'no-channel' })
  })

  test('several lead channels fail closed as ambiguous', async () => {
    const second = { ...CHANNEL, id: '00000000-0000-4000-8000-0000000000e5' }
    const resolution = await resolveLeadHandoffSupply(
      port({ listChannels: async () => [CHANNEL, second] as never }),
      'workspace-1',
      'task-1',
      SESSION
    )
    expect(resolution).toMatchObject({ status: 'unresolved', reason: 'ambiguous-channels' })
  })

  test('a turn retained for another session never becomes supply', async () => {
    const foreign = turn({
      handoffTarget: {
        runtimeSessionId: 'session-other',
        taskId: TASK,
        observedGeneration: 3,
      },
    })
    const seen: Array<string | undefined> = []
    const resolution = await resolveLeadHandoffSupply(
      port({
        getChannelLeadTurn: (async (_workspaceId: string, _channelId: string, target?: string) => {
          seen.push(target)
          return { leadTurn: foreign }
        }) as never,
      }),
      'workspace-1',
      'task-1',
      SESSION
    )
    expect(seen).toEqual(['session-1'])
    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.channelId).toBe(CHANNEL.id)
    expect(resolution.leadTurn).toBeUndefined()
  })
})

describe('createOrderedScope', () => {
  test('only the latest epoch applies; older completions are dropped', async () => {
    const scope = createOrderedScope()
    const applied: string[] = []
    const gate = (() => {
      let resolve!: () => void
      const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise
      })
      return { promise, resolve }
    })()
    const first = scope.begin()
    const second = scope.begin()
    const apply = (epoch: number, value: string) => {
      if (scope.isCurrent(epoch)) applied.push(value)
    }
    const pending = gate.promise.then(() => apply(first, 'stale'))
    apply(second, 'current')
    gate.resolve()
    await pending
    expect(applied).toEqual(['current'])
    expect(scope.current()).toBe(second)
  })

  test('a mutation advance invalidates in-flight reads', async () => {
    const scope = createOrderedScope()
    const read = scope.begin()
    scope.begin()
    expect(scope.isCurrent(read)).toBe(false)
  })
})

describe('effect-boundary mapping', () => {
  test('a runtime-observed session maps onto the turn for binding', async () => {
    const resolution = await resolveLeadHandoffSupply(
      port({
        getChannelLeadTurn: (async () => ({
          leadTurn: observedTurn({ state: 'blocked', canCancel: false }),
        })) as never,
      }),
      'workspace-1',
      'task-1',
      SESSION
    )
    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.leadTurn?.executionRuntimeSessionId).toBe('session-1')
  })

  test('a control-plane-reported target maps through for display', async () => {
    const reported = {
      intentId: '00000000-0000-4000-8000-0000000000a1',
      state: 'blocked',
      canCancel: false,
      handoffTarget: {
        runtimeSessionId: 'session-1',
        taskId: TASK,
        observedGeneration: 3,
      },
      observedTarget: { sessionId: 'ses_01JABCDEF0123456789ABCDEFG', taskId: TASK },
    }
    const resolution = await resolveLeadHandoffSupply(
      port({ getChannelLeadTurn: (async () => ({ leadTurn: reported })) as never }),
      'workspace-1',
      'task-1',
      SESSION
    )
    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.leadTurn?.observedTarget).toEqual({
      sessionId: 'ses_01JABCDEF0123456789ABCDEFG',
      taskId: TASK,
    })
  })

  test('an unobserved turn still maps; binding is decided downstream', async () => {
    const resolution = await resolveLeadHandoffSupply(port(), 'workspace-1', 'task-1', SESSION)
    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.leadTurn?.executionRuntimeSessionId).toBeUndefined()
  })
})

describe('composed with the handoff derivation', () => {
  test('effect-shaped facts track the request without coordinating', async () => {
    const { deriveDirectSessionHandoff, deriveHandoffInputFromConversation } =
      await import('@adea-ai/dev-view/chat/model')
    const resolution = await resolveLeadHandoffSupply(
      port({
        getChannelLeadTurn: (async () => ({
          leadTurn: observedTurn({ state: 'blocked', canCancel: false }),
        })) as never,
      }),
      'workspace-1',
      'task-1',
      SESSION
    )
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
        leadChannelId: resolution.channelId,
      })
    )
    expect(view.mode).toBe('attached')
    expect(view.coordination).toBeUndefined()
    expect(view.controls.lead_stop.available).toBe(false)
    expect(view.controls.handoff_to_lead.available).toBe(true)
    expect(view.awaitingTurn).toBe(true)
  })

  test('an unresolved roster falls back to attachment without inventing', async () => {
    const { deriveDirectSessionHandoff, deriveHandoffInputFromConversation } =
      await import('@adea-ai/dev-view/chat/model')
    const resolution = await resolveLeadHandoffSupply(
      port({ getWorkspaceLead: async () => ({ lead: null }) as never }),
      'workspace-1',
      'task-1',
      SESSION
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

describe('requestLeadHandoff', () => {
  test('posts the structured target and verifies the retained receipt', async () => {
    const seen: Array<{ workspaceId: string; channelId: string; body: unknown }> = []
    const fake = port({
      createMessage: (async (workspaceId: string, channelId: string, input: never) => {
        seen.push({ workspaceId, channelId, body: input })
        return {
          message: { id: 'message-1' },
          leadTurn: {
            intentId: 'intent-1',
            handoffTarget: {
              runtimeSessionId: 'session-1',
              taskId: TASK,
              observedGeneration: 3,
            },
          },
        }
      }) as never,
    })
    const confirmation = await requestLeadHandoff(fake, {
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
      runtimeSessionId: 'session-1',
      taskId: TASK,
      expectedGeneration: 3,
    })
    expect(confirmation).toEqual({
      intentId: 'intent-1',
      messageId: 'message-1',
      channelId: 'channel-1',
      handoffTarget: {
        runtimeSessionId: 'session-1',
        taskId: TASK,
        observedGeneration: 3,
      },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ workspaceId: 'workspace-1', channelId: 'channel-1' })
    const body = seen[0]!.body as Record<string, unknown>
    expect(body.leadTurn).toBe(true)
    expect(typeof body.bodyText).toBe('string')
    expect(body.bodyText as string).toContain('session-1')
    expect(body.handoffTarget).toEqual({
      runtimeSessionId: 'session-1',
      taskId: TASK,
      expectedGeneration: 3,
    })
  })

  test('every attempt mints a fresh key; recovery lives server-side', async () => {
    const keys: unknown[] = []
    const fake = port({
      createMessage: (async (
        _workspaceId: string,
        _channelId: string,
        input: {
          handoffTarget: unknown
          idempotencyKey: string
        }
      ) => {
        keys.push(input.idempotencyKey)
        return {
          message: { id: 'message-1' },
          leadTurn: {
            intentId: 'intent-1',
            handoffTarget: {
              runtimeSessionId: 'session-1',
              taskId: TASK,
              observedGeneration: 3,
            },
          },
        }
      }) as never,
    })
    const input = {
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
      runtimeSessionId: 'session-1',
      taskId: TASK,
      expectedGeneration: 3,
    }
    await requestLeadHandoff(fake, input)
    await requestLeadHandoff(fake, input)
    expect(keys).toHaveLength(2)
    // No client-held identity to lose: the two keys differ, and the server
    // dedupes by retained target, not by remembered key.
    expect(keys[0]).not.toBe(keys[1])
  })

  test('a response without a retained target fails closed instead of recording', async () => {
    const fake = port({
      createMessage: (async () => ({
        message: { id: 'message-1' },
        leadTurn: { intentId: 'intent-1' },
      })) as never,
    })
    await expect(
      requestLeadHandoff(fake, {
        workspaceId: 'workspace-1',
        channelId: 'channel-1',
        runtimeSessionId: 'session-1',
        taskId: TASK,
        expectedGeneration: 3,
      })
    ).rejects.toThrow('did not return an intent')
  })

  test('a receipt for another target fails closed instead of binding', async () => {
    const fake = port({
      createMessage: (async () => ({
        message: { id: 'message-1' },
        leadTurn: {
          intentId: 'intent-1',
          handoffTarget: {
            runtimeSessionId: 'session-other',
            taskId: TASK,
            observedGeneration: 3,
          },
        },
      })) as never,
    })
    await expect(
      requestLeadHandoff(fake, {
        workspaceId: 'workspace-1',
        channelId: 'channel-1',
        runtimeSessionId: 'session-1',
        taskId: TASK,
        expectedGeneration: 3,
      })
    ).rejects.toThrow('another target')
  })

  test('the request body is fixed so retries stay byte-identical', () => {
    expect(buildHandoffRequestBody('session-1')).toBe(buildHandoffRequestBody('session-1'))
    expect(buildHandoffRequestBody('session-1')).toContain('session-1')
  })
})
