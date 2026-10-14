/*
 * History pane section (#716, #400): reads the canonical event log of the one
 * bound runtime session through the same `runtime-events-v1` path Chat uses,
 * plus its durable HarnessRun history, and renders the pure HistoryPane. The
 * "All sessions" scope adds a bounded read of the workspace's other sessions
 * (`all-sessions-scan`), a jump to a result's session and event, and a
 * confirmed resume of a session's run. The section keeps no store of its own:
 * closing the pane closes every stream and drops the scan.
 */
import type {
  DevOperation,
  HarnessRun,
  RuntimeEvent,
  RuntimeSession,
  Scope,
} from '@adea-ai/types/dev-runtime'
import '@adea-ai/app-ui/dev-view.css'
import { Show, createEffect, createSignal, on, onCleanup } from 'solid-js'

import { openRuntimeEventStream } from '../chat/model/event-stream'
import type { ConversationSearchJump } from '../chat/search'
import { ResumeRefusedError, type ResumeTarget } from './all-sessions-model'
import type { AllSessionsFeed } from './all-sessions-results'
import { readEventWindow, scanAllSessions, type AllSessionsScan } from './all-sessions-scan'
import {
  eventRevealRequest,
  hasEventRevealConsumer,
  requestEventReveal,
  settleEventReveal,
} from './event-reveal'
import { HistoryPane, type HistoryPaneStatus, type HistoryScope } from './history-pane'
import { isResumable } from './run-history-model'
import { newestRun, newestRunActive, transcriptIsStale } from './turns-model'
import {
  DevUtilityContextChangedError,
  createDevUtilityFenceSource,
  hasDevUtilitySession,
  isDevUtilityContextChanged,
  sameDevUtilityScope,
  type DevUtilityContext,
  type DevUtilityContextReader,
  type DevUtilityFence,
} from '../utility-context'
import { executeDevUtilityCommand } from '../utility-command'

/** Where a "Go to" or a finished resume sends the host: open this session. */
export type HistorySessionTarget = Readonly<{ projectId: string; runtimeSessionId: string }>

export type SessionHistorySectionProps = {
  context: DevUtilityContextReader
  /** Select a session in the host (Dev or Chat); absent hosts only reveal in place. */
  onOpenSession?: (target: HistorySessionTarget) => void
}

const SCOPE_KEY = 'adea.dev.history.scope.v1'
/** A scan older than this is read again when the scope is chosen. */
const SCAN_FRESH_MS = 30_000
/** How long History waits for a transcript to show an event before saying so. */
const REVEAL_WAIT_MS = 6_000
const NOTICE_MS = 8_000

// Timers only clear a notice or settle a stale reveal request; firing after the
// pane closed changes nothing visible.
const later = (run: () => void, ms: number) => void setTimeout(run, ms)

function readScope(): HistoryScope {
  try {
    return window.localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'session'
  } catch {
    return 'session'
  }
}

function writeScope(scope: HistoryScope): void {
  try {
    window.localStorage.setItem(SCOPE_KEY, scope)
  } catch {
    // Storage may be blocked: the choice holds for this page load.
  }
}

/** Runtime identity of the whole workspace, independent of the open session. */
function scanKey(context: DevUtilityContext): string | undefined {
  const scope = context.scope
  return scope && context.runtime.state().status === 'ready'
    ? JSON.stringify([scope.accountId, scope.workspaceId, scope.runtimeNodeId])
    : undefined
}

type HistoryFeed = Readonly<{
  key: string
  status: HistoryPaneStatus
  events: readonly RuntimeEvent[]
  bounded: boolean
  session?: RuntimeSession
  runs: readonly HarnessRun[]
}>

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

export function SessionHistorySection(props: SessionHistorySectionProps) {
  const context = () => props.context()
  const fences = createDevUtilityFenceSource(context)
  onCleanup(() => fences.dispose())
  const [feed, setFeed] = createSignal<HistoryFeed | undefined>()
  const [attempt, setAttempt] = createSignal(0)
  const key = () => sessionKey(context())

  // --- All sessions: a bounded scan of the workspace, kept while the pane is open.
  const [historyScope, setHistoryScope] = createSignal<HistoryScope>(readScope())
  const [all, setAll] = createSignal<AllSessionsFeed>({ status: 'loading' })
  const [scanAttempt, setScanAttempt] = createSignal(0)
  const [notice, setNotice] = createSignal<{ title: string; detail?: string }>()
  // The event a Dev "Go to" asked for; kept until its session's feed shows it.
  const [focus, setFocus] = createSignal<{ sessionId: string; eventId: string }>()
  const workspaceKey = () => scanKey(context())
  let disposed = false
  let scannedFor: { key: string; attempt: number; scan: AllSessionsScan } | undefined
  onCleanup(() => {
    disposed = true
  })
  const say = (value: { title: string; detail?: string }) => {
    setNotice(value)
    later(() => setNotice(undefined), NOTICE_MS)
  }

  // A fence over the workspace only: the scan outlives a change of open session.
  const workspaceFence = (): DevUtilityFence | undefined => {
    const captured = context()
    const identity = scanKey(captured)
    if (!identity || !captured.scope) return undefined
    return {
      context: captured,
      key: identity,
      isCurrent: () =>
        !disposed && context().runtime === captured.runtime && scanKey(context()) === identity,
    }
  }

  const scan = async (fence: DevUtilityFence, soft: boolean) => {
    const { runtime, scope: workspace } = fence.context
    if (!soft) setAll({ status: 'loading' })
    const list =
      <T extends { scope: Scope }>(command: DevOperation, base: object) =>
      async (cursor: string | undefined) => {
        const page = await executeDevUtilityCommand<{
          items: readonly T[]
          nextCursor?: string
        }>(fence, command, { ...base, ...(cursor ? { cursor } : {}) })
        return {
          ...page,
          items: page.items.filter((item) => sameDevUtilityScope(item.scope, workspace)),
        }
      }
    try {
      const result = await scanAllSessions({
        assertCurrent: () => {
          if (!fence.isCurrent()) throw new DevUtilityContextChangedError()
        },
        listSessions: list<RuntimeSession>('dev.session.list', { archived: false, limit: 200 }),
        listRuns: list<HarnessRun>('dev.harness.runs', { limit: 500 }),
        readWindow: async (session) =>
          readEventWindow(
            await openRuntimeEventStream({
              service: runtime,
              scope: workspace!,
              runtimeSessionId: session.id,
              resource: { kind: 'runtime_session', id: session.id, generation: session.generation },
              generation: session.generation,
            })
          ),
      })
      scannedFor = { key: fence.key, attempt: scanAttempt(), scan: result }
      setAll({ status: 'ready', scan: result })
    } catch (error) {
      if (disposed || isDevUtilityContextChanged(error)) return
      if (!soft) setAll({ status: 'unavailable' })
    }
  }

  createEffect(
    on([historyScope, workspaceKey, scanAttempt], ([chosen, identity, tries]) => {
      if (chosen !== 'all' || !identity) return
      if (
        scannedFor?.key === identity &&
        scannedFor.attempt === tries &&
        Date.now() - scannedFor.scan.scannedAt < SCAN_FRESH_MS
      )
        return setAll({ status: 'ready', scan: scannedFor.scan })
      const fence = workspaceFence()
      if (fence) void scan(fence, false)
    })
  )

  const chooseScope = (next: HistoryScope) => {
    writeScope(next)
    setHistoryScope(next)
  }

  const sessionRecord = (runtimeSessionId: string) =>
    all().scan?.sessions.find((candidate) => candidate.id === runtimeSessionId) ??
    (feed()?.session?.id === runtimeSessionId ? feed()?.session : undefined)

  const go = (jump: ConversationSearchJump) => {
    const bound = context().runtimeSessionId
    if (jump.runtimeSessionId !== bound) {
      const record = sessionRecord(jump.runtimeSessionId)
      if (!record) return say({ title: 'That session is no longer open.' })
      props.onOpenSession?.({ projectId: record.projectId, runtimeSessionId: record.id })
    }
    const eventId = jump.eventId
    if (!eventId) return
    if (!hasEventRevealConsumer()) {
      const target = { sessionId: jump.runtimeSessionId, eventId }
      setFocus(target)
      return later(
        () => setFocus((current) => (current === target ? undefined : current)),
        REVEAL_WAIT_MS
      )
    }
    const token = requestEventReveal(jump.runtimeSessionId, eventId)
    later(() => {
      if (eventRevealRequest()?.token !== token) return
      settleEventReveal(token)
      say({ title: 'That event is no longer shown in the conversation.' })
    }, REVEAL_WAIT_MS)
  }

  const resume = async (target: ResumeTarget) => {
    const fence = workspaceFence()
    const record = sessionRecord(target.runtimeSessionId)
    if (!fence || !record) throw new ResumeRefusedError('the session is no longer available.')
    const page = await executeDevUtilityCommand<{ items: readonly HarnessRun[] }>(
      fence,
      'dev.harness.runs',
      { runtimeSessionId: target.runtimeSessionId, limit: 500 }
    )
    const runs = page.items.filter((run) => run.runtimeSessionId === target.runtimeSessionId)
    const run = runs.find((candidate) => candidate.id === target.harnessRunId)
    // The list is only as fresh as the scan: resume the run it showed only if
    // that run is still the session's newest and still resumable.
    if (!run || newestRun(runs)?.id !== run.id || !isResumable(run))
      throw new ResumeRefusedError('the run has changed since this list was read.')
    const started = await executeDevUtilityCommand<HarnessRun>(
      fence,
      'dev.session.resumeHarness',
      {
        runtimeSessionId: record.id,
        expectedGeneration: record.generation,
        harnessRunId: run.id,
      },
      { kind: 'runtime_session', id: record.id, generation: record.generation }
    )
    props.onOpenSession?.({ projectId: record.projectId, runtimeSessionId: record.id })
    say({
      title: `Resumed “${target.title}”`,
      detail: `Generation ${started.generation} started in this session.`,
    })
    // What the list showed is now out of date; read it again in place.
    setScanAttempt((count) => count + 1)
  }

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
          const observe = () => {
            const state = stream?.state()
            if (!state || !transcriptIsStale(state.availability)) return publish('ready')
            // Stop reading a window that has a gap or belongs to an older
            // generation and say so; Try again reopens against the current
            // session record.
            unsubscribe?.()
            stream?.close()
            stream = undefined
            publish('stale')
          }
          unsubscribe = stream.subscribe(observe)
          observe()
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
      <HistoryPane
        status={
          context().runtime.state().status !== 'ready'
            ? 'not_ready'
            : (current()?.status ?? 'loading')
        }
        events={current()?.events ?? []}
        session={current()?.session}
        runs={current()?.runs ?? []}
        bounded={current()?.bounded ?? false}
        runActive={newestRunActive(current()?.runs ?? [])}
        onRetry={() => setAttempt((count) => count + 1)}
        onGo={go}
        scope={historyScope()}
        onScopeChange={chooseScope}
        all={workspaceKey() ? all() : undefined}
        boundSessionId={context().runtimeSessionId}
        onRetryAll={() => void setScanAttempt((count) => count + 1)}
        onResume={resume}
        notice={notice()}
        focusEventId={
          focus()?.sessionId === context().runtimeSessionId ? focus()?.eventId : undefined
        }
        onFocusResult={(found) => {
          setFocus(undefined)
          if (!found) say({ title: 'That prompt is no longer in the retained history.' })
        }}
      />
    </Show>
  )
}
