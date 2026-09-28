/*
 * History pane section (#400): fetches the durable HarnessRun history through
 * the gate (bounded to the selected session when one is selected) and renders
 * the pure RunHistoryPane rows — newest-first, redacted by construction.
 */
import type { HarnessRun } from '@adea-ai/types/dev-runtime'
import '@adea-ai/app-ui/dev-view.css'
import { Show, createResource } from 'solid-js'

import type { DevRuntimeService } from '../platform'
import { buildDevCommand } from '../browser/command'
import { RunHistoryPane } from './run-history-pane'

export type RunHistorySectionProps = {
  runtime: DevRuntimeService
  runtimeSessionId?: string
}

export function RunHistorySection(props: RunHistorySectionProps) {
  const runtime = () => props.runtime
  const scope = () => runtime().preferenceScope?.()
  const serviceReady = () => runtime().state().status === 'ready'

  const [runs] = createResource(serviceReady, async (ready) => {
    if (!ready) return { items: [] as readonly HarnessRun[] }
    const activeScope = scope()
    if (!activeScope) return { items: [] as readonly HarnessRun[] }
    const reply = await runtime().execute(
      buildDevCommand({
        operation: 'dev.harness.runs',
        scope: activeScope,
        body: props.runtimeSessionId ? { runtimeSessionId: props.runtimeSessionId } : {},
      })
    )
    if (!reply.ok) throw reply
    return reply.value as { items: readonly HarnessRun[] }
  })

  return (
    <Show when={serviceReady()} fallback={<p class="dev-pane-state__line">Runtime unavailable</p>}>
      <RunHistoryPane runs={runs()?.items ?? []} />
    </Show>
  )
}
