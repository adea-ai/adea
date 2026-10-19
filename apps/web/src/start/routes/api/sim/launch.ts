import { createFileRoute } from '@tanstack/solid-router'
import { simLaunch } from '../../../../server/sim-api'
import { handleDesktopWorkspacePreflight } from '../../../../server/desktop-workspace'

export const Route = createFileRoute('/api/sim/launch')({
  server: {
    handlers: {
      POST: ({ request }) => simLaunch(request),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
