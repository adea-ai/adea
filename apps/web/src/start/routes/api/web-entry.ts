import { createFileRoute } from '@tanstack/react-router'
import { withRequestScope } from '../../../server/request-scope'
import { readWorkspaceEntryAccess } from '../../../server/workspace-entry-access'

// Never turn this per-request allowlist decision into a public/static cache.
async function get() {
  const access = await readWorkspaceEntryAccess()
  return Response.json(
    { access },
    {
      status: access === 'allowed' ? 200 : access === 'sign-in' ? 401 : 403,
      headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' },
    }
  )
}
export const Route = createFileRoute('/api/web-entry')({
  server: {
    handlers: {
      GET: () => withRequestScope(() => get()),
    },
  },
})
