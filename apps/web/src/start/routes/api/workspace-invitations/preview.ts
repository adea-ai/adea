import { createFileRoute } from '@tanstack/solid-router'

import { applicationDatabase } from '../../../../server/database'
import { handleDesktopWorkspacePreflight } from '../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../server/request-scope'
import { workspaceInvitationPreviewPost } from '../../../../server/workspace-invitation-preview-handler'
import { resolveWorkspacePrincipal } from '../../../../server/workspace-principal'

/**
 * Preview a workspace invitation (ADR 0012) so the invitee sees the workspace, its owner, its
 * audience and their role before accepting. Same gates and uniform `404` as accept; read-only.
 */
export const Route = createFileRoute('/api/workspace-invitations/preview')({
  server: {
    handlers: {
      POST: ({ request }) =>
        withRequestScope(() =>
          workspaceInvitationPreviewPost(request, {
            database: applicationDatabase,
            resolvePrincipal: resolveWorkspacePrincipal,
          })
        ),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
