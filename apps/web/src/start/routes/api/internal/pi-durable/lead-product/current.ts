import { createFileRoute } from '@tanstack/solid-router'
import { handleLeadProductReaderRequest } from '../../../../../../server/lead-product-reader-route'
import { withRequestScope } from '../../../../../../server/request-scope'

export const Route = createFileRoute('/api/internal/pi-durable/lead-product/current')({
  server: {
    handlers: {
      POST: ({ request }) => withRequestScope(() => handleLeadProductReaderRequest(request)),
    },
  },
})
