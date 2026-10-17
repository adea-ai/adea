import { createFileRoute } from '@tanstack/solid-router'
import { simConfiguration } from '../../../../server/sim-api'
import { handleDesktopWorkspacePreflight } from '../../../../server/desktop-workspace'

export const Route = createFileRoute('/api/sim/config')({
  server: {
    handlers: {
      GET: ({ request }) => simConfiguration(request),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
