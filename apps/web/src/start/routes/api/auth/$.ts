import { createFileRoute } from '@tanstack/solid-router'
import { handleAuthRequest } from '@adea-ai/auth/server'

import { authDeliveryForRequest } from '../../../../server/auth-delivery'
import { withRequestScope } from '../../../../server/request-scope'

type RouteMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'

// The splat segment is the auth API path; the toolkit owns its routing.
function proxy(method: RouteMethod) {
  return ({ request, params }: { request: Request; params: Record<string, string | undefined> }) =>
    withRequestScope(() =>
      handleAuthRequest(method, request, decodeURIComponent(params['_splat'] ?? ''), process.env, {
        delivery: authDeliveryForRequest(process.env),
      })
    )
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      DELETE: proxy('DELETE'),
      GET: proxy('GET'),
      PATCH: proxy('PATCH'),
      POST: proxy('POST'),
      PUT: proxy('PUT'),
    },
  },
})
