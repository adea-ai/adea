/*
 * Activity section (#424): the Agents pane's operational view of running
 * harness runs — who is working, what needs attention, elapsed time, and a
 * cancel control that rides the session-scoped, generation-fenced
 * `dev.session.cancelHarness` command. The section never fabricates state:
 * rows come only from the harness substrate's run records, and a session
 * without a live generation offers no cancel control.
 */
import type { DevError, HarnessRun, RuntimeSession } from '@adea-ai/types/dev-runtime'
import '@adea-ai/ui/dev-view.css'
import { Square } from 'lucide-solid'
import { For, Show, createResource, createSignal } from 'solid-js'

import type { DevRuntimeService } from '../platform'
import { buildDevCommand } from '../browser/command'
import { ACTIVITY_STATE_LABELS, activityRows, formatElapsed } from './activity-model'

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
  const scope = () => runtime().preferenceScope?.()
  const serviceReady = () => runtime().state().status === 'ready'

  async function execute<T>(
    operation: Parameters<typeof buildDevCommand>[0]['operation'],
    body: Record<string, unknown>,
    resource?: { kind: string; id: string; generation: number }
  ): Promise<T> {
    const activeScope = scope()
    if (!activeScope) throw new Error('unauthenticated')
    const reply = await runtime().execute(
      buildDevCommand({ operation, scope: activeScope, body, ...(resource ? { resource } : {}) })
    )
    if (!reply.ok) throw reply
    return reply.value as T
  }

  const [runs, { refetch: refetchRuns }] = createResource(serviceReady, async (ready) => {
    if (!ready) return { items: [] as readonly HarnessRun[] }
    return execute<{ items: readonly HarnessRun[] }>(
      'dev.harness.runs',
      props.runtimeSessionId ? { runtimeSessionId: props.runtimeSessionId } : {}
    )
  })
  const [sessions] = createResource(serviceReady, async (ready) => {
    if (!ready) return { items: [] as readonly RuntimeSession[] }
    return execute<{ items: readonly RuntimeSession[] }>('dev.session.list', {})
  })

  const generationFor = (runtimeSessionId: string): number | undefined =>
    sessions()?.items.find((session) => session.id === runtimeSessionId)?.generation

  const [actionError, setActionError] = createSignal<DevError | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)

  async function cancelRun(row: { runtimeSessionId: string; id: string }): Promise<void> {
    const generation = generationFor(row.runtimeSessionId)
    if (generation === undefined) return
    setBusy(true)
    setActionError(undefined)
    try {
      await execute<HarnessRun>(
        'dev.session.cancelHarness',
        {
          runtimeSessionId: row.runtimeSessionId,
          expectedGeneration: generation,
          harnessRunId: row.id,
        },
        { kind: 'runtime_session', id: row.runtimeSessionId, generation }
      )
      await refetchRuns()
    } catch (error) {
      setActionError(commandError(error))
    } finally {
      setBusy(false)
    }
  }

  const rows = () => activityRows(runs()?.items ?? [], Date.now())

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
                  class="dev-activity__row"
                  classList={{ 'dev-activity__row--attention': row.attention }}
                >
                  <span class="dev-activity__row-title">
                    <span>
                      {row.agent}
                      <Show when={row.modelId !== undefined}> · {row.modelId}</Show>
                    </span>
                    <span
                      class="dev-activity__badge"
                      classList={{
                        'dev-activity__badge--attention': row.attention,
                        'dev-activity__badge--running': row.running,
                      }}
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
                    <button
                      type="button"
                      class="dev-resources__cancel"
                      disabled={busy() || generationFor(row.runtimeSessionId) === undefined}
                      title={
                        generationFor(row.runtimeSessionId) === undefined
                          ? 'The session generation is unknown; cancel is unavailable'
                          : 'Cancel this run'
                      }
                      onClick={() => void cancelRun(row)}
                    >
                      <Square aria-hidden="true" /> Stop
                    </button>
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
