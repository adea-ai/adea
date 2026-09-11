import { createFileRoute } from '@tanstack/react-router'
import { withRequestScope } from '../../../../../server/request-scope'
import { desktopCorsPreflight, desktopExchangeResponse } from '../../../../../server/desktop-auth'
async function post(request: Request) {
  return desktopExchangeResponse(request)
}

function options(request: Request) {
  return desktopCorsPreflight(request)
}
export const Route = createFileRoute('/api/auth/desktop/exchange')({
  server: {
    handlers: {
      POST: ({ request }) => withRequestScope(() => post(request)),
      OPTIONS: ({ request }) => withRequestScope(() => options(request)),
    },
  },
})
