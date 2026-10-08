import { configuredLeadExecutionTarget } from './lead-execution-target'
import {
  adminCorrelation,
  commandEnvelope,
  isRecord,
  readEnvelope,
  scopedAdminCredential,
  type ControlPlaneHopDependencies,
} from './control-plane-client'
import type { ControlPlaneServiceScope } from './control-plane-credential'
import { createLeadTurnSdkAdapter } from './lead-turn-sdk-adapter'
import { installedLeadSdkPort, type LeadSdkMethod, type LeadSdkPort } from './lead-turn-sdk-port'
import type { LeadTurnProductDependencies } from './lead-turn-product'

/** An operator must configure the real CP product/profile/current-authority ports first.
 * This opt-in does not create service grants or install credentials. Missing released APIs stay blocked. */
export async function createConfiguredLeadTurnDependencies(
  dependencies: ControlPlaneHopDependencies,
  request?: Request,
  port: LeadSdkPort = installedLeadSdkPort
): Promise<LeadTurnProductDependencies> {
  const environment = dependencies.environment ?? process.env
  if (
    !configuredLeadExecutionTarget(environment) ||
    !port.supported ||
    !port.preparationSchema ||
    !port.lookupResponseSchema
  )
    return {}
  const scope = await dependencies.resolveControlPlaneScope()
  if (!scope || scope.projectId !== undefined) return {}
  const correlation = adminCorrelation(request, dependencies.now?.() ?? Date.now())
  async function invoke(
    method: LeadSdkMethod,
    operation: string,
    parameters: Record<string, unknown>,
    serviceScope: ControlPlaneServiceScope,
    key?: string
  ) {
    // The publication callback runs with DB locks and must not acquire another pool connection.
    // Runtime authorization supplies the current mapping; adapter checks it against this captured scope.
    const credential = await scopedAdminCredential([serviceScope], {
      ...dependencies,
      resolveControlPlaneScope: async () => scope,
    })
    if (credential.workspaceId !== scope!.workspaceId || credential.projectId !== undefined)
      throw new Error('RUNTIME_RESPONSE_INVALID')
    const now = dependencies.now?.() ?? Date.now()
    const body = key
      ? commandEnvelope(credential, correlation, {
          operation,
          idempotencyKey: key,
          payload: parameters,
          now,
        })
      : readEnvelope(credential, correlation, operation, parameters, now)
    return port.invoke(method, credential, body, dependencies)
  }
  async function dispatchData(
    method: LeadSdkMethod,
    operation: string,
    parameters: Record<string, unknown>,
    serviceScope: ControlPlaneServiceScope,
    key?: string
  ) {
    // The installed SDK validates the complete response envelope. Runtime transport
    // consumes its data projection; prepare and lookup have their own full-envelope decoders.
    const response = await invoke(method, operation, parameters, serviceScope, key)
    if (
      !isRecord(response) ||
      !isRecord(response.data) ||
      response.data.schemaVersion !== 'pi-lead-dispatch/v1'
    )
      throw new Error('RUNTIME_RESPONSE_INVALID')
    return response.data
  }
  async function funding(
    prepared: Parameters<NonNullable<LeadTurnProductDependencies['authorizeConfirmedStart']>>[1]
  ) {
    const response = await invoke(
      'getModelSelectionFunding',
      'model-selection.funding.get',
      {
        executionId: prepared.executionId,
        attemptId: prepared.attemptId,
        selectionRef: prepared.selectionRef,
        selectionRevision: prepared.selectionRevision,
      },
      'credential:read'
    )
    if (!isRecord(response) || !isRecord(response.data) || !isRecord(response.data.funding))
      throw new Error('RUNTIME_RESPONSE_INVALID')
    const value = response.data.funding
    if (
      value.state !== 'ready' ||
      value.workspaceId !== scope!.workspaceId ||
      typeof value.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= (dependencies.now?.() ?? Date.now())
    )
      throw new Error('RUNTIME_UNAVAILABLE')
    for (const key of ['executionId', 'attemptId', 'selectionRef', 'selectionRevision'] as const)
      if (value[key] !== prepared[key]) throw new Error('RUNTIME_RESPONSE_INVALID')
  }
  const adapter = createLeadTurnSdkAdapter(
    {
      workspaceId: scope.workspaceId,
      preparationSchema: port.preparationSchema,
      lookupResponseSchema: port.lookupResponseSchema,
      prepare: (intentId) =>
        invoke(
          'preparePiDurableLead',
          'pi-durable.lead.prepare',
          { intentId },
          'execution:accept',
          `lead-prepare:${intentId}`
        ),
      lookup: (intentId) =>
        invoke('lookupPiDurableLead', 'pi-durable.lead.lookup', { intentId }, 'execution:read'),
      dispatch: (intentId, preparationRef) =>
        dispatchData(
          'dispatchPiDurableLead',
          'pi-durable.lead.dispatch',
          { intentId, preparationRef },
          'execution:accept',
          `lead-turn:${intentId}`
        ),
      status: (dispatchId) =>
        dispatchData(
          'getPiDurableLeadStatus',
          'pi-durable.lead.status',
          { dispatchId },
          'execution:read'
        ),
      progress: (dispatchId, afterSequence) =>
        dispatchData(
          'getPiDurableLeadProgress',
          'pi-durable.lead.progress',
          { dispatchId, afterSequence },
          'execution:read'
        ),
      cancel: (dispatchId) =>
        dispatchData(
          'cancelPiDurableLead',
          'pi-durable.lead.cancel',
          { dispatchId },
          'execution:cancel',
          `lead-cancel:${dispatchId}`
        ),
    },
    async (expected) => {
      // Called inside Adea's current actor/audience transaction. CP MUST NOT call back into Adea here.
      const response = await invoke(
        'getPiDurableLeadPublication',
        'pi-durable.lead.publication.current',
        {
          dispatchId: expected.dispatchId,
          preparationRef: expected.preparationRef,
        },
        'execution:read'
      )
      if (!isRecord(response) || !isRecord(response.data) || !isRecord(response.data.publication))
        throw new Error('RUNTIME_RESPONSE_INVALID')
      const value = response.data.publication
      for (const key of [
        'intentId',
        'dispatchId',
        'preparationRef',
        'executionId',
        'attemptId',
        'runtimeSessionId',
        'selectionRef',
        'selectionRevision',
        'resultContentDigest',
      ] as const)
        if (value[key] !== expected[key]) throw new Error('RUNTIME_RESPONSE_INVALID')
      if (
        value.workspaceId !== scope!.workspaceId ||
        value.canonicalActorPrincipalId !== expected.originalActorRef ||
        !Number.isSafeInteger(value.authorityRevision) ||
        (value.authorityRevision as number) < 1 ||
        typeof value.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(value.expiresAt)) ||
        Date.parse(value.expiresAt) <= (dependencies.now?.() ?? Date.now())
      )
        throw new Error('RUNTIME_RESPONSE_INVALID')
    }
  )
  return {
    adapter,
    async authorizeConfirmedStart(authority, prepared) {
      if (
        authority.controlPlaneWorkspaceId !== scope.workspaceId ||
        prepared.workspaceId !== scope.workspaceId
      )
        throw new Error('RUNTIME_RESPONSE_INVALID')
      await funding(prepared)
      // CP retains an immutable full payer confirmation per attempt; dispatch rechecks it before start/send.
      return prepared
    },
  }
}
