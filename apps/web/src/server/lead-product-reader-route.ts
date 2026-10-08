import 'server-only'
import { readCurrentLeadTurnProduct } from '@adea-ai/db'
import { applicationDatabase } from './database'
import { createLeadProductReaderHandler } from './lead-product-reader'
import { createLeadProductServiceVerifier } from './lead-product-service-auth'

/** Private CP callback, separate from browser/desktop authority and model credentials. */
export async function handleLeadProductReaderRequest(request: Request): Promise<Response> {
  const lifetimeMs = Number(process.env.PI_LEAD_PRODUCT_INTENT_LIFETIME_MS)
  const handler = createLeadProductReaderHandler({
    lifetimeMs,
    verify: createLeadProductServiceVerifier({
      get PI_LEAD_PRODUCT_TRUST() {
        return process.env.PI_LEAD_PRODUCT_TRUST
      },
    }),
    // The database is created only after strict selectors and the current signed service proof pass.
    readCurrent: (workspaceId, intentId) =>
      readCurrentLeadTurnProduct(applicationDatabase(), workspaceId, intentId),
  })
  return handler(request)
}
