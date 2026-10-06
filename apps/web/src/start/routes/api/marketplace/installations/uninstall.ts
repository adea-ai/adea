import { createFileRoute } from '@tanstack/solid-router'

import { controlPlaneScopeResolver } from '../../../../../server/control-plane-scope'
import { handleDesktopWorkspacePreflight } from '../../../../../server/desktop-workspace'
import { handleMarketplaceInstallationRequest } from '../../../../../server/marketplace-installation-request'
import { withRequestScope } from '../../../../../server/request-scope'
import { authorizeWorkspace } from '../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../server/workspace-principal'

function post(request: Request) {
  return handleMarketplaceInstallationRequest('uninstall', request, {
    authorize: authorizeWorkspace,
    resolvePrincipal: (incoming) => resolveWorkspacePrincipal(incoming, { createTemporary: true }),
    scopeResolver: (workspaceId) => controlPlaneScopeResolver(workspaceId),
  })
}

export const Route = createFileRoute('/api/marketplace/installations/uninstall')({
  server: {
    handlers: {
      POST: ({ request }) => withRequestScope(() => post(request)),
      OPTIONS: ({ request }) => withRequestScope(() => handleDesktopWorkspacePreflight(request)),
    },
  },
})
