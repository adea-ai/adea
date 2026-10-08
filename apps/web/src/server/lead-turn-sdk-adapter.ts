import type {
  LeadPreparedSelection,
  LeadRuntimeAdapter,
  LeadRuntimeAuthority,
} from './lead-turn-runtime'
type PublicationInput = Parameters<NonNullable<LeadRuntimeAdapter['assertPublicationCurrent']>>[0]

/** Candidate port wraps real versioned SDK methods; it adds no raw HTTP endpoint guesses. */
export type LeadSdkCandidateTransport = Readonly<{
  workspaceId: string
  prepare?: (intentId: string) => Promise<unknown>
  /** The actual exported PiDurableLeadPreparationSchema; absent releases stay inactive. */
  preparationSchema?: Readonly<{ parse: (data: unknown) => unknown }>
  lookup?: (intentId: string) => Promise<unknown>
  /** Actual exported PiDurableLeadLookupResponseSchema, including its strict envelope. */
  lookupResponseSchema?: Readonly<{ parse: (response: unknown) => unknown }>
  dispatch: (intentId: string, preparationRef: string) => Promise<unknown>
  status: (dispatchId: string) => Promise<unknown>
  progress: (dispatchId: string, afterSequence: number) => Promise<unknown>
  cancel: (dispatchId: string) => Promise<unknown>
}>
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
export function createLeadTurnSdkAdapter(
  transport: LeadSdkCandidateTransport,
  assertPublicationCurrent?: LeadRuntimeAdapter['assertPublicationCurrent']
): LeadRuntimeAdapter {
  function scope(authority: LeadRuntimeAuthority) {
    if (
      authority.controlPlaneWorkspaceId !== transport.workspaceId ||
      !/^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        authority.originalActorRef
      )
    )
      throw new Error('RUNTIME_RESPONSE_INVALID')
  }
  return {
    ...(transport.lookup && transport.lookupResponseSchema
      ? {
          async lookup(authority: LeadRuntimeAuthority) {
            scope(authority)
            const response = transport.lookupResponseSchema!.parse(
              await transport.lookup!(authority.intentId)
            )
            if (
              !record(response) ||
              !record(response.data) ||
              response.data.schemaVersion !== 'pi-lead-lookup/v1' ||
              response.data.workspaceId !== transport.workspaceId ||
              response.data.intentId !== authority.intentId
            )
              throw new Error('RUNTIME_RESPONSE_INVALID')
            const receipt = response.data.receipt
            if (receipt !== null && !record(receipt)) throw new Error('RUNTIME_RESPONSE_INVALID')
            // Project the bounded receipt only; no inference from its dispatch bookkeeping state.
            return {
              schemaVersion: 'pi-lead-lookup/v1',
              workspaceId: transport.workspaceId,
              intentId: authority.intentId,
              receipt:
                receipt === null
                  ? null
                  : {
                      dispatchId: receipt.dispatchId,
                      executionId: receipt.executionId,
                      attemptId: receipt.attemptId,
                      state: receipt.state,
                      ...(receipt.runtimeSessionId !== undefined
                        ? { runtimeSessionId: receipt.runtimeSessionId }
                        : {}),
                    },
            }
          },
        }
      : {}),
    ...(transport.prepare && transport.preparationSchema
      ? {
          async prepare(authority: LeadRuntimeAuthority): Promise<LeadPreparedSelection> {
            scope(authority)
            const response = await transport.prepare!(authority.intentId)
            if (!record(response)) throw new Error('RUNTIME_RESPONSE_INVALID')
            const value = transport.preparationSchema!.parse(response.data)
            if (
              !record(value) ||
              value.schemaVersion !== 'pi-lead-preparation/v1' ||
              value.intentId !== authority.intentId ||
              !record(value.funding) ||
              value.funding.workspaceId !== transport.workspaceId ||
              value.funding.state !== 'ready' ||
              value.funding.schemaVersion !== 'model-funding-display/v1' ||
              typeof value.preparationRef !== 'string' ||
              !/^prep_[a-f0-9]{32}$/.test(value.preparationRef) ||
              typeof value.expiresAt !== 'string' ||
              !Number.isFinite(Date.parse(value.expiresAt)) ||
              !Number.isSafeInteger(value.selectionRevision) ||
              (value.selectionRevision as number) < 1
            )
              throw new Error('RUNTIME_RESPONSE_INVALID')
            for (const key of [
              'executionId',
              'attemptId',
              'selectionRef',
              'selectionRevision',
            ] as const)
              if (value[key] !== value.funding[key]) throw new Error('RUNTIME_RESPONSE_INVALID')
            if (
              typeof value.funding.expiresAt !== 'string' ||
              !Number.isFinite(Date.parse(value.funding.expiresAt)) ||
              Date.parse(value.expiresAt) > Date.parse(value.funding.expiresAt)
            )
              throw new Error('RUNTIME_RESPONSE_INVALID')
            return {
              workspaceId: transport.workspaceId,
              intentId: authority.intentId,
              executionId: value.executionId as string,
              attemptId: value.attemptId as string,
              selectionRef: value.selectionRef as string,
              selectionRevision: value.selectionRevision as number,
              preparationRef: value.preparationRef,
              expiresAt: value.expiresAt,
            }
          },
        }
      : {}),
    async dispatch(authority, key, prepared) {
      scope(authority)
      if (
        key !== `lead-turn:${authority.intentId}` ||
        prepared.intentId !== authority.intentId ||
        prepared.workspaceId !== authority.controlPlaneWorkspaceId ||
        !/^prep_[a-f0-9]{32}$/.test(prepared.preparationRef)
      )
        throw new Error('RUNTIME_RESPONSE_INVALID')
      return transport.dispatch(authority.intentId, prepared.preparationRef)
    },
    async status(authority, dispatchId) {
      scope(authority)
      return transport.status(dispatchId)
    },
    async progress(authority, dispatchId, cursor) {
      scope(authority)
      return transport.progress(dispatchId, cursor)
    },
    async cancel(authority, dispatchId, key) {
      scope(authority)
      if (key !== `lead-cancel:${dispatchId}`) throw new Error('RUNTIME_RESPONSE_INVALID')
      return transport.cancel(dispatchId)
    },
    ...(assertPublicationCurrent
      ? {
          async assertPublicationCurrent(authority: PublicationInput) {
            scope(authority)
            await assertPublicationCurrent(authority)
          },
        }
      : {}),
  }
}
