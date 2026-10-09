/** Requested immutable metadata refs; never accepted execution or funding authority. */
export type ApiRequestedRoleModelSelections = Readonly<{
  lead?: Readonly<{ selectionRef: string; selectionRevision: number }>
  child?: Readonly<{ selectionRef: string; selectionRevision: number }>
}>

/** Product projection; runtime state is observed, never inferred from Message persistence. */
export type LeadTurnRuntimeState =
  | 'starting'
  | 'running'
  | 'awaiting_input'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'unknown'
export type LeadTurnReasonCode =
  | 'ADMISSION_SERVICE_UNAVAILABLE'
  | 'AUTHORITY_CHANGED'
  | 'RUNTIME_UNAVAILABLE'
  | 'RUNTIME_RESPONSE_INVALID'
  | 'PUBLICATION_WITHHELD'
  | 'FUNDING_CONFIRMATION_REQUIRED'
export type ApiLeadTurnStatus = Readonly<{
  schemaVersion: 'adea-lead-turn/v1'
  intentId: string
  messageId: string
  state: 'blocked' | 'prepared' | 'dispatch_pending' | LeadTurnRuntimeState
  availability: 'available' | 'unavailable'
  reasonCode?: LeadTurnReasonCode
  dispatchId?: string
  executionId?: string
  attemptId?: string
  /** Present only after the trusted prepare persisted the exact selection and disclosure reference. */
  selectionRef?: string
  selectionRevision?: number
  preparationRef?: string
  preparationExpiresAt?: string
  /** Reference to the canonical runtime session, not a second session record. */
  runtimeSessionId?: string
  observedAt?: string
  cancelRequestedAt?: string
  publishedMessageId?: string
}>
export type ApiLeadTurnResponse = Readonly<{ leadTurn: ApiLeadTurnStatus }>
export type ApiChannelLeadTurnResponse = Readonly<{ leadTurn: ApiLeadTurnStatus | null }>
export type ApiLeadTurnProgress = Readonly<{
  sequence: number
  occurredAt: string
  type: 'status' | 'output' | 'interaction' | 'usage' | 'artifact'
  state?: LeadTurnRuntimeState
}>
export type ApiLeadTurnProgressResponse = ApiLeadTurnResponse &
  Readonly<{
    events: readonly ApiLeadTurnProgress[]
    nextSequence: number
  }>
