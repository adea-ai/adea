import type {
  AgentHqApiClient,
  ApiAddressedTurn,
  ApiAddressedTurnCancelResponse,
  ApiAddressedTurnInput,
  ApiAddressedTurnResponse,
  ApiAddressedTurnState,
} from '@adea-ai/api-client'
import { workspaceStore } from '@adea-ai/state'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/solid-query'

/**
 * Addressed Agent turns in a group conversation (adea-ai/adea#1179).
 *
 * The server owns the truth: one durable row per (trigger message, Agent, dispatch revision). This module
 * keeps the client's copy convergent with it. Every path that can deliver a turn (the address response, a
 * cancel response, a reconnect replay, a second tab's replay, a retried request) is folded through the
 * same `foldAddressedTurns`, which is idempotent, order-insensitive for state and never regresses a turn.
 */

export const addressedTurnQueryKeys = {
  // Under the channel prefix so a workspace release and channel events drop and refresh it.
  list: (workspaceId: string, channelId: string) =>
    ['workspaces', workspaceId, 'channels', channelId, 'addressed-turns'] as const,
}

/** Pages one replay read may walk (200 turns each) before it gives up and reports an incomplete read. */
export const ADDRESSED_TURN_REPLAY_PAGE_CAP = 25
const ADDRESSED_TURN_PAGE_SIZE = 200

/** How often live turns are re-read when no event has arrived. */
export const ADDRESSED_TURN_LIVE_REFETCH_INTERVAL_MS = 3_000

/** A turn can still change: it was claimed or dispatched and has no outcome yet. */
export function isLiveAddressedTurn(turn: Pick<ApiAddressedTurn, 'state'>): boolean {
  return turn.state === 'claimed' || turn.state === 'dispatching'
}

/**
 * A turn that was recorded but never admitted: nothing has started for it. `dispatched` becomes true
 * only when a lead-turn intent is bound, so a claim that stays undispatched is the "not the lead" case.
 */
export function isUnstartedAddressedTurn(
  turn: Pick<ApiAddressedTurn, 'dispatched' | 'state'>
): boolean {
  return turn.state === 'claimed' && !turn.dispatched
}

const STATE_RANK: Readonly<Record<ApiAddressedTurnState, number>> = {
  claimed: 0,
  dispatching: 1,
  // Terminal states never move again, so they outrank every live state.
  responded: 2,
  superseded: 2,
  cancelled: 2,
}

/**
 * Picks the more advanced of two copies of the same turn. A later state wins; at an equal state the later
 * `updatedAt` wins; a full tie keeps the copy already held. A stale replay can therefore never turn a
 * cancelled or answered turn back into a live one, and an old copy of a live turn can never overwrite a
 * newer one.
 */
export function advanceAddressedTurn(held: ApiAddressedTurn, incoming: ApiAddressedTurn) {
  const rank = STATE_RANK[incoming.state] - STATE_RANK[held.state]
  if (rank !== 0) return rank > 0 ? incoming : held
  if (incoming.state !== held.state && STATE_RANK[incoming.state] === 2) return held
  if (incoming.updatedAt > held.updatedAt) return incoming
  if (incoming.updatedAt < held.updatedAt) return held
  // Same state, same instant: prefer the copy that knows more (the answer, the owner's intent).
  const heldKnows = Number(held.responseMessageId !== null) + Number(held.leadTurnIntentId !== null)
  const incomingKnows =
    Number(incoming.responseMessageId !== null) + Number(incoming.leadTurnIntentId !== null)
  return incomingKnows > heldKnows ? incoming : held
}

/** The server's own order: creation time, then id. Used only to place a turn the server has not listed. */
export function compareAddressedTurns(left: ApiAddressedTurn, right: ApiAddressedTurn): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1
  if (left.id !== right.id) return left.id < right.id ? -1 : 1
  return 0
}

/**
 * Folds turns into the held list. Identity is the causal ID (`turn:<message>:<agent>:<revision>`), which
 * is exactly the server's "at most one response per message, Agent and revision" key, so a duplicate
 * request, a retried response and a replay of the same turn all land on one row. Held order is kept; a
 * new turn is placed in `(createdAt, id)` order.
 */
export function foldAddressedTurns(
  held: readonly ApiAddressedTurn[],
  incoming: readonly ApiAddressedTurn[]
): readonly ApiAddressedTurn[] {
  const result = [...held]
  const index = new Map(result.map((turn, position) => [turn.causalId, position]))
  for (const turn of incoming) {
    const position = index.get(turn.causalId)
    if (position !== undefined) {
      result[position] = advanceAddressedTurn(result[position]!, turn)
      continue
    }
    let insertAt = result.length
    while (insertAt > 0 && compareAddressedTurns(turn, result[insertAt - 1]!) < 0) insertAt -= 1
    result.splice(insertAt, 0, turn)
    for (const [causalId, at] of index) if (at >= insertAt) index.set(causalId, at + 1)
    index.set(turn.causalId, insertAt)
  }
  return result
}

/**
 * Applies one complete replay (the server's committed order) to the held list. The replay is
 * authoritative for which turns this reader may see, and for their order. Held turns it does not list
 * survive only when they are newer than everything it did list: that is a turn committed after the read
 * began. An older absent turn is one the reader can no longer see (a revoked audience, a withheld trigger)
 * and is dropped, so a replay never leaves a ghost of withheld history behind.
 */
export function applyAddressedTurnReplay(
  held: readonly ApiAddressedTurn[],
  replay: readonly ApiAddressedTurn[]
): readonly ApiAddressedTurn[] {
  const heldByCausalId = new Map(held.map((turn) => [turn.causalId, turn]))
  const listed = new Set<string>()
  const result: ApiAddressedTurn[] = []
  for (const turn of replay) {
    if (listed.has(turn.causalId)) continue
    listed.add(turn.causalId)
    const known = heldByCausalId.get(turn.causalId)
    result.push(known ? advanceAddressedTurn(known, turn) : turn)
  }
  const newest = replay.reduce<string | null>(
    (latest, turn) => (latest === null || turn.createdAt > latest ? turn.createdAt : latest),
    null
  )
  const survivors = held
    .filter((turn) => !listed.has(turn.causalId) && (newest === null || turn.createdAt > newest))
    .toSorted(compareAddressedTurns)
  return [...result, ...survivors]
}

export type AddressedTurnReplay = Readonly<{
  /** Always the audience epoch the read ran under, so a read from a replaced audience is discarded. */
  conversationAudienceEpoch: number
  /** False when the page cap was reached: the newest turns were not read. Never presented as complete. */
  complete: boolean
  turns: readonly ApiAddressedTurn[]
}>

/** Reads every page of the channel's turns in committed order, from the start. */
export async function replayAddressedTurns(
  client: Pick<AgentHqApiClient, 'listAddressedTurns'>,
  workspaceId: string,
  channelId: string,
  options: Readonly<{ pageCap?: number; pageSize?: number }> = {}
): Promise<Pick<AddressedTurnReplay, 'complete' | 'turns'>> {
  const pageCap = options.pageCap ?? ADDRESSED_TURN_REPLAY_PAGE_CAP
  const limit = options.pageSize ?? ADDRESSED_TURN_PAGE_SIZE
  const turns: ApiAddressedTurn[] = []
  let after: string | undefined
  for (let page = 0; page < pageCap; page += 1) {
    const result = await client.listAddressedTurns(workspaceId, channelId, {
      ...(after ? { after } : {}),
      limit,
    })
    turns.push(...result.turns)
    if (result.nextAfter === null) return { complete: true, turns }
    // A cursor that does not advance would loop forever; treat it as an unfinished read.
    if (result.nextAfter === after) return { complete: false, turns }
    after = result.nextAfter
  }
  return { complete: false, turns }
}

/** The cache write rule: a complete replay is authoritative for listing; anything else only advances. */
export function foldAddressedTurnCache(
  held: unknown,
  next: unknown
): AddressedTurnReplay | undefined {
  const incoming = next as AddressedTurnReplay | undefined
  const current = held as AddressedTurnReplay | undefined
  if (!incoming || !current) return incoming
  // A page from another audience says nothing about this one's turns.
  if (current.conversationAudienceEpoch !== incoming.conversationAudienceEpoch) return incoming
  return {
    complete: incoming.complete,
    conversationAudienceEpoch: incoming.conversationAudienceEpoch,
    turns: incoming.complete
      ? applyAddressedTurnReplay(current.turns, incoming.turns)
      : foldAddressedTurns(current.turns, incoming.turns),
  }
}

export const addressedTurnQueryOptions = {
  list: (client: AgentHqApiClient, workspaceId?: string, channelId?: string) => ({
    queryKey: addressedTurnQueryKeys.list(workspaceId ?? '', channelId ?? ''),
    queryFn: async (): Promise<AddressedTurnReplay> => {
      const conversationAudienceEpoch =
        workspaceStore.getState().conversationAudienceEpochs[workspaceId!] ?? 0
      const replay = await replayAddressedTurns(client, workspaceId!, channelId!)
      return { ...replay, conversationAudienceEpoch }
    },
    enabled: Boolean(workspaceId && channelId),
    // Every write to this cache (a replay, a reconnect, a second refetch, a mutation result) is folded
    // against what is held, so no path can regress a turn or resurrect a turn the reader lost.
    structuralSharing: foldAddressedTurnCache,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    // Reads never start work, so polling live turns is safe; it stops the moment none are live.
    refetchInterval: (query: { state: { data: AddressedTurnReplay | undefined } }) =>
      query.state.data?.turns.some(isLiveAddressedTurn)
        ? ADDRESSED_TURN_LIVE_REFETCH_INTERVAL_MS
        : (false as const),
  }),
}

type AddressedTurnCache = AddressedTurnReplay | undefined

/**
 * Folds one turn that arrived on its own (an address or cancel response) into the held replay. A held
 * list from another audience is left alone: the refetch that follows replaces it.
 */
export function foldTurnIntoReplay(
  current: AddressedTurnCache,
  turn: ApiAddressedTurn,
  audienceEpoch: number
): AddressedTurnCache {
  if (current && current.conversationAudienceEpoch !== audienceEpoch) return current
  return {
    complete: current?.complete ?? false,
    conversationAudienceEpoch: audienceEpoch,
    turns: foldAddressedTurns(current?.turns ?? [], [turn]),
  }
}

/** Folds mutation results into the cache without waiting for the next replay. */
function foldIntoCache(
  queryClient: QueryClient,
  workspaceId: string,
  channelId: string,
  turn: ApiAddressedTurn
) {
  const key = addressedTurnQueryKeys.list(workspaceId, channelId)
  queryClient.setQueryData<AddressedTurnCache>(key, (current) =>
    foldTurnIntoReplay(current, turn, audienceEpochOf(workspaceId))
  )
}

function audienceEpochOf(workspaceId: string) {
  return workspaceStore.getState().conversationAudienceEpochs[workspaceId] ?? 0
}

export const addressedTurnMutationOptions = {
  address: (
    client: AgentHqApiClient,
    queryClient: QueryClient,
    workspaceId: string,
    channelId: string
  ) => ({
    mutationFn: (input: ApiAddressedTurnInput) => client.addressTurn(workspaceId, channelId, input),
    onMutate: () => ({ audienceEpoch: audienceEpochOf(workspaceId) }),
    onSuccess: async (
      result: ApiAddressedTurnResponse,
      _variables: unknown,
      context?: { audienceEpoch: number }
    ) => {
      if (context?.audienceEpoch !== audienceEpochOf(workspaceId)) return
      foldIntoCache(queryClient, workspaceId, channelId, result.turn)
      await queryClient.invalidateQueries({
        queryKey: addressedTurnQueryKeys.list(workspaceId, channelId),
      })
    },
  }),
  cancel: (
    client: AgentHqApiClient,
    queryClient: QueryClient,
    workspaceId: string,
    channelId: string
  ) => ({
    mutationFn: (turnId: string) => client.cancelAddressedTurn(workspaceId, channelId, turnId),
    onMutate: () => ({ audienceEpoch: audienceEpochOf(workspaceId) }),
    onSuccess: async (
      result: ApiAddressedTurnCancelResponse,
      _variables: unknown,
      context?: { audienceEpoch: number }
    ) => {
      if (context?.audienceEpoch !== audienceEpochOf(workspaceId)) return
      foldIntoCache(queryClient, workspaceId, channelId, result.turn)
      await queryClient.invalidateQueries({
        queryKey: addressedTurnQueryKeys.list(workspaceId, channelId),
      })
    },
    // A refused cancel (already answered, superseded) is a fact about the turn: read it back.
    onError: async () => {
      await queryClient.invalidateQueries({
        queryKey: addressedTurnQueryKeys.list(workspaceId, channelId),
      })
    },
  }),
}

type MaybeAccessor<T> = T | (() => T)
function resolve<T>(value: MaybeAccessor<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

/** The group's addressed turns in committed order. A cache from a replaced audience is not served. */
export function useAddressedTurnsQuery(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string | undefined>,
  channelId: MaybeAccessor<string | undefined>,
  options: Readonly<{ enabled?: MaybeAccessor<boolean> }> = {}
) {
  return useQuery(() => {
    const base = addressedTurnQueryOptions.list(client, resolve(workspaceId), resolve(channelId))
    const enabled = options.enabled === undefined ? true : resolve(options.enabled)
    return { ...base, enabled: base.enabled && enabled }
  })
}

export function useAddressTurnMutation(
  client: MaybeAccessor<AgentHqApiClient>,
  workspaceId: MaybeAccessor<string>,
  channelId: MaybeAccessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    addressedTurnMutationOptions.address(
      resolve(client),
      queryClient,
      resolve(workspaceId),
      resolve(channelId)
    )
  )
}

export function useCancelAddressedTurnMutation(
  client: MaybeAccessor<AgentHqApiClient>,
  workspaceId: MaybeAccessor<string>,
  channelId: MaybeAccessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    addressedTurnMutationOptions.cancel(
      resolve(client),
      queryClient,
      resolve(workspaceId),
      resolve(channelId)
    )
  )
}
