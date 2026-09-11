import { useEffect, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'

/**
 * Deferred component loader for the workspace entry points.
 * The owning Start route is browser-only. Load on mount, never during SSR;
 * shared snapshots deduplicate imports without nested Suspense reveal delays.
 */
export default function lazyComponent<Props extends object>(
  load: () => Promise<ComponentType<Props>>,
  options: { loading?: () => ReactNode; ssr?: boolean } = {}
): ComponentType<Props> {
  type Snapshot = { component?: ComponentType<Props>; error?: unknown; failed: boolean }
  const empty: Snapshot = { failed: false }
  let snapshot = empty
  let loading: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const read = () => snapshot
  const readServer = () => empty
  const publish = (next: Snapshot) => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  return function DeferredComponent(props: Props) {
    const current = useSyncExternalStore(subscribe, read, readServer)
    useEffect(() => {
      loading ??= Promise.resolve()
        .then(load)
        .then(
          (component) => publish({ component, failed: false }),
          (error: unknown) => publish({ error, failed: true })
        )
    }, [])
    if (current.failed) throw current.error
    const Component = current.component
    return Component ? <Component {...props} /> : (options.loading?.() ?? null)
  }
}
