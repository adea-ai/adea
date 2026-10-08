/** Candidate-only typed client. Production dependency pins and signer scopes remain unchanged. */
import { createHash } from 'node:crypto'
import {
  ControlApiOperations,
  ControlPlaneClient,
  ControlPlaneClientError,
  PublicContractManifest,
} from '@adea-ai/sdk'
export {
  PiDurableLeadPreparationSchema as candidatePreparationSchema,
  PiDurableLeadLookupResponseSchema as candidateLookupResponseSchema,
} from '@adea-ai/runtime-sdk'

type Options = Readonly<{
  baseUrl: string
  /** Synthetic fixture bearer, never provider authentication. */
  serviceToken: string
  workspaceId: string
  servicePrincipalId: string
  requestId: () => string
  traceId: () => string
  commandId: () => string
  now: () => Date
  fetch?: typeof fetch
}>
type Identity = Readonly<{ requestId: string; correlation: Readonly<{ traceId: string }> }>

export class CandidateLeadDispatchError extends Error {
  constructor(readonly code: string) {
    super('Candidate lead operation was not accepted')
    this.name = 'CandidateLeadDispatchError'
  }
}

export function createCandidateLeadDispatch(options: Options) {
  const url = new URL(options.baseUrl)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new CandidateLeadDispatchError('CANDIDATE_LOOPBACK_REQUIRED')
  const client = new ControlPlaneClient({
    baseUrl: url,
    credential: options.serviceToken,
    timeoutMs: 5_000,
    fetch: options.fetch,
  })
  function identity() {
    return {
      contractVersion: PublicContractManifest.current,
      caller: { servicePrincipalId: options.servicePrincipalId },
      workspaceId: options.workspaceId,
      requestId: options.requestId(),
      correlation: { traceId: options.traceId() },
    }
  }
  function read(operation: string, parameters: unknown) {
    return { ...identity(), operation, requestedAt: options.now().toISOString(), parameters }
  }
  function command(operation: string, payload: Record<string, string>, idempotencyKey: string) {
    return {
      ...identity(),
      operation,
      payload,
      commandId: options.commandId(),
      idempotencyKey,
      issuedAt: options.now().toISOString(),
      // Field order is fixed by this consumer before hashing canonical payloads.
      payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    }
  }
  async function invoke<Input extends Identity, Output extends Identity>(
    request: Input,
    call: (value: Input) => Promise<Output>
  ) {
    try {
      const response = await call(request)
      if (
        response.requestId !== request.requestId ||
        response.correlation.traceId !== request.correlation.traceId
      )
        throw new CandidateLeadDispatchError('CANDIDATE_RESPONSE_MISMATCH')
      return response
    } catch (error) {
      if (error instanceof CandidateLeadDispatchError) throw error
      if (error instanceof ControlPlaneClientError && error.requestId === request.requestId) {
        const allowed = [
          'PI_LEAD_PROJECT_SCOPE_REQUIRED',
          'PI_LEAD_UNAVAILABLE',
          'PI_LEAD_AUTHORITY_REVOKED',
          'PI_LEAD_INTENT_CONFLICT',
        ]
        throw new CandidateLeadDispatchError(
          allowed.includes(error.code) ? error.code : 'CANDIDATE_OPERATION_REJECTED'
        )
      }
      throw new CandidateLeadDispatchError('CANDIDATE_OPERATION_REJECTED')
    }
  }
  return {
    prepare(intentId: string) {
      const operation = ControlApiOperations.preparePiDurableLead
      const request = operation.requestSchema.parse(
        command(operation.operation, { intentId }, `lead-prepare:${intentId}`)
      )
      return invoke(request, (value) => client.preparePiDurableLead(value)).then((response) => {
        if (
          response.data.intentId !== intentId ||
          response.data.funding.workspaceId !== options.workspaceId
        )
          throw new CandidateLeadDispatchError('CANDIDATE_RESPONSE_MISMATCH')
        return response.data
      })
    },
    lookup(intentId: string) {
      const operation = ControlApiOperations.lookupPiDurableLead
      const request = operation.requestSchema.parse(read(operation.operation, { intentId }))
      return invoke(request, (value) => client.lookupPiDurableLead(value)).then((response) => {
        if (
          response.data.intentId !== intentId ||
          response.data.workspaceId !== options.workspaceId
        )
          throw new CandidateLeadDispatchError('CANDIDATE_RESPONSE_MISMATCH')
        return response
      })
    },
    dispatch(intentId: string, preparationRef?: string) {
      const operation = ControlApiOperations.dispatchPiDurableLead
      const request = operation.requestSchema.parse(
        command(
          operation.operation,
          { intentId, ...(preparationRef ? { preparationRef } : {}) },
          `lead-turn:${intentId}`
        )
      )
      return invoke(request, (value) => client.dispatchPiDurableLead(value)).then((response) => {
        if (response.data.intentId !== intentId)
          throw new CandidateLeadDispatchError('CANDIDATE_RESPONSE_MISMATCH')
        return response.data
      })
    },
    status(dispatchId: string) {
      const operation = ControlApiOperations.getPiDurableLeadStatus
      const request = operation.requestSchema.parse(read(operation.operation, { dispatchId }))
      return invoke(request, (value) => client.getPiDurableLeadStatus(value)).then((response) => {
        if (response.data.dispatchId !== dispatchId)
          throw new CandidateLeadDispatchError('CANDIDATE_RESPONSE_MISMATCH')
        return response.data
      })
    },
    progress(dispatchId: string, afterSequence = 0) {
      const operation = ControlApiOperations.getPiDurableLeadProgress
      const request = operation.requestSchema.parse(
        read(operation.operation, { dispatchId, afterSequence })
      )
      return invoke(request, (value) => client.getPiDurableLeadProgress(value)).then((response) => {
        if (response.data.dispatchId !== dispatchId)
          throw new CandidateLeadDispatchError('CANDIDATE_RESPONSE_MISMATCH')
        return response.data
      })
    },
    cancel(dispatchId: string) {
      const operation = ControlApiOperations.cancelPiDurableLead
      const request = operation.requestSchema.parse(
        command(operation.operation, { dispatchId }, `lead-cancel:${dispatchId}`)
      )
      return invoke(request, (value) => client.cancelPiDurableLead(value)).then((response) => {
        if (response.data.dispatchId !== dispatchId)
          throw new CandidateLeadDispatchError('CANDIDATE_RESPONSE_MISMATCH')
        return response.data
      })
    },
  }
}
