/*
 * Agents pane status section (#400): fetches the canonical run records, the
 * harness preference overlay, and the managed-Pi status through the gate and
 * projects them through the pure HarnessStatusPane model. The section owns no
 * authority and fabricates nothing: an unavailable runtime renders the typed
 * state, and empty runs render idle.
 */
import type { HarnessPreference, HarnessRun, ManagedPiStatus } from '@adea-ai/types/dev-runtime'
import '@adea-ai/ui/dev-view.css'
import { Show, createResource } from 'solid-js'

import type { DevRuntimeService } from '../platform'
import { buildDevCommand } from '../browser/command'
import { HarnessStatusPane } from './harness-status-pane'

export type HarnessStatusSectionProps = {
  runtime: DevRuntimeService
  runtimeSessionId?: string
}

export function HarnessStatusSection(props: HarnessStatusSectionProps) {
  const runtime = () => props.runtime
  const scope = () => runtime().preferenceScope?.()
  const serviceReady = () => runtime().state().status === 'ready'

  async function execute<T>(
    operation: Parameters<typeof buildDevCommand>[0]['operation'],
    body: Record<string, unknown>
  ): Promise<T> {
    const activeScope = scope()
    if (!activeScope) throw new Error('unauthenticated')
    const reply = await runtime().execute(buildDevCommand({ operation, scope: activeScope, body }))
    if (!reply.ok) throw reply
    return reply.value as T
  }

  const [runs] = createResource(serviceReady, async (ready) => {
    if (!ready) return { items: [] as readonly HarnessRun[] }
    return execute<{ items: readonly HarnessRun[] }>(
      'dev.harness.runs',
      props.runtimeSessionId ? { runtimeSessionId: props.runtimeSessionId } : {}
    )
  })
  const [preferences] = createResource(serviceReady, async (ready) => {
    if (!ready) return { items: [] as readonly HarnessPreference[] }
    return execute<{ items: readonly HarnessPreference[] }>('dev.harness.preferences', {})
  })
  const [managedPi] = createResource(serviceReady, async (ready) => {
    if (!ready) return undefined
    return execute<ManagedPiStatus>('dev.harness.managedPiStatus', {})
  })

  return (
    <Show when={serviceReady()} fallback={<p class="dev-pane-state__line">Runtime unavailable</p>}>
      <HarnessStatusPane
        runs={runs()?.items ?? []}
        preferences={preferences()?.items ?? []}
        managedPi={managedPi()}
      />
    </Show>
  )
}
