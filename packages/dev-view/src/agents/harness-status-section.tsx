/*
 * Agents pane status section (#400): fetches the canonical run records, the
 * harness preference overlay, and the managed-Pi status through the gate and
 * projects them through the pure HarnessStatusPane model. The section owns no
 * authority and fabricates nothing: an unavailable runtime renders the typed
 * state, and empty runs render idle.
 */
import type { HarnessPreference, HarnessRun, ManagedPiStatus } from '@adea-ai/types/dev-runtime'
import '@adea-ai/app-ui/dev-view.css'
import { Show, createResource, onCleanup } from 'solid-js'

import {
  createDevUtilityFenceSource,
  devUtilityContextKey,
  hasDevUtilitySession,
  sameDevUtilityScope,
  type DevUtilityContextReader,
} from '../utility-context'
import { readDevUtilityCommand } from '../utility-command'
import { HarnessStatusPane } from './harness-status-pane'

export type HarnessStatusSectionProps = {
  context: DevUtilityContextReader
}

export function HarnessStatusSection(props: HarnessStatusSectionProps) {
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
    const page = await readDevUtilityCommand<{ items: readonly HarnessRun[] }>(
      fence,
      'dev.harness.runs',
      {
        runtimeSessionId: fence.context.runtimeSessionId!,
      }
    )
    return {
      contextKey: key,
      items: (page?.items ?? []).filter(
        (run) =>
          run.runtimeSessionId === fence.context.runtimeSessionId &&
          sameDevUtilityScope(run.scope, fence.context.scope)
      ),
    }
  })
  const [preferences] = createResource(contextKey, async (key) => {
    const fence = fences.capture('session')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key)
      return { items: [] as readonly HarnessPreference[] }
    const page = await readDevUtilityCommand<{ items: readonly HarnessPreference[] }>(
      fence,
      'dev.harness.preferences',
      { projectId: fence.context.projectId! }
    )
    return {
      contextKey: key,
      items: (page?.items ?? []).filter(
        (preference) =>
          sameDevUtilityScope(preference.scope, fence.context.scope) &&
          (preference.projectId === undefined || preference.projectId === fence.context.projectId)
      ),
    }
  })
  const [managedPi] = createResource(contextKey, async (key) => {
    const fence = fences.capture('session')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key) return undefined
    const status = await readDevUtilityCommand<ManagedPiStatus>(
      fence,
      'dev.harness.managedPiStatus',
      {}
    )
    return {
      contextKey: key,
      status: status && sameDevUtilityScope(status.scope, fence.context.scope) ? status : undefined,
    }
  })

  return (
    <Show
      when={hasDevUtilitySession(context())}
      fallback={
        <p class="dev-pane-state__line" role="status">
          Agent status is unavailable until this view is bound to a canonical runtime session.
        </p>
      }
    >
      <Show
        when={runtime().state().status === 'ready'}
        fallback={<p class="dev-pane-state__line">Runtime unavailable</p>}
      >
        <HarnessStatusPane
          runs={
            runs()?.contextKey === contextKey()
              ? (runs()?.items ?? []).filter(
                  (run) =>
                    run.runtimeSessionId === context().runtimeSessionId &&
                    sameDevUtilityScope(run.scope, context().scope)
                )
              : []
          }
          preferences={
            preferences()?.contextKey === contextKey()
              ? (preferences()?.items ?? []).filter(
                  (preference) =>
                    sameDevUtilityScope(preference.scope, context().scope) &&
                    (preference.projectId === undefined ||
                      preference.projectId === context().projectId)
                )
              : []
          }
          managedPi={managedPi()?.contextKey === contextKey() ? managedPi()?.status : undefined}
        />
      </Show>
    </Show>
  )
}
