/*
 * Resource reads that never throw. Solid rethrows an errored resource's error
 * from the accessor, and this app has no error boundary, so one failed read
 * (a rate limit, a revoked token) would tear down the pane that reads it
 * instead of reaching its "could not be loaded" message. The accessor here
 * returns undefined while the read is errored; `.error` and `.loading` carry
 * the state the panes already render.
 */
import {
  createResource,
  type ResourceActions,
  type ResourceFetcher,
  type ResourceSource,
} from 'solid-js'

export type ReadResource<T> = {
  (): T | undefined
  readonly loading: boolean
  readonly error: unknown
}

export function createReadResource<T, S>(
  source: ResourceSource<S>,
  fetcher: ResourceFetcher<S, T>
): [ReadResource<T>, ResourceActions<T | undefined>] {
  const [resource, actions] = createResource<T, S>(source, fetcher)
  const read = (): T | undefined => (resource.error === undefined ? resource() : undefined)
  Object.defineProperties(read, {
    loading: { get: () => resource.loading },
    error: { get: () => resource.error },
  })
  return [read as ReadResource<T>, actions]
}
