import { hydrate } from 'solid-js/web'
import { StartClient, hydrateStart } from '@tanstack/solid-start/client'

// Rehydrate the router's server state, then hydrate the document Solid rendered
// on the server. Both steps are required: hydrateStart only restores router
// data, it does not mount the app.
void hydrateStart().then((router) => {
  hydrate(() => <StartClient router={router} />, document)
})
