/*
 * Activity section (#424): the Agents pane's operational view of running
 * harness runs — who is working, what needs attention, elapsed time, and a
 * cancel control that rides the session-scoped, generation-fenced
 * `dev.session.cancelHarness` command. The section never fabricates state:
 * rows come only from the harness substrate's run records, and a session
 * without a live generation offers no cancel control.
 */
import type { DevError, HarnessRun, RuntimeSession } from '@adea-ai/types/dev-runtime'
import '@adea-ai/app-ui/dev-view.css'
import { Square } from 'lucide-solid'
import { For, Show, createEffect, createSignal } from 'solid-js'
import { cn } from '@adea-ai/ui/lib/utils'

import type { DevRuntimeService } from '../platform'
import { buildDevCommand } from '../browser/command'
import { ACTIVITY_STATE_LABELS, activityRows, formatElapsed } from './activity-model'
import { Button } from '@adea-ai/ui/components/ui/button'
import {
  createDevUtilityResource,
  createDevUtilityResourceRequest,
  sameDevUtilityRequest,
  type DevUtilityResourceRequest,
} from '../utility/runtime-resource'

export type ActivityPaneProps = {
  runtime: DevRuntimeService
  runtimeSessionId?: string
}

function commandError(error: unknown): DevError {
  return (
    (error as { error?: DevError })?.error ?? {
      code: 'invalid_state',
      retryable: false,
      message: error instanceof Error ? error.message : 'command failed',
    }
  )
}

export function ActivityPane(props: ActivityPaneProps) {
  const runtime = () => props.runtime
  const serviceReady = () => runtime().state().status === 'ready'
  const request = createDevUtilityResourceRequest(() => ({
    runtime: runtime(),
    runtimeSessionId: props.runtimeSessionId,
  }))
  const scopeRequest = createDevUtilityResourceRequest(() => ({ runtime: runtime() }), false)

  async function execute<T>(
    key: DevUtilityResourceRequest,
    operation: Parameters<typeof buildDevCommand>[0]['operation'],
    body: Record<string, unknown>,
    resource?: { kind: string; id: string; generation: number }
  ): Promise<T> {
    if (!key.ready || !key.scope) throw new Error('runtime scope unavailable')
    const reply = await key.runtime.execute(
      buildDevCommand({ scope: key.scope, operation, body, ...(resource ? { resource } : {}) })
    )
    if (!reply.ok) throw reply
    return reply.value as T
  }

  const [runs, { refetch: refetchRuns }] = createDevUtilityResource(request, async (key) => {
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
  const [sessions] = createDevUtilityResource(scopeRequest, async (key) => {
    if (!key.ready || !key.scope) return { items: [] as readonly RuntimeSession[] }
    const reply = await key.runtime.execute(
      buildDevCommand({ operation: 'dev.session.list', scope: key.scope, body: {} })
    )
    if (!reply.ok) throw reply
    return reply.value as { items: readonly RuntimeSession[] }
  })

  const generationFor = (runtimeSessionId: string): number | undefined =>
    sessions()?.value.items.find((session) => session.id === runtimeSessionId)?.generation

  const [actionError, setActionError] = createSignal<DevError | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)
  let actionGeneration = 0

  createEffect(() => {
    request()
    actionGeneration += 1
    setBusy(false)
    setActionError(undefined)
  })

  async function cancelRun(
    row: { runtimeSessionId: string; id: string; request: DevUtilityResourceRequest }
  ): Promise<void> {
    if (
      !sameDevUtilityRequest(row.request, request()) ||
      row.request.runtimeSessionId !== row.runtimeSessionId
    )
      return
    const generation = generationFor(row.runtimeSessionId)
    if (generation === undefined) return
    const action = ++actionGeneration
    const isCurrentAction = () =>
      action === actionGeneration && sameDevUtilityRequest(row.request, request())
    setBusy(true)
    setActionError(undefined)
    try {
      await execute<HarnessRun>(
        row.request,
        'dev.session.cancelHarness',
        {
          runtimeSessionId: row.runtimeSessionId,
          expectedGeneration: generation,
          harnessRunId: row.id,
        },
        { kind: 'runtime_session', id: row.runtimeSessionId, generation }
      )
      if (!isCurrentAction()) return
      await refetchRuns()
    } catch (error) {
      if (isCurrentAction()) setActionError(commandError(error))
    } finally {
      if (isCurrentAction()) setBusy(false)
    }
  }

  const rows = () => {
    const snapshot = runs()
    return snapshot
      ? activityRows(snapshot.value.items, Date.now()).map((row) => ({
          ...row,
          request: snapshot.request,
        }))
      : []
  }

  return (
    <div class="dev-activity" role="region" aria-label="Activity">
      <Show
        when={serviceReady()}
        fallback={<p class="dev-resources__unavailable">Runtime unavailable</p>}
      >
        <Show
          when={rows().length > 0}
          fallback={<p class="dev-resources__note">No harness activity for this scope.</p>}
        >
          <ul class="dev-resources__list">
            <For each={rows()}>
              {(row) => (
                <li
                  class={cn('dev-activity__row', { 'dev-activity__row--attention': row.attention })}
                >
                  <span class="dev-activity__row-title">
                    <span>
                      {row.agent}
                      <Show when={row.modelId !== undefined}> · {row.modelId}</Show>
                    </span>
                    <span
                      class={cn('dev-activity__badge', {
                        'dev-activity__badge--attention': row.attention,
                        'dev-activity__badge--running': row.running,
                      })}
                    >
                      {ACTIVITY_STATE_LABELS[row.state]}
                    </span>
                  </span>
                  <span class="dev-resources__row-detail">
                    <Show when={row.elapsedMs !== undefined} fallback={<span>not started</span>}>
                      elapsed {formatElapsed(row.elapsedMs!)}
                    </Show>
                  </span>
                  <Show when={row.attention || row.running}>
                    <Button
                      type="button"
                      class="dev-resources__cancel"
                      disabled={
                        busy() ||
                        !sameDevUtilityRequest(row.request, request()) ||
                        generationFor(row.runtimeSessionId) === undefined
                      }
                      title={
                        !sameDevUtilityRequest(row.request, request())
                          ? 'The selected runtime session changed; refresh before cancelling'
                          : generationFor(row.runtimeSessionId) === undefined
                          ? 'The session generation is unknown; cancel is unavailable'
                          : 'Cancel this run'
                      }
                      onClick={() => void cancelRun(row)}
                    >
                      <Square aria-hidden="true" /> Stop
                    </Button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={actionError() !== undefined}>
          <p class="dev-resources__error" role="alert">
            {actionError()!.code}: {actionError()!.message}
          </p>
        </Show>
      </Show>
    </div>
  )
}
