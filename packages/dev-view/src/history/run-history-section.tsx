/*
 * History pane section (#400): fetches the durable HarnessRun history through
 * the gate (bounded to the selected session when one is selected) and renders
 * the pure RunHistoryPane rows — newest-first, redacted by construction.
 */
import type { HarnessRun } from '@adea-ai/types/dev-runtime'
import '@adea-ai/app-ui/dev-view.css'
import { Show, createResource, onCleanup } from 'solid-js'

import { RunHistoryPane } from './run-history-pane'
import {
  createDevUtilityFenceSource,
  devUtilityContextKey,
  hasDevUtilitySession,
  isDevUtilityContextChanged,
  sameDevUtilityScope,
  type DevUtilityContextReader,
} from '../utility-context'
import { executeDevUtilityCommand } from '../utility-command'

export type RunHistorySectionProps = {
  context: DevUtilityContextReader
}

export function RunHistorySection(props: RunHistorySectionProps) {
  const context = () => props.context()
  const runtime = () => context().runtime
  const fences = createDevUtilityFenceSource(context)
  onCleanup(() => fences.dispose())
  const contextKey = () => {
    const current = context()
    return current.runtime.state().status === 'ready' && hasDevUtilitySession(current)
      ? devUtilityContextKey(current)
      : undefined
  }

  const [runs] = createResource(contextKey, async (key) => {
    const fence = fences.capture('session')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key)
      return { items: [] as readonly HarnessRun[] }
    try {
      const page = await executeDevUtilityCommand<{ items: readonly HarnessRun[] }>(
        fence,
        'dev.harness.runs',
        { runtimeSessionId: fence.context.runtimeSessionId! }
      )
      return {
        contextKey: key,
        items: page.items.filter(
          (run) =>
            run.runtimeSessionId === fence.context.runtimeSessionId &&
            sameDevUtilityScope(run.scope, fence.context.scope)
        ),
      }
    } catch (error) {
      if (isDevUtilityContextChanged(error)) return { items: [] as readonly HarnessRun[] }
      throw error
    }
  })

  return (
    <Show
      when={hasDevUtilitySession(context())}
      fallback={
        <p class="dev-pane-state__line" role="status">
          History is unavailable until this view is bound to a canonical runtime session.
        </p>
      }
    >
      <Show
        when={runtime().state().status === 'ready'}
        fallback={<p class="dev-pane-state__line">Runtime unavailable</p>}
      >
        <RunHistoryPane
          runs={
            runs()?.contextKey === contextKey()
              ? (runs()?.items ?? []).filter(
                  (run) =>
                    run.runtimeSessionId === context().runtimeSessionId &&
                    sameDevUtilityScope(run.scope, context().scope)
                )
              : []
          }
        />
      </Show>
    </Show>
  )
}
