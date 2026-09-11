import { env } from 'cloudflare:workers'
import handler, { createServerEntry } from '@tanstack/react-start/server-entry'

import { readWorkspaceEntryAccess } from '../server/workspace-entry-access'
import { captureWorkerBindings } from '../server/worker-bindings'
import { withRequestScope } from '../server/request-scope'
import { runWithGateRequest } from '../server/gate-request-context'
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
      const { pathname, search } = new URL(stripped.url)
      let forwarded = stripped
      let gateCookies: string[] = []
      if (pathname === '/') {
        // Start's request storage does not exist yet at entry time, so the gate
        // reads the session through its own request-bound context and returns
        // any refreshed session cookie for this response.
        const gate = await runWithGateRequest(stripped, () =>
          withRequestScope(() => readWorkspaceEntryAccess())
        )
        gateCookies = gate.cookies
        if (gate.result === 'sign-in') {
          // Carry the requested search through sign-in so a deep link such as
          // ?view=chat&scene=home still resolves after authenticating. Only the
          // root document is gated, so the target is same-origin by
          // construction and the sign-in page re-validates it anyway.
          const returnTo = search ? `/?${search.slice(1)}` : '/'
          const headers = new Headers({
            'Cache-Control': 'private, no-store',
            Location: `/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`,
          })
          for (const cookie of gateCookies) headers.append('Set-Cookie', cookie)
          return new Response(null, { status: 307, headers })
        }
        forwarded = withEntryAccess(stripped, gate.result)
      }

      const rendered = await handler.fetch(forwarded, opts)
      if (gateCookies.length) {
        // A rotated provider session must still reach the browser: append the
        // gate's cookies alongside whatever the document render set.
        const headers = new Headers(rendered.headers)
        for (const cookie of gateCookies) headers.append('Set-Cookie', cookie)
        const rebuilt = new Response(rendered.body, {
          status: rendered.status,
          statusText: rendered.statusText,
          headers,
        })
        return await finalizeDynamicResponse(rebuilt, stripped)
      }
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
