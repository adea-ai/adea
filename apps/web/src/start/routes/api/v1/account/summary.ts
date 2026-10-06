import { createFileRoute } from '@tanstack/solid-router'
import type { ApiAccountSummaryResponse } from '@adea-ai/api-client'
import { accountWorkspaceSummaries } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../server/request-scope'
import { resolveWorkspacePrincipal } from '../../../../../server/workspace-principal'
import {
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../server/workspace-response'

/**
 * Counts-only unread status across every workspace the caller belongs to
 * (ADR 0011). No workspace permission is checked here: the query itself is
 * scoped to the caller's own memberships, so it can only ever describe
 * workspaces the caller could open.
 */
async function get(request: Request) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const payload: ApiAccountSummaryResponse = {
    workspaces: await accountWorkspaceSummaries(applicationDatabase(), resolution.principal),
  }
  return workspaceJsonResponse(payload, resolution, request, {
    headers: { 'cache-control': 'private, no-store' },
  })
}

export const Route = createFileRoute('/api/v1/account/summary')({
  server: {
    handlers: {
      GET: ({ request }) => withRequestScope(() => get(request)),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
