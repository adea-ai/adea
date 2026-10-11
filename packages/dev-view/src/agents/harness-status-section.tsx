/*
 * Agents pane status section (#400): fetches the canonical run records, the
 * harness preference overlay, and the managed-Pi status through the gate and
 * projects them through the pure HarnessStatusPane model. The section owns no
 * authority and fabricates nothing: an unavailable runtime renders the typed
 * state, and empty runs render idle.
 */
import type { HarnessPreference, HarnessRun, ManagedPiStatus } from '@adea-ai/types/dev-runtime'
import '@adea-ai/app-ui/dev-view.css'
import { Show } from 'solid-js'

import type { DevRuntimeService } from '../platform'
import { buildDevCommand } from '../browser/command'
import {
  createDevUtilityResource,
  createDevUtilityResourceRequest,
} from '../utility/runtime-resource'
import { HarnessStatusPane } from './harness-status-pane'

export type HarnessStatusSectionProps = {
  runtime: DevRuntimeService
  runtimeSessionId?: string
}

export function HarnessStatusSection(props: HarnessStatusSectionProps) {
  const runtime = () => props.runtime
  const serviceReady = () => runtime().state().status === 'ready'
  const request = createDevUtilityResourceRequest(() => ({
    runtime: runtime(),
    runtimeSessionId: props.runtimeSessionId,
  }))
  const scopeRequest = createDevUtilityResourceRequest(() => ({ runtime: runtime() }), false)

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

  const [preferences] = createDevUtilityResource(scopeRequest, async (key) => {
    if (!key.ready || !key.scope) return { items: [] as readonly HarnessPreference[] }
    const reply = await key.runtime.execute(
      buildDevCommand({ operation: 'dev.harness.preferences', scope: key.scope, body: {} })
    )
    if (!reply.ok) throw reply
    return reply.value as { items: readonly HarnessPreference[] }
  })

  const [managedPi] = createDevUtilityResource(scopeRequest, async (key) => {
    if (!key.ready || !key.scope) return undefined
    const reply = await key.runtime.execute(
      buildDevCommand({ operation: 'dev.harness.managedPiStatus', scope: key.scope, body: {} })
    )
    if (!reply.ok) throw reply
    return reply.value as ManagedPiStatus
  })

  return (
    <Show when={serviceReady()} fallback={<p class="dev-pane-state__line">Runtime unavailable</p>}>
      <HarnessStatusPane
        runs={runs()?.value.items ?? []}
        preferences={preferences()?.value.items ?? []}
        managedPi={managedPi()?.value}
      />
    </Show>
  )
}
