import 'server-only'
import { createFileRoute } from '@tanstack/solid-router'

import {
  createBoundedDecisionConsumption,
  createLeadManagementHandler,
} from '../../../../../server/lead-management-route'
import { createLeadManagementServiceVerifier } from '../../../../../server/lead-management-service-auth'
import { applicationManagementOperations } from '../../../../../server/management-composition'
import { withRequestScope } from '../../../../../server/request-scope'

/** One per process; the CP932 durable approval store owns replay across restarts. */
const consumeDecision = createBoundedDecisionConsumption()
const handler = createLeadManagementHandler({
  consumeDecision,
  // The database and authorization run only after signature, trust and exact-call binding pass.
  operationsFor: applicationManagementOperations,
  verify: createLeadManagementServiceVerifier({
    get PI_LEAD_MANAGEMENT_TRUST() {
      return process.env.PI_LEAD_MANAGEMENT_TRUST
    },
  }),
})

export const Route = createFileRoute('/api/internal/pi-durable/management')({
  server: {
    handlers: {
      POST: ({ request }) => withRequestScope(() => handler(request)),
    },
  },
})
