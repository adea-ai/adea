/** Participant-visible addressed Agent turn (adea-ai/adea#1179). Mirrors the product projection. */
export type ApiAddressedTurnState =
  | 'claimed'
  | 'dispatching'
  | 'responded'
  | 'superseded'
  | 'cancelled'

export type ApiAddressedTurn = Readonly<{
  id: string
  /** Deterministic causal ID: `turn:<triggerMessageId>:<agentId>:<dispatchRevision>`. */
  causalId: string
  channelId: string
  /** The human message that caused the turn. */
  triggerMessageId: string
  agentId: string
  /** `<Agent source workspace>:<agent id>`, bound to the Agent's verified home workspace. */
  addressedLabel: string
  /** The human who addressed the Agent; the turn is attributed to them. */
  addresserUserId: string
  dispatchRevision: number
  parentTurnId: string | null
  depth: number
  budget: Readonly<{ maxDepth: number; maxTurns: number }>
  state: ApiAddressedTurnState
  /** True once a lead-turn intent was admitted for this turn. */
  dispatched: boolean
  /** The lead-turn intent, present only for the addresser who owns it. */
  leadTurnIntentId: string | null
  /** The Agent's one recorded answer for this (message, Agent, revision), once published. */
  responseMessageId: string | null
  createdAt: string
  updatedAt: string
}>

export type ApiAddressedTurnInput = Readonly<{
  agentId: string
  dispatchRevision: number
  parentTurnId?: string | null
  triggerMessageId: string
}>

export type ApiAddressedTurnResponse = Readonly<{
  /** False when the request converged on a turn that already existed. */
  created: boolean
  /** `not_lead`: the claim is retained, but only the resolved group lead can run today. */
  dispatch: 'admitted' | 'not_lead'
  turn: ApiAddressedTurn
}>

export type ApiAddressedTurnCancelResponse = Readonly<{
  runtimeCancelRequested: boolean
  turn: ApiAddressedTurn
}>

/** Turns in committed order; pass `nextAfter` as `after` to continue after a reconnect. */
export type ApiAddressedTurnPage = Readonly<{
  nextAfter: string | null
  turns: readonly ApiAddressedTurn[]
}>
