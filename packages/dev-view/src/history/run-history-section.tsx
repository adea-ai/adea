/*
 * History pane section (#400): fetches the durable HarnessRun history through
 * the gate (bounded to the selected session when one is selected) and renders
 * the pure RunHistoryPane rows — newest-first, redacted by construction.
 */
import type { HarnessRun } from '@adea-ai/types/dev-runtime'
import '@adea-ai/app-ui/dev-view.css'
import { Show } from 'solid-js'

import type { DevRuntimeService } from '../platform'
import { buildDevCommand } from '../browser/command'
import {
  createDevUtilityResource,
  createDevUtilityResourceRequest,
} from '../utility/runtime-resource'
import { RunHistoryPane } from './run-history-pane'

export type RunHistorySectionProps = {
  runtime: DevRuntimeService
  runtimeSessionId?: string
}

export function RunHistorySection(props: RunHistorySectionProps) {
  const runtime = () => props.runtime
  const serviceReady = () => runtime().state().status === 'ready'

  const request = createDevUtilityResourceRequest(() => ({
    runtime: runtime(),
    runtimeSessionId: props.runtimeSessionId,
  }))
  const [runs] = createDevUtilityResource(request, async (key) => {
    if (!key.ready || !key.scope || !key.runtimeSessionId)
      return { items: [] as readonly HarnessRun[] }
    const reply = await key.runtime.execute(
      buildDevCommand({
        operation: 'dev.harness.runs',
        scope: key.scope,
        body: { runtimeSessionId: key.runtimeSessionId },
      })
    )
    if (!reply.ok) throw reply
    return reply.value as { items: readonly HarnessRun[] }
  })

  return (
    <Show when={serviceReady()} fallback={<p class="dev-pane-state__line">Runtime unavailable</p>}>
      <RunHistoryPane runs={runs()?.value.items ?? []} />
    </Show>
  )
}
