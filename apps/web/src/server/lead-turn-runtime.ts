import { createHash } from 'node:crypto'
import type {
  ApiLeadTurnStatus,
  ApiLeadTurnProgressResponse,
  LeadTurnRuntimeState,
  LeadTurnReasonCode,
} from '@adea-ai/api-client'

export type LeadRuntimeScope = Readonly<{ workspaceId: string; intentId: string; userId: string }>
export type LeadRuntimeAuthority = Readonly<{
  intentId: string
  messageId: string
  workspaceId: string
  controlPlaneWorkspaceId: string
  originalActorRef: `user:${string}`
  /** Exact requested lead choice from the immutable intent; null or absent means workspace default. */
  requestedLeadSelection?: Readonly<{ selectionRef: string; selectionRevision: number }> | null
}>
export type LeadRuntimeBinding = Readonly<{
  schemaVersion: 'pi-lead-dispatch/v1'
  dispatchId: string
  intentId: string
  executionId: string
  attemptId: string
  runtimeSessionId: string
}>
export type LeadPreparedSelection = Readonly<{
  workspaceId: string
  intentId: string
  executionId: string
  attemptId: string
  selectionRef: string
  selectionRevision: number
  preparationRef: string
  expiresAt: string
}>
export type LeadRuntimeObservation = LeadRuntimeBinding &
  Readonly<{
    state: LeadTurnRuntimeState
    observedAt: string
  }>
export type LeadRuntimeStored = Omit<
  ApiLeadTurnStatus,
  'schemaVersion' | 'availability' | 'reasonCode'
>
/** Adapter implementation uses the published SDK and existing authorized composition. */
export type LeadRuntimeAdapter = {
  /** Resolves durable admission only. Must not call a model or mint a runtime session. */
  prepare?: (input: LeadRuntimeAuthority) => Promise<LeadPreparedSelection>
  /** Reads a retained receipt by canonical intent. Never admits, funds or starts execution. */
  lookup?: (input: LeadRuntimeAuthority) => Promise<unknown>
  dispatch(
    input: LeadRuntimeAuthority,
    dispatchKey: string,
    prepared: LeadPreparedSelection
  ): Promise<unknown>
  status(input: LeadRuntimeAuthority, dispatchId: string): Promise<unknown>
  progress(input: LeadRuntimeAuthority, dispatchId: string, afterSequence: number): Promise<unknown>
  cancel(input: LeadRuntimeAuthority, dispatchId: string, cancelKey: string): Promise<unknown>
  /** Current authoritative grant, selection and payer must match this exact execution/attempt. */
  assertPublicationCurrent?: (
    input: LeadRuntimeAuthority &
      LeadRuntimeBinding &
      LeadPreparedSelection &
      Readonly<{ resultContentDigest: string }>
  ) => Promise<void>
}
/**
 * `read` observes or reconciles an admission, including archived history. `cancel` is the original
 * actor's cancellation. `effect` admits new work: prepare and dispatch, active-only and fence-gated.
 */
export type LeadRuntimeAuthorityPurpose = 'cancel' | 'effect' | 'read'
export type LeadRuntimeStore = {
  authorize(
    scope: LeadRuntimeScope,
    purpose: LeadRuntimeAuthorityPurpose
  ): Promise<LeadRuntimeAuthority>
  read(scope: LeadRuntimeScope): Promise<LeadRuntimeStored | undefined>
  prepare(scope: LeadRuntimeScope, prepared: LeadPreparedSelection): Promise<void>
  pending(scope: LeadRuntimeScope, prepared: LeadPreparedSelection): Promise<void>
  observe(scope: LeadRuntimeScope, value: LeadRuntimeObservation): Promise<LeadRuntimeStored>
  /** Persists an actual sessionful lookup binding without inferring a runtime state. */
  recover(scope: LeadRuntimeScope, binding: LeadRuntimeBinding): Promise<LeadRuntimeStored>
  cancelRequested(scope: LeadRuntimeScope): Promise<void>
  /** Calls check after canonical locks, then atomically appends Message and publication receipt. */
  publish(
    scope: LeadRuntimeScope,
    binding: LeadRuntimeBinding,
    text: string,
    check: () => Promise<void>
  ): Promise<string>
}
const STATES = [
  'starting',
  'running',
  'awaiting_input',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'unknown',
] as const
const isState = (value: unknown): value is LeadTurnRuntimeState =>
  STATES.includes(value as LeadTurnRuntimeState)
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const cpId = (prefix: string, value: unknown) =>
  typeof value === 'string' && new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`).test(value)
function binding(value: unknown, intentId: string, prior?: LeadRuntimeStored): LeadRuntimeBinding {
  if (
    !record(value) ||
    value.schemaVersion !== 'pi-lead-dispatch/v1' ||
    value.intentId !== intentId ||
    typeof value.dispatchId !== 'string' ||
    !/^dispatch_[a-f0-9]{32}$/.test(value.dispatchId) ||
    !cpId('exe', value.executionId) ||
    !cpId('att', value.attemptId) ||
    !cpId('ses', value.runtimeSessionId)
  )
    throw new Error('RUNTIME_RESPONSE_INVALID')
  for (const key of ['dispatchId', 'executionId', 'attemptId', 'runtimeSessionId'] as const)
    if (prior?.[key] !== undefined && prior[key] !== value[key])
      throw new Error('RUNTIME_RESPONSE_INVALID')
  return {
    schemaVersion: 'pi-lead-dispatch/v1',
    intentId,
    dispatchId: value.dispatchId,
    executionId: value.executionId as string,
    attemptId: value.attemptId as string,
    runtimeSessionId: value.runtimeSessionId as string,
  }
}
const REQUESTED_MODEL_MISMATCH = 'REQUESTED_MODEL_MISMATCH'
/** A requested lead choice is exact: any other prepared selection or revision is not admissible. */
function requestedLeadMatches(
  authority: LeadRuntimeAuthority,
  value: Readonly<{ selectionRef: string; selectionRevision: number }>
) {
  const requested = authority.requestedLeadSelection
  return (
    !requested ||
    (requested.selectionRef === value.selectionRef &&
      requested.selectionRevision === value.selectionRevision)
  )
}
function prepared(value: LeadPreparedSelection, authority: LeadRuntimeAuthority, now: Date) {
  if (
    value.intentId !== authority.intentId ||
    value.workspaceId !== authority.controlPlaneWorkspaceId ||
    !cpId('exe', value.executionId) ||
    !cpId('att', value.attemptId) ||
    !/^msel_[a-f0-9]{32}$/.test(value.selectionRef) ||
    !Number.isSafeInteger(value.selectionRevision) ||
    value.selectionRevision < 1 ||
    !/^prep_[a-f0-9]{32}$/.test(value.preparationRef) ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= now.getTime()
  )
    throw new Error('RUNTIME_RESPONSE_INVALID')
  return value
}

export function createLeadTurnRuntime(
  options: Readonly<{
    store: LeadRuntimeStore
    adapter?: LeadRuntimeAdapter | null
    /** Must verify a persisted exact funding display and original user's confirmation before inference. */
    authorizeConfirmedStart?: (
      authority: LeadRuntimeAuthority,
      prepared: LeadPreparedSelection
    ) => Promise<LeadPreparedSelection>
    now?: () => Date
  }>
) {
  const { store, adapter } = options
  const now = options.now ?? (() => new Date())
  async function projection(
    scope: LeadRuntimeScope,
    reasonCode?: LeadTurnReasonCode
  ): Promise<ApiLeadTurnStatus> {
    const authority = await store.authorize(scope, 'read')
    const stored = await store.read(scope)
    return {
      schemaVersion: 'adea-lead-turn/v1',
      intentId: authority.intentId,
      messageId: authority.messageId,
      state: stored?.state ?? 'blocked',
      ...(stored?.dispatchId ? { dispatchId: stored.dispatchId } : {}),
      ...(stored?.executionId ? { executionId: stored.executionId } : {}),
      ...(stored?.attemptId ? { attemptId: stored.attemptId } : {}),
      ...(stored?.selectionRef ? { selectionRef: stored.selectionRef } : {}),
      ...(stored?.selectionRevision ? { selectionRevision: stored.selectionRevision } : {}),
      ...(stored?.preparationRef ? { preparationRef: stored.preparationRef } : {}),
      ...(stored?.preparationExpiresAt
        ? { preparationExpiresAt: stored.preparationExpiresAt }
        : {}),
      ...(stored?.runtimeSessionId ? { runtimeSessionId: stored.runtimeSessionId } : {}),
      ...(stored?.observedAt ? { observedAt: stored.observedAt } : {}),
      ...(stored?.cancelRequestedAt ? { cancelRequestedAt: stored.cancelRequestedAt } : {}),
      ...(stored?.publishedMessageId ? { publishedMessageId: stored.publishedMessageId } : {}),
      availability: reasonCode || !adapter ? 'unavailable' : 'available',
      ...(reasonCode
        ? { reasonCode }
        : !adapter
          ? { reasonCode: 'ADMISSION_SERVICE_UNAVAILABLE' }
          : {}),
    }
  }
  async function observation(scope: LeadRuntimeScope, value: unknown) {
    const prior = await store.read(scope)
    const bound = binding(value, scope.intentId, prior)
    if (!record(value) || !isState(value.state)) throw new Error('RUNTIME_RESPONSE_INVALID')
    const at =
      record(value.status) && typeof value.status.observedAt === 'string'
        ? value.status.observedAt
        : now().toISOString()
    if (!Number.isFinite(Date.parse(at))) throw new Error('RUNTIME_RESPONSE_INVALID')
    await store.observe(scope, { ...bound, state: value.state, observedAt: at })
    return bound
  }
  async function guarded(scope: LeadRuntimeScope, work: () => Promise<void>) {
    try {
      await work()
      return await projection(scope)
    } catch (error) {
      return projection(
        scope,
        error instanceof Error && error.message === 'RUNTIME_RESPONSE_INVALID'
          ? 'RUNTIME_RESPONSE_INVALID'
          : error instanceof Error && error.message === REQUESTED_MODEL_MISMATCH
            ? 'REQUESTED_MODEL_MISMATCH'
            : 'RUNTIME_UNAVAILABLE'
      )
    }
  }
  return {
    snapshot: projection,
    async prepare(scope: LeadRuntimeScope) {
      const authority = await store.authorize(scope, 'effect')
      if (!adapter?.prepare) return projection(scope, 'ADMISSION_SERVICE_UNAVAILABLE')
      return guarded(scope, async () => {
        const selected = prepared(await adapter.prepare!(authority), authority, now())
        // Refuse before any preparation is stored: the runtime may not substitute another model.
        if (!requestedLeadMatches(authority, selected)) throw new Error(REQUESTED_MODEL_MISMATCH)
        await store.prepare(scope, selected)
      })
    },
    async dispatch(scope: LeadRuntimeScope) {
      const authority = await store.authorize(scope, 'effect')
      if (!adapter) return projection(scope, 'ADMISSION_SERVICE_UNAVAILABLE')
      if (!options.authorizeConfirmedStart)
        return projection(scope, 'FUNDING_CONFIRMATION_REQUIRED')
      const prior = await store.read(scope)
      if (
        !prior?.executionId ||
        !prior.attemptId ||
        !prior.selectionRef ||
        !prior.selectionRevision ||
        !prior.preparationRef ||
        !prior.preparationExpiresAt
      )
        return projection(scope, 'FUNDING_CONFIRMATION_REQUIRED')
      return guarded(scope, async () => {
        const accepted = prepared(
          {
            workspaceId: authority.controlPlaneWorkspaceId,
            intentId: authority.intentId,
            executionId: prior.executionId!,
            attemptId: prior.attemptId!,
            selectionRef: prior.selectionRef!,
            selectionRevision: prior.selectionRevision!,
            preparationRef: prior.preparationRef!,
            expiresAt: prior.preparationExpiresAt!,
          },
          authority,
          now()
        )
        if (!requestedLeadMatches(authority, accepted)) throw new Error(REQUESTED_MODEL_MISMATCH)
        const pin = prepared(
          await options.authorizeConfirmedStart!(authority, accepted),
          authority,
          now()
        )
        for (const key of [
          'workspaceId',
          'intentId',
          'executionId',
          'attemptId',
          'selectionRef',
          'selectionRevision',
          'preparationRef',
          'expiresAt',
        ] as const)
          if (pin[key] !== accepted[key]) throw new Error('RUNTIME_RESPONSE_INVALID')
        await store.pending(scope, pin)
        const value = await adapter.dispatch(authority, `lead-turn:${scope.intentId}`, pin)
        const bound = binding(value, scope.intentId, await store.read(scope))
        if (bound.executionId !== pin.executionId || bound.attemptId !== pin.attemptId)
          throw new Error('RUNTIME_RESPONSE_INVALID')
        await observation(scope, value)
      })
    },
    async status(scope: LeadRuntimeScope) {
      const authority = await store.authorize(scope, 'read')
      let prior = await store.read(scope)
      if (!adapter) return projection(scope, 'ADMISSION_SERVICE_UNAVAILABLE')
      let withheld = false
      const result = await guarded(scope, async () => {
        if (!prior?.dispatchId && prior?.state === 'dispatch_pending' && adapter.lookup) {
          const value = await adapter.lookup(authority)
          if (
            !record(value) ||
            value.schemaVersion !== 'pi-lead-lookup/v1' ||
            value.workspaceId !== authority.controlPlaneWorkspaceId ||
            value.intentId !== scope.intentId ||
            (value.receipt !== null && !record(value.receipt))
          )
            throw new Error('RUNTIME_RESPONSE_INVALID')
          if (value.receipt === null) return
          const receipt = value.receipt as Record<string, unknown>
          if (
            !['dispatching', 'dispatched', 'reconciliation_required'].includes(
              receipt.state as string
            ) ||
            typeof receipt.dispatchId !== 'string' ||
            !/^dispatch_[a-f0-9]{32}$/.test(receipt.dispatchId) ||
            !cpId('exe', receipt.executionId) ||
            !cpId('att', receipt.attemptId) ||
            receipt.executionId !== prior.executionId ||
            receipt.attemptId !== prior.attemptId
          )
            throw new Error('RUNTIME_RESPONSE_INVALID')
          if (receipt.runtimeSessionId === undefined) return
          const recovered = binding(
            { ...receipt, schemaVersion: 'pi-lead-dispatch/v1', intentId: scope.intentId },
            scope.intentId,
            prior
          )
          // Recheck current audience after the transport await; the repository holds the same pins at commit.
          await store.authorize(scope, 'read')
          prior = await store.recover(scope, recovered)
        }
        if (!prior?.dispatchId) return
        const pinned = prior
        const value = await adapter.status(authority, prior.dispatchId!)
        const bound = await observation(scope, value)
        if (!record(value) || value.state !== 'completed') return
        const output =
          record(value.status) && record(value.status.result) && record(value.status.result.output)
            ? value.status.result.output.text
            : undefined
        if (
          typeof output !== 'string' ||
          !output.trim() ||
          output.length > 100_000 ||
          !adapter.assertPublicationCurrent ||
          !prior.selectionRef ||
          !prior.selectionRevision ||
          !prior.preparationRef ||
          !prior.preparationExpiresAt
        ) {
          withheld = true
          return
        }
        try {
          await store.publish(scope, bound, output, () =>
            adapter.assertPublicationCurrent!({
              ...authority,
              ...bound,
              workspaceId: authority.controlPlaneWorkspaceId,
              selectionRef: pinned.selectionRef!,
              selectionRevision: pinned.selectionRevision!,
              preparationRef: pinned.preparationRef!,
              expiresAt: pinned.preparationExpiresAt!,
              resultContentDigest: `sha256:${createHash('sha256').update(output).digest('hex')}`,
            })
          )
        } catch {
          withheld = true
        }
      })
      return withheld ? projection(scope, 'PUBLICATION_WITHHELD') : result
    },
    async cancel(scope: LeadRuntimeScope) {
      const authority = await store.authorize(scope, 'cancel')
      const prior = await store.read(scope)
      if (!adapter) return projection(scope, 'ADMISSION_SERVICE_UNAVAILABLE')
      if (!prior?.dispatchId) return projection(scope, 'RUNTIME_UNAVAILABLE')
      return guarded(scope, async () => {
        await store.cancelRequested(scope)
        await observation(
          scope,
          await adapter.cancel(authority, prior.dispatchId!, `lead-cancel:${prior.dispatchId}`)
        )
      })
    },
    async progress(
      scope: LeadRuntimeScope,
      afterSequence = 0
    ): Promise<ApiLeadTurnProgressResponse> {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
        throw new Error('Invalid lead progress cursor')
      const authority = await store.authorize(scope, 'read')
      const prior = await store.read(scope)
      if (!adapter || !prior?.dispatchId)
        return { leadTurn: await projection(scope), events: [], nextSequence: afterSequence }
      try {
        const value = await adapter.progress(authority, prior.dispatchId, afterSequence)
        binding(value, scope.intentId, prior)
        if (
          !record(value) ||
          !Array.isArray(value.events) ||
          value.events.length > 256 ||
          !Number.isSafeInteger(value.nextSequence) ||
          (value.nextSequence as number) < afterSequence
        )
          throw new Error('RUNTIME_RESPONSE_INVALID')
        let sequence = afterSequence
        const events = value.events.map((event) => {
          if (
            !record(event) ||
            !Number.isSafeInteger(event.sequence) ||
            (event.sequence as number) <= sequence ||
            typeof event.occurredAt !== 'string' ||
            !Number.isFinite(Date.parse(event.occurredAt)) ||
            !['status', 'output', 'interaction', 'usage', 'artifact'].includes(event.type as string)
          )
            throw new Error('RUNTIME_RESPONSE_INVALID')
          sequence = event.sequence as number
          return {
            sequence,
            occurredAt: event.occurredAt,
            type: event.type as 'status' | 'output' | 'interaction' | 'usage' | 'artifact',
            ...(event.type === 'status' && record(event.data) && isState(event.data.state)
              ? { state: event.data.state }
              : {}),
          }
        })
        if (value.nextSequence !== sequence) throw new Error('RUNTIME_RESPONSE_INVALID')
        return { leadTurn: await projection(scope), events, nextSequence: sequence }
      } catch {
        return {
          leadTurn: await projection(scope, 'RUNTIME_RESPONSE_INVALID'),
          events: [],
          nextSequence: afterSequence,
        }
      }
    },
  }
}
