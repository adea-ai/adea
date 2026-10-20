import type { AgentHqDatabase } from '@adea-ai/db'
import type { ApiLeadTurnStatus } from '@adea-ai/api-client'
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
  publishLeadChildTerminal,
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
      authorize: (scope, purpose) =>
        resolveLeadTurnAuthority(
          database,
          scope.workspaceId,
          scope.intentId,
          principal(scope),
          purpose
        ),
      read: (scope, purpose) =>
        readLeadTurnRuntime(database, scope.workspaceId, scope.intentId, principal(scope), purpose),
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
  // Control-plane-reported execution observation, attached fail-soft to
  // display reads only. The adapter lookup runs against the exact retained
  // intent; anything unexpected (no adapter, no lookup transport, throw,
  // missing receipt, intent mismatch, malformed observation) omits the
  // fields and the canonical snapshot stands alone. This never authorizes,
  // binds, or coordinates: it reports what the control plane returned so
  // owners can compare it against the retained claim themselves.
  const readObservedTarget = async (
    workspaceId: string,
    intentId: string,
    userId: string
  ): Promise<{ sessionId: string; taskId: string } | undefined> => {
    const adapter = dependencies.adapter
    if (!adapter?.lookup) return undefined
    try {
      const authority = await resolveLeadTurnAuthority(
        database,
        workspaceId,
        intentId,
        principal({ userId }),
        'read'
      )
      const value = (await adapter.lookup(authority)) as
        | {
            schemaVersion?: unknown
            workspaceId?: unknown
            intentId?: unknown
            receipt?: unknown
          }
        | null
        | undefined
      if (
        !value ||
        typeof value !== 'object' ||
        value.schemaVersion !== 'pi-lead-lookup/v1' ||
        value.workspaceId !== authority.controlPlaneWorkspaceId ||
        value.intentId !== intentId
      )
        return undefined
      const receipt = value.receipt as
        | { observedTarget?: { sessionId?: unknown; taskId?: unknown } | null }
        | null
        | undefined
      const observed = receipt?.observedTarget
      if (
        !observed ||
        typeof observed !== 'object' ||
        typeof observed.sessionId !== 'string' ||
        !observed.sessionId.trim() ||
        typeof observed.taskId !== 'string' ||
        !observed.taskId.trim()
      )
        return undefined
      return { sessionId: observed.sessionId, taskId: observed.taskId }
    } catch {
      return undefined
    }
  }
  const withObservedTarget = async (
    snapshot: ApiLeadTurnStatus | null,
    workspaceId: string,
    intentId: string,
    userId: string
  ): Promise<ApiLeadTurnStatus | null> => {
    if (!snapshot) return snapshot
    const observedTarget = await readObservedTarget(workspaceId, intentId, userId)
    if (!observedTarget) return snapshot
    return { ...snapshot, observedTarget }
  }
  return {
    ...service,
    /** Explicit reconciler: retained CP terminal evidence is independently delivered to Adea. */
    async publishChildren(scope: { workspaceId: string; intentId: string; userId: string }) {
      const adapter = dependencies.adapter
      if (!adapter?.children || !adapter.childPublicationCurrent)
        throw new Error('CHILD_PUBLICATION_UNAVAILABLE')
      const childPublicationCurrent = adapter.childPublicationCurrent
      let after: { acceptedAt: string; delegationId: string } | undefined
      let published = 0
      const seen = new Set<string>()
      do {
        const observed = await service.children(scope, { limit: 256, ...(after ? { after } : {}) })
        const page = observed.childObservations
        const parent = observed.leadTurn
        if (
          page.availability !== 'available' ||
          !parent.dispatchId ||
          !parent.executionId ||
          !parent.attemptId ||
          !parent.runtimeSessionId ||
          !parent.preparationRef
        )
          throw new Error('CHILD_PUBLICATION_UNAVAILABLE')
        const binding = {
          schemaVersion: 'pi-lead-dispatch/v1' as const,
          intentId: scope.intentId,
          dispatchId: parent.dispatchId,
          executionId: parent.executionId,
          attemptId: parent.attemptId,
          runtimeSessionId: parent.runtimeSessionId,
        }
        for (const child of page.children) {
          if (seen.has(child.delegationId)) throw new Error('CHILD_PUBLICATION_CHANGED')
          seen.add(child.delegationId)
          if (!child.outcome || child.outcome.publication.status !== 'published') continue
          const authority = await resolveLeadTurnAuthority(
            database,
            scope.workspaceId,
            scope.intentId,
            principal(scope),
            'read'
          )
          const evidence = await childPublicationCurrent(
            authority,
            binding,
            parent.preparationRef,
            child.delegationId
          )
          if (
            evidence.childExecutionId !== child.childExecutionId ||
            evidence.childAttemptId !== child.childAttemptId ||
            evidence.role !== child.role ||
            evidence.state !== child.outcome.state ||
            evidence.resultRef !== child.outcome.resultRef ||
            evidence.failureCode !== child.outcome.failureCode
          )
            throw new Error('CHILD_PUBLICATION_CHANGED')
          await publishLeadChildTerminal(
            database,
            scope.workspaceId,
            scope.intentId,
            principal(scope),
            binding,
            evidence,
            async () => {
              const current = await childPublicationCurrent(
                authority,
                binding,
                parent.preparationRef!,
                child.delegationId
              )
              if (JSON.stringify(current) !== JSON.stringify(evidence))
                throw new Error('CHILD_PUBLICATION_CHANGED')
            }
          )
          published++
        }
        if (page.complete) return { published }
        if (
          !page.next ||
          (after &&
            page.next.acceptedAt === after.acceptedAt &&
            page.next.delegationId === after.delegationId)
        )
          throw new Error('CHILD_PUBLICATION_CHANGED')
        after = page.next
      } while (seen.size <= 10_000)
      throw new Error('CHILD_PUBLICATION_CHANGED')
    },
    async latest(workspaceId: string, channelId: string, userId: string) {
      const receipt = await getLatestLeadTurnForChannel(database, workspaceId, channelId, {
        kind: 'user',
        userId,
      })
      if (!receipt) return null
      const scope = { workspaceId, intentId: receipt.intentId, userId }
      return withObservedTarget(
        await service.snapshot(scope),
        workspaceId,
        receipt.intentId,
        userId
      )
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
      if (!receipt) return null
      const scope = { workspaceId, intentId: receipt.intentId, userId }
      return withObservedTarget(
        await service.snapshot(scope),
        workspaceId,
        receipt.intentId,
        userId
      )
    },
  }
}
