import { createFileRoute } from '@tanstack/react-router'
import { handleNeonAuthRequest } from '@adea-ai/auth/server'

import { withRequestScope } from '../../../../server/request-scope'

type RouteMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'

// The splat segment is the Neon Auth API path; the toolkit owns its routing.
function proxy(method: RouteMethod) {
  return ({ request, params }: { request: Request; params: Record<string, string | undefined> }) =>
    withRequestScope(() =>
      handleNeonAuthRequest(method, request, decodeURIComponent(params['_splat'] ?? ''))
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
