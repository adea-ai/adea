import 'server-only'
import { withCurrentLeadTurnProduct } from '@adea-ai/db'
import { applicationDatabase } from './database'
import { createLeadChildReconcileHandler } from './lead-child-reconcile'
import { createLeadProductServiceVerifier } from './lead-product-service-auth'
import { configuredLeadTurnProductDependencies, createLeadTurnProduct } from './lead-turn-product'

/** Existing workspace-scoped CP service proof is only a wake-up. It cannot supply a
 * user, audience, result or artifact grant; the transaction resolves those afresh. */
export async function handleLeadChildReconcileRequest(request: Request): Promise<Response> {
  const handler = createLeadChildReconcileHandler({
    verify: createLeadProductServiceVerifier({
      get PI_LEAD_PRODUCT_TRUST() {
        return process.env.PI_LEAD_PRODUCT_TRUST
      },
    }),
    current: async (workspaceId, intentId) => {
      const database = applicationDatabase()
      const product = await withCurrentLeadTurnProduct(
        database,
        workspaceId,
        intentId,
        async (current) =>
          current.dispatchPermitted && current.agentWorkspaceId === current.workspaceId
            ? current
            : undefined
      )
      return product
        ? {
            workspaceId: product.workspaceId,
            intentId: product.intentId,
            userId: product.actorUserId,
          }
        : undefined
    },
    publish: async (scope) => {
      const database = applicationDatabase()
      const product = createLeadTurnProduct(
        database,
        await configuredLeadTurnProductDependencies(database, scope.workspaceId, request)
      )
      await product.publishChildren(scope)
    },
  })
  return handler(request)
}
