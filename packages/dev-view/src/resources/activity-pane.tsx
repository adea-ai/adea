/*
 * Activity section (#424): the Agents pane's operational view of running
 * harness runs — who is working, what needs attention, elapsed time, and a
 * cancel control that rides the session-scoped, generation-fenced
 * `dev.session.cancelHarness` command. The section never fabricates state:
 * rows come only from the harness substrate's run records, and a session
 * without a live generation offers no cancel control.
 */
import type { DevError, HarnessRun } from '@adea-ai/types/dev-runtime'
import '@adea-ai/app-ui/dev-view.css'
import { Square } from 'lucide-solid'
import { For, Show, createEffect, createResource, createSignal, onCleanup } from 'solid-js'
import { cn } from '@adea-ai/ui/lib/utils'

import {
  createDevUtilityFenceSource,
  devUtilityContextKey,
  hasDevUtilitySession,
  isDevUtilityContextChanged,
  sameDevUtilityScope,
  type DevUtilityContextReader,
} from '../utility-context'
import { executeDevUtilityCommand, readDevUtilityCommand } from '../utility-command'
import { ACTIVITY_STATE_LABELS, activityRows, formatElapsed } from './activity-model'
import { Button } from '@adea-ai/ui/components/ui/button'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'

export type ActivityPaneProps = {
  context: DevUtilityContextReader
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

  const [runs, { refetch: refetchRuns }] = createResource(contextKey, async (key) => {
    const fence = fences.capture('session')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key)
      return { items: [] as readonly HarnessRun[] }
    const page = await readDevUtilityCommand<{ items: readonly HarnessRun[] }>(
      fence,
      'dev.harness.runs',
      { runtimeSessionId: fence.context.runtimeSessionId! }
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

  const generationFor = (runtimeSessionId: string): number | undefined =>
    runtimeSessionId === context().runtimeSessionId ? context().sessionGeneration : undefined

  const [actionError, setActionError] = createSignal<DevError | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)
  createEffect(() => {
    void contextKey()
    setActionError(undefined)
    setBusy(false)
  })

  async function cancelRun(row: { runtimeSessionId: string; id: string }): Promise<void> {
    const fence = fences.capture('session')
    if (
      !fence ||
      row.runtimeSessionId !== fence.context.runtimeSessionId ||
      fence.context.sessionGeneration === undefined
    )
      return
    const generation = fence.context.sessionGeneration
    setBusy(true)
    setActionError(undefined)
    try {
      await executeDevUtilityCommand<HarnessRun>(
        fence,
        'dev.session.cancelHarness',
        {
          runtimeSessionId: row.runtimeSessionId,
          expectedGeneration: generation,
          harnessRunId: row.id,
        },
        { kind: 'runtime_session', id: row.runtimeSessionId, generation }
      )
      if (!fence.isCurrent()) return
      await refetchRuns()
    } catch (error) {
      if (fence.isCurrent() && !isDevUtilityContextChanged(error))
        setActionError(commandError(error))
    } finally {
      if (fence.isCurrent()) setBusy(false)
    }
  }

  const rows = () => {
    const current = context()
    return activityRows(
      (runs()?.contextKey === contextKey() ? runs()?.items : undefined)?.filter(
        (run) =>
          run.runtimeSessionId === current.runtimeSessionId &&
          sameDevUtilityScope(run.scope, current.scope)
      ) ?? [],
      Date.now()
    )
  }

  return (
    <div class="dev-activity" role="region" aria-label="Activity">
      <Show
        when={hasDevUtilitySession(context())}
        fallback={
          <p class="dev-resources__unavailable" role="status">
            Activity is unavailable until this view is bound to a canonical runtime session.
          </p>
        }
      >
        <Show
          when={runtime().state().status === 'ready'}
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
                    class={cn('dev-activity__row', {
                      'dev-activity__row--attention': row.attention,
                    })}
                  >
                    <span class="dev-activity__row-title">
                      <span>
                        {row.agent}
                        <Show when={row.modelId !== undefined}> · {row.modelId}</Show>
                      </span>
                      <StatusChip
                        label={ACTIVITY_STATE_LABELS[row.state]}
                        tone={row.attention ? 'warning' : row.running ? 'info' : 'neutral'}
                      />
                    </span>
                    <span class="dev-resources__row-detail">
                      <Show when={row.elapsedMs !== undefined} fallback={<span>not started</span>}>
                        elapsed {formatElapsed(row.elapsedMs!)}
                      </Show>
                    </span>
                    <Show when={row.attention || row.running}>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={busy() || generationFor(row.runtimeSessionId) === undefined}
                        title={
                          generationFor(row.runtimeSessionId) === undefined
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
      </Show>
    </div>
  )
}
