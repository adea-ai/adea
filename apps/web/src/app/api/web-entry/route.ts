import { readWorkspaceEntryAccess } from '../../../server/workspace-entry-access'

// Never turn this per-request allowlist decision into a public/static cache.
export const dynamic = 'force-dynamic'

export async function GET() {
  const access = await readWorkspaceEntryAccess()
  return Response.json(
    { access },
    {
      status: access === 'allowed' ? 200 : access === 'sign-in' ? 401 : 403,
      headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' },
    }
  )
}
