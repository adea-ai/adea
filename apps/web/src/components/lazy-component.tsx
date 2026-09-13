import { createSignal, onMount, Show, type Component, type JSX } from 'solid-js'
import { createComponent } from 'solid-js/web'

/**
 * Deferred component loader for the workspace entry points.
 * The owning Start route is browser-only. Load on mount, never during SSR;
 * the module-level promise deduplicates imports without nested Suspense
 * reveal delays.
 *
 * A failed import is re-thrown from a reactive branch, so the route's error
 * component takes over (a throw in the component body would only be evaluated
 * once, before the import has settled).
 */
export default function lazyComponent<Props extends object>(
  load: () => Promise<Component<Props>>,
  options: { loading?: () => JSX.Element; ssr?: boolean } = {}
): Component<Props> {
  let loading: Promise<void> | undefined
  const [component, setComponent] = createSignal<Component<Props>>()
  const [failure, setFailure] = createSignal<unknown>()

  return function DeferredComponent(props: Props) {
    // Mount-only: a server render never starts the browser import.
    onMount(() => {
      loading ??= Promise.resolve()
        .then(load)
        .then(
          (loaded) => {
            setComponent(() => loaded)
          },
          (error: unknown) => {
            setFailure(() => error)
          }
        )
    })

    return (
      <Show
        when={failure()}
        fallback={
          <Show when={component()} fallback={options.loading?.() ?? null}>
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
