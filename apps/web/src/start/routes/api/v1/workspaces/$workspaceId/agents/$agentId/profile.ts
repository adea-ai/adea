import { createFileRoute } from '@tanstack/solid-router'
import { changeAgentProfile, getAgentForUser } from '@adea-ai/db'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import { applicationDatabase } from '../../../../../../../../server/database'
import { controlPlaneAdminDependencies } from '../../../../../../../../server/control-plane-admin-dependencies'
import { handleAgentProfileChange } from '../../../../../../../../server/agent-profile-route'
import { handleDesktopWorkspacePreflight } from '../../../../../../../../server/desktop-workspace'

export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/agents/$agentId/profile')({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        withRequestScope(() =>
          handleAgentProfileChange(request, params.workspaceId, params.agentId, {
            ...controlPlaneAdminDependencies,
            read: (workspaceId, agentId, principal) =>
              getAgentForUser(applicationDatabase(), workspaceId, agentId, principal),
            persist: (workspaceId, agentId, principal, input) =>
              changeAgentProfile(applicationDatabase(), workspaceId, agentId, principal, input),
          })
        ),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
