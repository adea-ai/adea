import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { parseWorkspaceSearch, stringifyWorkspaceSearch } from './search-codec.mjs'

export function getRouter() {
  return createRouter({
    routeTree,
    parseSearch: parseWorkspaceSearch,
    stringifySearch: stringifyWorkspaceSearch,
    // Query/bootstrap state stays in the existing request-independent client
    // providers; there is no server-side QueryClient singleton or dehydration.
    scrollRestoration: false,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
