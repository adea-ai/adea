import { createRouter } from '@tanstack/react-router'
import { onRouterTransitionStart } from '@adea-ai/spatial-protocol'
import { routeTree } from './routeTree.gen'
import { parseWorkspaceSearch, stringifyWorkspaceSearch } from './search-codec.mjs'

export function getRouter() {
  const router = createRouter({
    routeTree,
    parseSearch: parseWorkspaceSearch,
    stringifySearch: stringifyWorkspaceSearch,
    // Query/bootstrap state stays in the existing request-independent client
    // providers; there is no server-side QueryClient singleton or dehydration.
    scrollRestoration: false,
  })
  // Scene navigation telemetry. Next received these events through its
  // instrumentation-client hook; the Start host subscribes to the router
  // history directly so view switches keep their release attribution. The
  // recorder reads window.location/performance, so this is browser-only.
  if (typeof window !== 'undefined') {
    router.history.subscribe(({ action, location }) => {
      try {
        const navigationType =
          action.type === 'PUSH' ? 'push' : action.type === 'REPLACE' ? 'replace' : 'traverse'
        onRouterTransitionStart(location.href, navigationType)
      } catch {
        // Telemetry must never affect navigation.
      }
    })
  }
  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
