import { createSignal, onMount, Show, type Component, type JSX } from 'solid-js'
import { createComponent } from 'solid-js/web'

type DeferredState<Props extends object> = {
  component?: Component<Props>
  failure?: unknown
}

/**
 * Deferred component loader for the workspace entry points.
 * The owning Start route is browser-only. Load on mount, never during SSR;
 * the module-level promise deduplicates imports without nested Suspense
 * reveal delays.
 *
 * The resolved state lives at module scope with the promise it belongs to. A
 * second mount (the route can remount its component subtree while router state
 * settles) must observe the finished import instead of waiting on its own,
 * per-instance, never-to-be-resolved copy of that promise.
 *
 * A failed import is re-thrown from a reactive branch, so the route's error
 * component takes over (a throw in the component body would only be evaluated
 * once, before the import has settled).
 */
export default function lazyComponent<Props extends object>(
  load: () => Promise<Component<Props>>,
  options: { loading?: () => JSX.Element; ssr?: boolean } = {}
): Component<Props> {
  const [state, setState] = createSignal<DeferredState<Props>>({})
  let loading: Promise<void> | undefined

  function start() {
    loading ??= Promise.resolve()
      .then(load)
      .then(
        (loaded) => {
          setState((current) => ({ ...current, component: loaded }))
        },
        (error: unknown) => {
          setState((current) => ({ ...current, failure: error }))
        }
      )
  }

  return function DeferredComponent(props: Props) {
    // Mount-only: a server render never starts the browser import.
    onMount(start)

    return (
      <Show
        when={state().failure}
        fallback={
          <Show when={state().component} fallback={options.loading?.() ?? null}>
            {(loaded) => createComponent(loaded(), props)}
          </Show>
        }
      >
        {(error) => {
          throw error()
        }}
      </Show>
    )
  }
}
