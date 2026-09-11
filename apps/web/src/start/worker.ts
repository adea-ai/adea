import { env } from 'cloudflare:workers'
import handler, { createServerEntry } from '@tanstack/react-start/server-entry'

import { readWorkspaceEntryAccess } from '../server/workspace-entry-access'
import { captureWorkerBindings } from '../server/worker-bindings'
import { withRequestScope } from '../server/request-scope'
import {
  failure,
  finalizeDynamicResponse,
  rootDocumentPolicy,
  stripEntryAccessHeader,
  withEntryAccess,
} from './http-policy.mjs'

/**
 * Worker entry for the TanStack Start host.
 *
 * Cloudflare bindings are captured here for synchronous Hyperdrive
 * resolution, the migration-era dynamic response policy is applied to every
 * response, and the root document is gated: the account allowlist decides
 * before any workspace document is rendered. Unsigned visitors are redirected
 * to sign-in; denied accounts render the early-access notice inside the route
 * (the decision travels on an internal header that inbound requests cannot
 * forge because it is stripped first).
 */
export default createServerEntry({
  async fetch(request, opts) {
    captureWorkerBindings(env)
    try {
      const rejected = rootDocumentPolicy(request)
      if (rejected) return rejected

      const stripped = stripEntryAccessHeader(request)
      const { pathname } = new URL(stripped.url)
      let forwarded = stripped
      if (pathname === '/') {
        const access = await withRequestScope(() => readWorkspaceEntryAccess())
        if (access === 'sign-in') {
          return new Response(null, {
            status: 307,
            headers: { 'Cache-Control': 'private, no-store', Location: '/auth/sign-in' },
          })
        }
        forwarded = withEntryAccess(stripped, access)
      }

      const rendered = await handler.fetch(forwarded, opts)
      return await finalizeDynamicResponse(rendered, stripped)
    } catch (error) {
      // Fail closed, but keep the cause in Workers observability: an operator
      // needs the stack to tell a provider outage from a code defect.
      console.error(
        JSON.stringify({
          event: 'workspace_entry_failure',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
      )
      return failure(503, 'Workspace entry is temporarily unavailable')
    }
  },
})
