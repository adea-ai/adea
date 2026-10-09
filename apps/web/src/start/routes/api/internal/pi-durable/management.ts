import 'server-only'
import { claimManagementAuthorityDecision, completeManagementAuthorityDecision } from '@adea-ai/db'
import { createFileRoute } from '@tanstack/solid-router'

import { applicationDatabase } from '../../../../../server/database'
import { createLeadManagementHandler } from '../../../../../server/lead-management-route'
import { createLeadManagementServiceVerifier } from '../../../../../server/lead-management-service-auth'
import { createManagementCurrentAuthority } from '../../../../../server/management-authority-current'
import { applicationManagementOperations } from '../../../../../server/management-composition'
import { withRequestScope } from '../../../../../server/request-scope'

/**
 * The per-delivery CP current-authority owner is required and read from
 * operator configuration; without it every delivery fails closed.
 */
const assertCurrent = createManagementCurrentAuthority({
  get PI_LEAD_MANAGEMENT_AUTHORITY_TOKEN() {
    return process.env.PI_LEAD_MANAGEMENT_AUTHORITY_TOKEN
  },
  get PI_LEAD_MANAGEMENT_AUTHORITY_URL() {
    return process.env.PI_LEAD_MANAGEMENT_AUTHORITY_URL
  },
})

const handler = createLeadManagementHandler({
  assertCurrent,
  // The durable database claim is the primary replay owner across workers,
  // restarts and eviction; an interrupted claim never executes twice.
  claim: (decision) =>
    claimManagementAuthorityDecision(applicationDatabase(), {
      actionDigest: decision.binding.actionDigest,
      authorityRef: decision.authorityRef,
      authorityRevision: decision.authorityRevision,
      decisionId: decision.decisionId,
      inputDigest: decision.binding.inputDigest,
      operation: decision.binding.operation,
      targetDigest: decision.binding.targetDigest,
      targetId: decision.binding.targetId,
      workspaceId: decision.binding.workspaceId,
    }),
  complete: (decision, completion) =>
    completeManagementAuthorityDecision(applicationDatabase(), decision.decisionId, completion),
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
