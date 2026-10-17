/** Requested immutable metadata refs; never accepted execution or funding authority. */
export type ApiRequestedRoleModelSelections = Readonly<{
  lead?: Readonly<{ selectionRef: string; selectionRevision: number }>
  child?: Readonly<{ selectionRef: string; selectionRevision: number }>
}>
/** Structured handoff target retained on the admission intent: the exact direct
 *  session this turn coordinates, the server-verified task authority, and the
 *  generation observed at admission. Absent for legacy targetless admissions. */
export type ApiHandoffTarget = Readonly<{
  runtimeSessionId: string
  taskId?: string
  observedGeneration: number
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
  | 'REQUESTED_MODEL_MISMATCH'
  | 'MODEL_NOT_READY'
export type ApiLeadTurnStatus = Readonly<{
  schemaVersion: 'adea-lead-turn/v1'
  intentId: string
  messageId: string
  state: 'blocked' | 'prepared' | 'dispatch_pending' | LeadTurnRuntimeState
  availability: 'available' | 'unavailable'
  reasonCode?: LeadTurnReasonCode
  /** With `MODEL_NOT_READY`: the bounded readiness reason of the last refused check, never provider text. */
  readinessReason?: string
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
  /** Exact admission target retained on the intent; absent for legacy admissions. */
  handoffTarget?: ApiHandoffTarget
  /** Control-plane-reported execution observation (session + task) attached
   *  by display reads when a live lookup returned one. Execution location
   *  from control-plane records — never target authority, and never
   *  carrying a generation. Absent when unobserved, unreachable, or
   *  unconfigured. */
  observedTarget?: Readonly<{
    sessionId: string
    taskId: string
  }>
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

/** Read-only child observations; these references grant no action or artifact access. */
export type ApiLeadTurnChild = Readonly<{
  delegationId: string
  childExecutionId: string
  childAttemptId?: string
  role: string
  state:
    | 'requested'
    | 'dispatched'
    | 'running'
    | 'awaiting_input'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'manual_intervention'
  awaitingInput: boolean
  stopRequested: boolean
  acceptedAt: string
  updatedAt: string
  revision: number
  outcome?: Readonly<{
    state: 'completed' | 'failed' | 'cancelled'
    resultRef?: string
    failureCode?: string
    publication: Readonly<{
      status: 'pending' | 'published'
      resolution?: 'continue_parent' | 'manual_intervention' | 'fail_parent'
    }>
  }>
}>
export type ApiLeadTurnChildrenCursor = Readonly<{ acceptedAt: string; delegationId: string }>
export type ApiLeadTurnChildrenQuery = Readonly<{
  limit?: number
  after?: ApiLeadTurnChildrenCursor
}>
export type ApiLeadTurnChildrenPage = Readonly<{
  children: readonly ApiLeadTurnChild[]
  totalChildren: number
  complete: boolean
  next?: ApiLeadTurnChildrenCursor
}>
/** Unavailable reads carry no empty set, count, or completion claim. Pages are per-read snapshots. */
export type ApiLeadTurnChildrenResponse = Readonly<{
  leadTurn: ApiLeadTurnStatus
  childObservations:
    | (ApiLeadTurnChildrenPage & Readonly<{ availability: 'available' }>)
    | Readonly<{
        availability: 'unavailable'
        reasonCode:
          | 'NOT_DISPATCHED'
          | 'ADMISSION_SERVICE_UNAVAILABLE'
          | 'RUNTIME_UNAVAILABLE'
          | 'RUNTIME_RESPONSE_INVALID'
      }>
}>
