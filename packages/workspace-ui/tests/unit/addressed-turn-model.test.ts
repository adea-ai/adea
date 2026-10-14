import { describe, expect, test } from 'bun:test'
import { createComposerSubmissionIdentity } from '../../src/composer-submission-identity'
import type { ApiAddressedTurn } from '@adea-ai/api-client'
import type { AgentSummary, ChannelSummary, WorkspaceSummary } from '@adea-ai/types'

import {
  addressedTurnFailure,
  addressingKey,
  addressingMode,
  audienceLabel,
  createAddressingQueue,
  groupParticipants,
  parseAddressedLabel,
  qualifyAgent,
  qualifyContext,
  qualifyTurnAgent,
  recipientsSubmissionContext,
  turnOrigin,
  turnPresentation,
  turnsByTrigger,
  type AddressingIntent,
} from '../../src/addressed-turn-model'

const hostId = 'aaaaaaaa-0000-4000-8000-00000000000a'
const guestId = 'bbbbbbbb-0000-4000-8000-00000000000b'
const hostAria = '11111111-0000-4000-8000-000000000001'
const guestAria = '22222222-0000-4000-8000-000000000002'

function agent(id: string, name: string, workspaceId: string): AgentSummary {
  return { id, name, workspaceId } as unknown as AgentSummary
}
function workspace(id: string, name: string): WorkspaceSummary {
  return { id, name } as unknown as WorkspaceSummary
}
function turn(overrides: Partial<ApiAddressedTurn> = {}): ApiAddressedTurn {
  return {
    addressedLabel: `${guestId}:${guestAria}`,
    addresserUserId: 'user-1',
    agentId: guestAria,
    budget: { maxDepth: 2, maxTurns: 8 },
    causalId: `turn:m1:${guestAria}:1`,
    channelId: 'channel',
    createdAt: '2026-10-14T10:00:00.000Z',
    depth: 0,
    dispatchRevision: 1,
    dispatched: true,
    id: 'turn-1',
    leadTurnIntentId: null,
    parentTurnId: null,
    responseMessageId: null,
    state: 'dispatching',
    triggerMessageId: 'm1',
    updatedAt: '2026-10-14T10:00:00.000Z',
    ...overrides,
  }
}

const context = qualifyContext(
  [agent(hostAria, 'Aria', hostId)],
  [workspace(hostId, 'Acme'), workspace(guestId, 'Globex')]
)

describe('qualified Agent names', () => {
  test('two Agents named Aria in different workspaces read as different rows', () => {
    const local = qualifyAgent(hostAria, null, context)
    const foreign = qualifyAgent(guestAria, guestId, context)
    expect(local.label).toBe('Aria · Acme')
    expect(foreign.label).toBe('Agent 22222222 · Globex')
    expect(local.label).not.toBe(foreign.label)
  })

  test('a name this client cannot resolve is never guessed, and the short id keeps rows distinct', () => {
    const one = qualifyAgent('33333333-0000-4000-8000-000000000003', guestId, context)
    const two = qualifyAgent('44444444-0000-4000-8000-000000000004', guestId, context)
    expect(one.name).toBeNull()
    expect(one.label).not.toBe(two.label)
  })

  test('a workspace the viewer is not in is named generically, not by id', () => {
    const stranger = qualifyAgent(guestAria, 'cccccccc-0000-4000-8000-00000000000c', context)
    expect(stranger.workspaceLabel).toBe('Another workspace')
    expect(stranger.label).not.toContain('cccccccc')
  })

  test('a turn label supplies the home workspace only when it names the turn’s own Agent', () => {
    expect(parseAddressedLabel(`${guestId}:${guestAria}`)).toEqual({
      agentId: guestAria,
      workspaceId: guestId,
    })
    expect(parseAddressedLabel('nocolon')).toBeNull()
    expect(parseAddressedLabel(':agent')).toBeNull()
    expect(qualifyTurnAgent(turn(), context).workspaceLabel).toBe('Globex')
    const forged = turn({ addressedLabel: `${hostId}:${hostAria}` })
    expect(qualifyTurnAgent(forged, context).workspaceId).toBeNull()
  })

  test('the roster takes unknown Agents’ home workspaces from retained turns', () => {
    const channel = {
      participants: [
        { agentId: hostAria, kind: 'agent' },
        { agentId: guestAria, kind: 'agent' },
        { agentId: guestAria, kind: 'agent' },
        { kind: 'user', userId: 'user-1' },
      ],
    } as unknown as ChannelSummary
    const roster = groupParticipants({ channel, context, turns: [turn()] })
    expect(roster.map((entry) => entry.label)).toEqual(['Aria · Acme', 'Agent 22222222 · Globex'])
  })
})

describe('addressing mode', () => {
  const one = qualifyAgent(hostAria, null, context)
  const two = qualifyAgent(guestAria, guestId, context)
  test('nothing is addressed until a recipient is chosen', () => {
    expect(addressingMode([])).toEqual({ kind: 'none', label: 'No Agent addressed' })
  })
  test('one recipient is named with its workspace; several are counted', () => {
    expect(addressingMode([one])).toEqual({ kind: 'single', label: 'Addressing Aria · Acme' })
    expect(addressingMode([one, two])).toEqual({ kind: 'several', label: 'Addressing 2 Agents' })
  })
  test('audience reads from the channel visibility', () => {
    expect(audienceLabel('participants')).toBe('Participants only')
    expect(audienceLabel('workspace')).toBe('Whole workspace')
  })
})

describe('turn presentation', () => {
  test('a claim nothing admitted says it has not started and why, never that it is running', () => {
    const value = turnPresentation(turn({ state: 'claimed', dispatched: false }))
    expect(value.label).toBe('Not started')
    expect(value.detail).toContain('Nothing has started')
    expect(value.detail).toContain('lead')
    expect(value.live).toBe(true)
  })

  test('each state has its own label and only live states can be cancelled', () => {
    const labels = (
      ['claimed', 'dispatching', 'responded', 'superseded', 'cancelled'] as const
    ).map((state) => {
      const value = turnPresentation(turn({ state, dispatched: true }))
      return [state, value.label, value.live]
    })
    expect(labels).toEqual([
      ['claimed', 'Admitted', true],
      ['dispatching', 'Dispatched', true],
      ['responded', 'Answered', false],
      ['superseded', 'Superseded', false],
      ['cancelled', 'Cancelled', false],
    ])
  })

  test('origin follows the retained parent', () => {
    expect(turnOrigin(turn())).toBe('Addressed directly')
    expect(turnOrigin(turn({ parentTurnId: 'p', depth: 1 }))).toBe('Follow-up request (level 1)')
  })

  test('turns group under their trigger in the order given', () => {
    const grouped = turnsByTrigger([
      turn({ id: 'a', triggerMessageId: 'm1' }),
      turn({ id: 'b', triggerMessageId: 'm2' }),
      turn({ id: 'c', triggerMessageId: 'm1' }),
    ])
    expect(grouped.get('m1')?.map((entry) => entry.id)).toEqual(['a', 'c'])
    expect(grouped.get('m2')?.map((entry) => entry.id)).toEqual(['b'])
  })
})

const http = (status: number, reason?: string) => Object.assign(new Error('x'), { reason, status })

describe('failure copy', () => {
  test('conflicts name their reason and are never retried', () => {
    for (const reason of [
      'turn_superseded',
      'turn_cancelled',
      'turn_already_responded',
      'turn_budget_exhausted',
      'turn_depth_exceeded',
    ]) {
      const value = addressedTurnFailure(http(409, reason), 'address')
      expect(value.retryable).toBe(false)
      expect(value.text.length).toBeGreaterThan(10)
    }
    expect(addressedTurnFailure(http(409, 'turn_superseded'), 'address').text).toContain('newer')
  })

  test('an unavailable answer discloses nothing about why', () => {
    const value = addressedTurnFailure(http(404), 'address')
    expect(value.retryable).toBe(false)
    expect(value.text).not.toMatch(/revok|enlist|grant|audience/i)
  })

  test('network and server errors are transient; client errors and rate limits behave as expected', () => {
    expect(addressedTurnFailure(new TypeError('Failed to fetch'), 'address').retryable).toBe(true)
    expect(addressedTurnFailure(http(503), 'address').retryable).toBe(true)
    expect(addressedTurnFailure(http(429), 'address').retryable).toBe(true)
    expect(addressedTurnFailure(http(400), 'address').retryable).toBe(false)
    expect(addressedTurnFailure(http(401), 'cancel').retryable).toBe(false)
  })
})

const input = (agentId: string, messageId = 'm1') => ({
  agentId,
  dispatchRevision: 1,
  triggerMessageId: messageId,
})

describe('addressing queue', () => {
  test('sends each recipient once, in the order chosen, and clears what was delivered', async () => {
    const sent: string[] = []
    const snapshots: (readonly AddressingIntent[])[] = []
    const queue = createAddressingQueue({
      onChange: (intents) => snapshots.push(intents),
      send: async (request) => {
        sent.push(request.agentId)
      },
    })
    await queue.enqueue([input('a'), input('b')])
    expect(sent).toEqual(['a', 'b'])
    expect(queue.intents()).toEqual([])
    expect(snapshots.some((intents) => intents.length === 2)).toBe(true)
  })

  test('a transient failure is kept and retried with the identical request', async () => {
    const requests: string[] = []
    let failures = 1
    const queue = createAddressingQueue({
      onChange: () => undefined,
      send: async (request) => {
        requests.push(JSON.stringify(request))
        if (failures-- > 0) throw new TypeError('Failed to fetch')
      },
    })
    await queue.enqueue([input('a')])
    expect(queue.intents()).toHaveLength(1)
    expect(queue.intents()[0]).toMatchObject({ status: 'failed', failure: { retryable: true } })
    await queue.retryTransient()
    expect(queue.intents()).toEqual([])
    expect(requests).toHaveLength(2)
    expect(requests[0]).toBe(requests[1]!)
  })

  test('a refusal is not retried on reconnect and waits for the person to dismiss it', async () => {
    let calls = 0
    const queue = createAddressingQueue({
      onChange: () => undefined,
      send: async () => {
        calls += 1
        throw Object.assign(new Error('conflict'), { reason: 'turn_superseded', status: 409 })
      },
    })
    await queue.enqueue([input('a')])
    await queue.retryTransient()
    expect(calls).toBe(1)
    expect(queue.intents()[0]?.failure?.text).toContain('newer')
    queue.dismiss(addressingKey(input('a')))
    expect(queue.intents()).toEqual([])
  })

  test('enqueueing the same message and Agent twice sends one request', async () => {
    let calls = 0
    const queue = createAddressingQueue({
      onChange: () => undefined,
      send: async () => {
        calls += 1
        throw new TypeError('offline')
      },
    })
    await queue.enqueue([input('a')])
    await queue.enqueue([input('a')])
    expect(calls).toBe(1)
    expect(queue.intents()).toHaveLength(1)
  })

  test('one failed recipient does not stop the others', async () => {
    const sent: string[] = []
    const queue = createAddressingQueue({
      onChange: () => undefined,
      send: async (request) => {
        sent.push(request.agentId)
        if (request.agentId === 'a') throw new TypeError('offline')
      },
    })
    await queue.enqueue([input('a'), input('b')])
    expect(sent).toEqual(['a', 'b'])
    expect(queue.intents().map((intent) => intent.agentId)).toEqual(['a'])
  })
})

function newIdentity() {
  let next = 0
  return createComposerSubmissionIdentity(() => `key-${(next += 1)}`)
}

describe('recipientsSubmissionContext', () => {
  const content = { artifactIds: [], bodyText: 'same words', channelId: 'group', mentions: [] }

  test('a retry with the same recipients keeps its key', () => {
    const composer = newIdentity()
    const same = recipientsSubmissionContext([hostId])
    expect(composer.key({ ...content, submissionContext: same })).toBe(
      composer.key({ ...content, submissionContext: recipientsSubmissionContext([hostId]) })
    )
  })

  test('changed recipients are a changed submission, so the old key is never reused with new mentions', () => {
    const composer = newIdentity()
    const first = composer.key({
      ...content,
      submissionContext: recipientsSubmissionContext([hostId]),
    })
    const second = composer.key({
      ...content,
      submissionContext: recipientsSubmissionContext([hostId, guestId]),
    })
    expect(second).not.toBe(first)
    expect(recipientsSubmissionContext([])).not.toBe(recipientsSubmissionContext([hostId]))
  })
})
