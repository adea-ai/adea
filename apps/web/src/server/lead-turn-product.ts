import type { AgentHqDatabase } from '@adea-ai/db'
import {
  getLatestLeadTurnForChannel,
  getLatestLeadTurnForTarget,
  resolveLeadTurnAuthority,
  readLeadTurnRuntime,
  prepareLeadTurnRuntime,
  markLeadTurnDispatchPending,
  observeLeadTurnRuntime,
  recoverLeadTurnRuntimeBinding,
  requestLeadTurnCancellation,
  publishLeadTurnResult,
  controlPlaneScopeIds,
} from '@adea-ai/db'
import { createConfiguredLeadTurnDependencies } from './lead-turn-composition'
import {
  createLeadTurnRuntime,
  type LeadRuntimeAdapter,
  type LeadRuntimeAuthority,
  type LeadPreparedSelection,
} from './lead-turn-runtime'

/** Composition can be installed only with existing authorized transport and exact released contracts. */
export type LeadTurnProductDependencies = Readonly<{
  adapter?: LeadRuntimeAdapter | null
  authorizeConfirmedStart?: (
    authority: LeadRuntimeAuthority,
    prepared: LeadPreparedSelection
  ) => Promise<LeadPreparedSelection>
}>
/** No SDK operation guesses, scope expansion, credential discovery, or inferred project. */
export async function configuredLeadTurnProductDependencies(
  database: AgentHqDatabase,
  workspaceId: string,
  request?: Request
): Promise<LeadTurnProductDependencies> {
  return createConfiguredLeadTurnDependencies(
    {
      resolveControlPlaneScope: () => controlPlaneScopeIds(database, { workspaceId }),
    },
    request
  )
}
const principal = (scope: Readonly<{ userId: string }>) => ({
  kind: 'user' as const,
  userId: scope.userId,
})
export function createLeadTurnProduct(
  database: AgentHqDatabase,
  dependencies: LeadTurnProductDependencies = {}
) {
  const service = createLeadTurnRuntime({
    ...dependencies,
    store: {
      authorize: (scope, mutation) =>
        resolveLeadTurnAuthority(
          database,
          scope.workspaceId,
          scope.intentId,
          principal(scope),
          mutation
        ),
      read: (scope) =>
        readLeadTurnRuntime(database, scope.workspaceId, scope.intentId, principal(scope)),
      prepare: (scope, pin) =>
        prepareLeadTurnRuntime(database, scope.workspaceId, scope.intentId, principal(scope), pin),
      pending: (scope, pin) =>
        markLeadTurnDispatchPending(
          database,
          scope.workspaceId,
          scope.intentId,
          principal(scope),
          pin
        ),
      observe: (scope, value) =>
        observeLeadTurnRuntime(
          database,
          scope.workspaceId,
          scope.intentId,
          principal(scope),
          value
        ),
      recover: (scope, bound) =>
        recoverLeadTurnRuntimeBinding(
          database,
          scope.workspaceId,
          scope.intentId,
          principal(scope),
          bound
        ),
      cancelRequested: (scope) =>
        requestLeadTurnCancellation(database, scope.workspaceId, scope.intentId, principal(scope)),
      publish: (scope, bound, text, check) =>
        publishLeadTurnResult(
          database,
          scope.workspaceId,
          scope.intentId,
          principal(scope),
          bound,
          text,
          check
        ),
    },
  })
  return {
    ...service,
    async latest(workspaceId: string, channelId: string, userId: string) {
      const receipt = await getLatestLeadTurnForChannel(database, workspaceId, channelId, {
        kind: 'user',
        userId,
      })
      return receipt ? service.snapshot({ workspaceId, intentId: receipt.intentId, userId }) : null
    },
    async latestForTarget(
      workspaceId: string,
      channelId: string,
      targetSessionId: string,
      userId: string
    ) {
      const receipt = await getLatestLeadTurnForTarget(
        database,
        workspaceId,
        channelId,
        targetSessionId,
        { kind: 'user', userId }
      )
      return receipt ? service.snapshot({ workspaceId, intentId: receipt.intentId, userId }) : null
    },
  }
}
