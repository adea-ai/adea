import { createFileRoute } from '@tanstack/solid-router'
import { handleLeadChildReconcileRequest } from '../../../../../../server/lead-child-reconcile-route'
import { withRequestScope } from '../../../../../../server/request-scope'

export const Route = createFileRoute('/api/internal/pi-durable/child-receipt/reconcile')({
  server: {
    handlers: {
      POST: ({ request }) => withRequestScope(() => handleLeadChildReconcileRequest(request)),
    },
  },
})
