import type { ApiLeadChildAllowance, ApiLeadTurnChildrenQuery } from '@adea-ai/api-client'
import type { LeadChildTerminalEvidence } from '@adea-ai/db'
import {
  isRetainedChildFailureCode,
  isRetainedChildRole,
  isRetainedChildTerminalState,
} from '@adea-ai/types'
import type {
  LeadPreparedSelection,
  LeadRuntimeAdapter,
  LeadRuntimeAuthority,
} from './lead-turn-runtime'
type PublicationInput = Parameters<NonNullable<LeadRuntimeAdapter['assertPublicationCurrent']>>[0]

/** Candidate port wraps real versioned SDK methods; it adds no raw HTTP endpoint guesses. */
export type LeadSdkCandidateTransport = Readonly<{
  workspaceId: string
  /** `issuedAt` is the command's stable anchor; a retried command must repeat it. */
  prepare?: (intentId: string, issuedAt?: string) => Promise<unknown>
  /** The actual exported PiDurableLeadPreparationSchema; absent releases stay inactive. */
  preparationSchema?: Readonly<{ parse: (data: unknown) => unknown }>
  lookup?: (intentId: string) => Promise<unknown>
  /** Actual exported PiDurableLeadLookupResponseSchema, including its strict envelope. */
  lookupResponseSchema?: Readonly<{ parse: (response: unknown) => unknown }>
  dispatch: (intentId: string, preparationRef: string, issuedAt?: string) => Promise<unknown>
  children?: (dispatchId: string, page: ApiLeadTurnChildrenQuery) => Promise<unknown>
  childPublicationCurrent?: (
    dispatchId: string,
    preparationRef: string,
    delegationId: string
  ) => Promise<unknown>
  status: (dispatchId: string) => Promise<unknown>
  progress: (dispatchId: string, afterSequence: number) => Promise<unknown>
  cancel: (dispatchId: string, issuedAt?: string) => Promise<unknown>
}>
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
/**
 * Projects the control plane's `pi-lead-child-allowance/v1` disclosure. Absent input stays absent:
 * an older control plane that omits the field is not the same as `not_stated`.
 */
function childAllowanceDisclosure(value: unknown): ApiLeadChildAllowance | undefined {
  if (value === undefined) return undefined
  if (
    !record(value) ||
    value.schemaVersion !== 'pi-lead-child-allowance/v1' ||
    typeof value.executionPlanDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.executionPlanDigest)
  )
    throw new Error('RUNTIME_RESPONSE_INVALID')
  if (value.state === 'not_stated')
    return { state: 'not_stated', executionPlanDigest: value.executionPlanDigest }
  if (
    value.state !== 'stated' ||
    value.currency !== 'USD' ||
    !Number.isSafeInteger(value.maximumMicrounits) ||
    (value.maximumMicrounits as number) < 0 ||
    !Number.isSafeInteger(value.maximumTokens) ||
    (value.maximumTokens as number) < 0
  )
    throw new Error('RUNTIME_RESPONSE_INVALID')
  return {
    state: 'stated',
    executionPlanDigest: value.executionPlanDigest,
    currency: 'USD',
    maximumMicrounits: value.maximumMicrounits as number,
    maximumTokens: value.maximumTokens as number,
  }
}
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
            // The control-plane observed target (execution session + plan task)
            // passes through when wellformed so owners can compare it against
            // the retained claim; it is execution location, never authority,
            // and it carries no generation. Malformed enrichment is omitted
            // (never thrown): the core receipt must survive control-plane
            // skew, and absence simply reads as unobserved.
            const observed = ((): Record<string, { sessionId: string; taskId: string }> => {
              if (!record(receipt)) return {}
              const candidate = receipt.observedTarget
              if (!record(candidate)) return {}
              const { sessionId, taskId } = candidate
              if (
                typeof sessionId !== 'string' ||
                !sessionId.trim() ||
                typeof taskId !== 'string' ||
                !taskId.trim()
              )
                return {}
              return { observedTarget: { sessionId, taskId } }
            })()
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
                      ...observed,
                    },
            }
          },
        }
      : {}),
    ...(transport.prepare && transport.preparationSchema
      ? {
          async prepare(authority: LeadRuntimeAuthority): Promise<LeadPreparedSelection> {
            scope(authority)
            const response = await transport.prepare!(authority.intentId, authority.admittedAt)
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
            const childAllowance = childAllowanceDisclosure(value.childAllowance)
            return {
              workspaceId: transport.workspaceId,
              intentId: authority.intentId,
              executionId: value.executionId as string,
              attemptId: value.attemptId as string,
              selectionRef: value.selectionRef as string,
              selectionRevision: value.selectionRevision as number,
              preparationRef: value.preparationRef,
              expiresAt: value.expiresAt,
              ...(childAllowance ? { childAllowance } : {}),
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
      return transport.dispatch(authority.intentId, prepared.preparationRef, authority.admittedAt)
    },
    ...(transport.children
      ? {
          async children(
            authority: LeadRuntimeAuthority,
            dispatchId: string,
            page: ApiLeadTurnChildrenQuery
          ) {
            scope(authority)
            return transport.children!(dispatchId, page)
          },
        }
      : {}),
    ...(transport.childPublicationCurrent
      ? {
          async childPublicationCurrent(
            authority: LeadRuntimeAuthority,
            binding: Parameters<NonNullable<LeadRuntimeAdapter['childPublicationCurrent']>>[1],
            preparationRef: string,
            delegationId: string
          ): Promise<LeadChildTerminalEvidence> {
            scope(authority)
            const response = await transport.childPublicationCurrent!(
              binding.dispatchId,
              preparationRef,
              delegationId
            )
            if (!record(response) || !record(response.data) || !record(response.data.publication))
              throw new Error('RUNTIME_RESPONSE_INVALID')
            const value = response.data.publication
            if (
              value.schemaVersion !== 'pi-child-publication/v1' ||
              value.workspaceId !== transport.workspaceId ||
              value.intentId !== authority.intentId ||
              value.canonicalActorPrincipalId !== authority.originalActorRef ||
              value.dispatchId !== binding.dispatchId ||
              value.executionId !== binding.executionId ||
              value.attemptId !== binding.attemptId ||
              value.runtimeSessionId !== binding.runtimeSessionId ||
              value.delegationId !== delegationId ||
              !Number.isSafeInteger(value.authorityRevision) ||
              (value.authorityRevision as number) < 1 ||
              typeof value.expiresAt !== 'string' ||
              !Number.isFinite(Date.parse(value.expiresAt)) ||
              Date.parse(value.expiresAt) <= Date.now()
            )
              throw new Error('RUNTIME_RESPONSE_INVALID')
            const conclusion = value.conclusion
            if (
              conclusion !== undefined &&
              (value.state !== 'completed' ||
                typeof conclusion !== 'string' ||
                conclusion.length < 1 ||
                conclusion.length > 1024 ||
                new TextEncoder().encode(conclusion).byteLength > 1024 ||
                conclusion !== conclusion.trim() ||
                /[\p{Cc}\p{Cf}]/u.test(conclusion))
            )
              throw new Error('RUNTIME_RESPONSE_INVALID')
            // The control plane owns these strings, so the boundary checks them
            // here rather than letting an unbounded role or failure code reach
            // a surface or a receipt. The grammar is the shared one the
            // publication transaction also enforces, so a value that is
            // publishable is exactly a value that is displayable.
            if (
              !isRetainedChildTerminalState(value.state) ||
              !isRetainedChildRole(value.role) ||
              (value.failureCode !== undefined && !isRetainedChildFailureCode(value.failureCode))
            )
              throw new Error('RUNTIME_RESPONSE_INVALID')
            return {
              delegationId: value.delegationId as string,
              childExecutionId: value.childExecutionId as string,
              childAttemptId: value.childAttemptId as string,
              role: value.role as string,
              state: value.state,
              ...(value.resultRef ? { resultRef: value.resultRef as string } : {}),
              ...(conclusion ? { conclusion: conclusion as string } : {}),
              ...(value.failureCode ? { failureCode: value.failureCode as string } : {}),
              publication: 'published',
            }
          },
        }
      : {}),
    async status(authority, dispatchId) {
      scope(authority)
      return transport.status(dispatchId)
    },
    async progress(authority, dispatchId, cursor) {
      scope(authority)
      return transport.progress(dispatchId, cursor)
    },
    async cancel(authority, dispatchId, key, issuedAt) {
      scope(authority)
      if (key !== `lead-cancel:${dispatchId}`) throw new Error('RUNTIME_RESPONSE_INVALID')
      return transport.cancel(dispatchId, issuedAt)
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
