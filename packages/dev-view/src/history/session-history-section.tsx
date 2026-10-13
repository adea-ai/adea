/*
 * History pane section (#716, #400): reads the canonical event log of the one
 * bound runtime session through the same `runtime-events-v1` path Chat uses,
 * plus its durable HarnessRun history, and renders the pure HistoryPane. The
 * section keeps no store of its own: closing the pane closes the stream.
 */
import type { HarnessRun, RuntimeEvent, RuntimeSession } from '@adea-ai/types/dev-runtime'
import '@adea-ai/app-ui/dev-view.css'
import { Show, createEffect, createSignal, on, onCleanup } from 'solid-js'

import { openRuntimeEventStream } from '../chat/model/event-stream'
import { HistoryPane, type HistoryPaneStatus } from './history-pane'
import {
  createDevUtilityFenceSource,
  hasDevUtilitySession,
  isDevUtilityContextChanged,
  sameDevUtilityScope,
  type DevUtilityContextReader,
} from '../utility-context'
import { executeDevUtilityCommand } from '../utility-command'

export type SessionHistorySectionProps = {
  context: DevUtilityContextReader
}

type HistoryFeed = Readonly<{
  key: string
  status: HistoryPaneStatus
  events: readonly RuntimeEvent[]
  bounded: boolean
  session?: RuntimeSession
  runs: readonly HarnessRun[]
}>

const ACTIVE_RUN_STATES: ReadonlySet<string> = new Set([
  'working',
  'awaiting_input',
  'awaiting_approval',
])

function sessionKey(context: ReturnType<DevUtilityContextReader>): string | undefined {
  if (context.runtime.state().status !== 'ready' || !hasDevUtilitySession(context)) return undefined
  const scope = context.scope!
  return JSON.stringify([
    context.revision,
    scope.accountId,
    scope.workspaceId,
    scope.runtimeNodeId,
    context.runtimeSessionId,
    context.sessionGeneration,
  ])
}

function newestRunActive(runs: readonly HarnessRun[]): boolean {
  let newest: HarnessRun | undefined
  for (const run of runs) {
    if (!newest || run.generation > newest.generation || run.version > newest.version) newest = run
  }
  return newest !== undefined && ACTIVE_RUN_STATES.has(newest.state)
}

export function SessionHistorySection(props: SessionHistorySectionProps) {
  const context = () => props.context()
  const fences = createDevUtilityFenceSource(context)
  onCleanup(() => fences.dispose())
  const [feed, setFeed] = createSignal<HistoryFeed | undefined>()
  const [attempt, setAttempt] = createSignal(0)
  const key = () => sessionKey(context())

  createEffect(
    on([key, attempt], ([current]) => {
      setFeed(undefined)
      if (!current) return
      const fence = fences.capture('session')
      if (!fence || sessionKey(fence.context) !== current) return
      const { runtimeSessionId, sessionGeneration, scope } = fence.context
      let closed = false
      let stream: Awaited<ReturnType<typeof openRuntimeEventStream>> | undefined
      let unsubscribe: (() => void) | undefined
      let session: RuntimeSession | undefined
      let runs: readonly HarnessRun[] = []
      const publish = (status: HistoryPaneStatus) => {
        if (closed || !fence.isCurrent()) return
        const state = stream?.state()
        setFeed({
          key: current,
          status,
          events: state?.events ?? [],
          bounded: state ? !state.retention.complete : false,
          ...(session ? { session } : {}),
          runs,
        })
      }
      onCleanup(() => {
        closed = true
        unsubscribe?.()
        stream?.close()
      })
      void (async () => {
        try {
          const [record, page] = await Promise.all([
            executeDevUtilityCommand<RuntimeSession>(
              fence,
              'dev.session.get',
              { runtimeSessionId: runtimeSessionId! },
              { kind: 'runtime_session', id: runtimeSessionId!, generation: sessionGeneration! }
            ),
            executeDevUtilityCommand<{ items: readonly HarnessRun[] }>(fence, 'dev.harness.runs', {
              runtimeSessionId: runtimeSessionId!,
            }).catch((error: unknown) => {
              if (isDevUtilityContextChanged(error)) throw error
              return { items: [] as readonly HarnessRun[] }
            }),
          ])
          if (closed) return
          session = record
          runs = page.items.filter(
            (run) =>
              run.runtimeSessionId === runtimeSessionId && sameDevUtilityScope(run.scope, scope)
          )
          // A terminal-only session publishes no structured feed; saying so is
          // truer than an empty list that looks like "nothing was ever asked".
          if (record.projection === 'terminal_fallback') {
            publish('no_feed')
            return
          }
          publish('loading')
          stream = await openRuntimeEventStream({
            service: fence.context.runtime,
            scope: scope!,
            runtimeSessionId: runtimeSessionId!,
            resource: { kind: 'runtime_session', id: record.id, generation: record.generation },
            generation: record.generation,
          })
          if (closed) {
            stream.close()
            return
          }
          unsubscribe = stream.subscribe(() => publish('ready'))
          publish('ready')
        } catch (error) {
          if (closed || isDevUtilityContextChanged(error)) return
          publish('unavailable')
        }
      })()
    })
  )

  const current = () => {
    const value = feed()
    return value && value.key === key() ? value : undefined
  }

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
        when={context().runtime.state().status === 'ready'}
        fallback={<p class="dev-pane-state__line">Runtime unavailable</p>}
      >
        <HistoryPane
          status={current()?.status ?? 'loading'}
          events={current()?.events ?? []}
          {...(current()?.session ? { session: current()!.session } : {})}
          runs={current()?.runs ?? []}
          bounded={current()?.bounded ?? false}
          runActive={newestRunActive(current()?.runs ?? [])}
          onRetry={() => setAttempt((count) => count + 1)}
        />
      </Show>
    </Show>
  )
}
