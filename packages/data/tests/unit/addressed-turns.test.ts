import { describe, expect, test } from 'bun:test'
import type { ApiAddressedTurn, ApiAddressedTurnState } from '@adea-ai/api-client'

import {
  advanceAddressedTurn,
  applyAddressedTurnReplay,
  foldAddressedTurnCache,
  foldAddressedTurns,
  isLiveAddressedTurn,
  isUnstartedAddressedTurn,
  replayAddressedTurns,
  type AddressedTurnReplay,
} from '../../src/addressed-turns'

const homeA = 'aaaaaaaa-0000-4000-8000-00000000000a'
const homeB = 'bbbbbbbb-0000-4000-8000-00000000000b'

let counter = 0
function turn(overrides: Partial<ApiAddressedTurn> = {}): ApiAddressedTurn {
  counter += 1
  const n = String(counter).padStart(4, '0')
  const triggerMessageId = overrides.triggerMessageId ?? `10000000-0000-4000-8000-00000000${n}`
  const agentId = overrides.agentId ?? `20000000-0000-4000-8000-00000000${n}`
  const dispatchRevision = overrides.dispatchRevision ?? 1
  return {
    addressedLabel: `${homeA}:${agentId}`,
    addresserUserId: 'user-1',
    agentId,
    budget: { maxDepth: 2, maxTurns: 8 },
    causalId: `turn:${triggerMessageId}:${agentId}:${dispatchRevision}`,
    channelId: 'channel-1',
    createdAt: `2026-10-14T10:00:${String(counter).padStart(2, '0')}.000Z`,
    depth: 0,
    dispatchRevision,
    dispatched: true,
    id: `30000000-0000-4000-8000-00000000${n}`,
    leadTurnIntentId: null,
    parentTurnId: null,
    responseMessageId: null,
    state: 'dispatching',
    triggerMessageId,
    updatedAt: `2026-10-14T10:00:${String(counter).padStart(2, '0')}.000Z`,
    ...overrides,
  }
}

function at(base: ApiAddressedTurn, state: ApiAddressedTurnState, seconds: number) {
  return {
    ...base,
    state,
    updatedAt: `2026-10-14T10:05:${String(seconds).padStart(2, '0')}.000Z`,
    ...(state === 'responded' ? { responseMessageId: '40000000-0000-4000-8000-000000000001' } : {}),
  }
}

const permutations = (items: readonly ApiAddressedTurn[]): ApiAddressedTurn[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
          item,
          ...rest,
        ])
      )

describe('advanceAddressedTurn', () => {
  test('a terminal state is never replaced by a live copy, however fresh the live copy looks', () => {
    const base = turn()
    const cancelled = at(base, 'cancelled', 1)
    const staleLive = { ...at(base, 'dispatching', 9) }
    expect(advanceAddressedTurn(cancelled, staleLive)).toBe(cancelled)
    expect(advanceAddressedTurn(staleLive, cancelled)).toBe(cancelled)
  })

  test('two terminal states never swap: the held outcome stands', () => {
    const base = turn()
    const responded = at(base, 'responded', 1)
    const cancelled = at(base, 'cancelled', 2)
    expect(advanceAddressedTurn(responded, cancelled)).toBe(responded)
  })

  test('within one state the later update wins and a tie keeps the copy that knows more', () => {
    const base = turn({ state: 'claimed', dispatched: false })
    const older = { ...base, updatedAt: '2026-10-14T10:05:00.000Z' }
    const newer = { ...base, updatedAt: '2026-10-14T10:05:01.000Z' }
    expect(advanceAddressedTurn(older, newer)).toBe(newer)
    expect(advanceAddressedTurn(newer, older)).toBe(newer)
    const bare = { ...base, updatedAt: '2026-10-14T10:05:02.000Z' }
    const knows = { ...bare, leadTurnIntentId: 'intent-1' }
    expect(advanceAddressedTurn(bare, knows)).toBe(knows)
    expect(advanceAddressedTurn(knows, bare)).toBe(knows)
  })
})

describe('foldAddressedTurns', () => {
  test('a duplicate request, a retried response and a replay of the same turn are one row', () => {
    const created = turn({ state: 'claimed', dispatched: false })
    const duplicate = { ...created }
    const replayed = { ...created, id: created.id }
    const folded = foldAddressedTurns(foldAddressedTurns([], [created]), [duplicate, replayed])
    expect(folded).toHaveLength(1)
    expect(folded[0]).toBe(created)
  })

  test('identity is the causal id, so a second revision is a second turn', () => {
    const first = turn()
    const second = turn({
      agentId: first.agentId,
      dispatchRevision: 2,
      triggerMessageId: first.triggerMessageId,
    })
    expect(foldAddressedTurns([first], [second]).map((entry) => entry.dispatchRevision)).toEqual([
      1, 2,
    ])
  })

  test('same-name Agents from different workspaces stay separate rows by qualified identity', () => {
    const trigger = '10000000-0000-4000-8000-0000000000ff'
    const left = turn({
      agentId: '20000000-0000-4000-8000-0000000000a1',
      addressedLabel: `${homeA}:20000000-0000-4000-8000-0000000000a1`,
      triggerMessageId: trigger,
    })
    const right = turn({
      agentId: '20000000-0000-4000-8000-0000000000b1',
      addressedLabel: `${homeB}:20000000-0000-4000-8000-0000000000b1`,
      triggerMessageId: trigger,
    })
    const folded = foldAddressedTurns([], [right, left])
    expect(folded.map((entry) => entry.addressedLabel)).toEqual([
      left.addressedLabel,
      right.addressedLabel,
    ])
  })

  test('every delivery order of the same facts converges on the same turns, states and order', () => {
    const a = turn({ state: 'claimed', dispatched: false })
    const b = turn()
    const c = turn()
    // Facts as different tabs and reconnects would deliver them: early snapshots, later snapshots,
    // a cancel response, a duplicate address response, and an answer.
    const facts: ApiAddressedTurn[] = [
      a,
      { ...a },
      at({ ...a, dispatched: true }, 'dispatching', 1),
      at(a, 'cancelled', 2),
      b,
      at(b, 'responded', 3),
      { ...b },
      c,
      at(c, 'superseded', 4),
      { ...c, state: 'claimed' },
    ]
    const expected = foldAddressedTurns([], facts)
    expect(expected.map((entry) => entry.state)).toEqual(['cancelled', 'responded', 'superseded'])
    // 10! is too many to enumerate usefully; sample the permutation space deterministically.
    const all = permutations(facts.slice(0, 7))
    for (let index = 0; index < all.length; index += 37) {
      const order = [...all[index]!, ...facts.slice(7)]
      const folded = foldAddressedTurns([], order)
      expect(folded.map((entry) => [entry.causalId, entry.state])).toEqual(
        expected.map((entry) => [entry.causalId, entry.state])
      )
    }
  })
})

describe('applyAddressedTurnReplay', () => {
  test('the replay fixes the order', () => {
    const [x, y, z] = [turn(), turn(), turn()]
    expect(applyAddressedTurnReplay([z, x, y], [x, y, z]).map((entry) => entry.id)).toEqual([
      x.id,
      y.id,
      z.id,
    ])
  })

  test('a held turn the replay no longer lists is dropped when something newer was listed', () => {
    const withheld = turn()
    const kept = turn()
    const next = turn()
    expect(
      applyAddressedTurnReplay([withheld, kept], [kept, next]).map((entry) => entry.id)
    ).toEqual([kept.id, next.id])
  })

  test('a held turn newer than anything listed survives: it committed after the read began', () => {
    const listed = turn()
    const justCreated = turn({ state: 'claimed', dispatched: false })
    expect(
      applyAddressedTurnReplay([listed, justCreated], [listed]).map((entry) => entry.id)
    ).toEqual([listed.id, justCreated.id])
  })

  test('a stale replay cannot reopen a turn the reader already saw finish', () => {
    const base = turn()
    const cancelled = at(base, 'cancelled', 1)
    const [merged] = applyAddressedTurnReplay([cancelled], [base])
    expect(merged!.state).toBe('cancelled')
  })

  test('a replay that lists a causal id twice shows it once', () => {
    const only = turn()
    expect(applyAddressedTurnReplay([], [only, { ...only }])).toHaveLength(1)
  })
})

function pagedClient(pages: readonly (readonly ApiAddressedTurn[])[], options = { loop: false }) {
  const requests: Array<{ after?: string; limit?: number }> = []
  return {
    requests,
    client: {
      listAddressedTurns: async (
        _workspaceId: string,
        _channelId: string,
        request: { after?: string; limit?: number } = {}
      ) => {
        requests.push(request)
        const index = request.after
          ? pages.findIndex((page) => page.at(-1)!.id === request.after) + 1
          : 0
        const turns = pages[index] ?? []
        const last = index >= pages.length - 1
        return {
          nextAfter: options.loop
            ? (request.after ?? turns.at(-1)!.id)
            : last
              ? null
              : turns.at(-1)!.id,
          turns,
        }
      },
    },
  }
}

describe('replayAddressedTurns', () => {
  test('walks every page from the start in server order', async () => {
    const pages = [[turn(), turn()], [turn()], [turn(), turn()]]
    const { client, requests } = pagedClient(pages)
    const replay = await replayAddressedTurns(client, 'ws', 'channel-1')
    expect(replay.complete).toBe(true)
    expect(replay.turns.map((entry) => entry.id)).toEqual(pages.flat().map((entry) => entry.id))
    expect(requests[0]).toEqual({ limit: 200 })
    expect(requests[1]!.after).toBe(pages[0]!.at(-1)!.id)
  })

  test('reports an incomplete read at the page cap instead of presenting a short list as whole', async () => {
    const pages = [[turn()], [turn()], [turn()], [turn()]]
    const { client } = pagedClient(pages)
    const replay = await replayAddressedTurns(client, 'ws', 'channel-1', { pageCap: 2 })
    expect(replay.complete).toBe(false)
    expect(replay.turns).toHaveLength(2)
  })

  test('a cursor that never advances ends the read as incomplete', async () => {
    const pages = [[turn()], [turn()]]
    const { client } = pagedClient(pages, { loop: true })
    const replay = await replayAddressedTurns(client, 'ws', 'channel-1')
    expect(replay.complete).toBe(false)
  })

  test('a failed page rejects the whole read: a short list is never returned as a result', async () => {
    let calls = 0
    const client = {
      listAddressedTurns: async () => {
        calls += 1
        if (calls === 2) throw new Error('503')
        return { nextAfter: 'next', turns: [turn()] }
      },
    }
    await expect(replayAddressedTurns(client, 'ws', 'channel-1')).rejects.toThrow('503')
  })
})

const replay = (
  turns: readonly ApiAddressedTurn[],
  overrides: Partial<AddressedTurnReplay> = {}
): AddressedTurnReplay => ({
  complete: true,
  conversationAudienceEpoch: 0,
  turns,
  ...overrides,
})

describe('foldAddressedTurnCache', () => {
  test('a replay from another audience replaces the held turns instead of merging into them', () => {
    const held = turn()
    const incoming = turn()
    const folded = foldAddressedTurnCache(
      replay([held]),
      replay([incoming], { conversationAudienceEpoch: 1 })
    )
    expect(folded!.turns.map((entry) => entry.id)).toEqual([incoming.id])
  })

  test('an incomplete read only advances what is held and never claims to list', () => {
    const first = turn()
    const second = turn()
    const folded = foldAddressedTurnCache(
      replay([first, second]),
      replay([at(first, 'cancelled', 1)], { complete: false })
    )
    expect(folded!.complete).toBe(false)
    expect(folded!.turns.map((entry) => entry.state)).toEqual(['cancelled', 'dispatching'])
  })

  test('the first write is stored as it arrived', () => {
    const only = replay([turn()])
    expect(foldAddressedTurnCache(undefined, only)).toBe(only)
  })
})

describe('turn predicates', () => {
  test('live means claimed or dispatching; unstarted means claimed and never admitted', () => {
    expect(isLiveAddressedTurn(turn({ state: 'claimed' }))).toBe(true)
    expect(isLiveAddressedTurn(turn({ state: 'dispatching' }))).toBe(true)
    for (const state of ['responded', 'superseded', 'cancelled'] as const)
      expect(isLiveAddressedTurn(turn({ state }))).toBe(false)
    expect(isUnstartedAddressedTurn(turn({ state: 'claimed', dispatched: false }))).toBe(true)
    expect(isUnstartedAddressedTurn(turn({ state: 'claimed', dispatched: true }))).toBe(false)
    expect(isUnstartedAddressedTurn(turn({ state: 'dispatching', dispatched: true }))).toBe(false)
  })
})
