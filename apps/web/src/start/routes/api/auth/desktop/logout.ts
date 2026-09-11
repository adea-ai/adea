import { createFileRoute } from '@tanstack/react-router'
import { withRequestScope } from '../../../../../server/request-scope'
import { desktopCorsPreflight, desktopSessionResponse } from '../../../../../server/desktop-auth'
async function post(request: Request) {
  return desktopSessionResponse(request, 'logout')
}

function options(request: Request) {
  return desktopCorsPreflight(request)
}
export const Route = createFileRoute('/api/auth/desktop/logout')({
  server: {
    handlers: {
      POST: ({ request }) => withRequestScope(() => post(request)),
      OPTIONS: ({ request }) => withRequestScope(() => options(request)),
    },
  },
})
