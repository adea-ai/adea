import { For, Show, type JSX } from 'solid-js'
import { TraceDetail, TraceLine, type TraceStatus } from '@adea-ai/ui/components/ui/trace'
import { formatDuration } from '@adea-ai/ui/components/composites/reasoning'
import { Checkpoint } from '@adea-ai/ui/components/composites/checkpoint'
import { FileTree } from '@adea-ai/ui/components/composites/file-tree'
import { Plan, type PlanStepStatus } from '@adea-ai/ui/components/composites/plan'
import { StackTrace } from '@adea-ai/ui/components/composites/stack-trace'
import {
  TaskItemList,
  TaskItemRow,
  type TaskItemStatus,
} from '@adea-ai/ui/components/composites/task'
import { Terminal, type TerminalStatus } from '@adea-ai/ui/components/composites/terminal'
import {
  TestResults,
  type TestCase,
  type TestCaseStatus,
  type TestSuite,
} from '@adea-ai/ui/components/composites/test-results'

import { CHECKPOINT_RESTORE_CONSEQUENCE } from './model/checkpoint-restore'
import type { ChatTurnResult } from './model/turns'
import {
  stackText,
  type ChatFilesResult,
  type ChatPlanResult,
  type ChatResult,
  type ChatResultFailure,
  type ChatResultStatus,
  type ChatTaskResult,
  type ChatTerminalResult,
  type ChatTestRunResult,
  type ChatWorkStatus,
} from './model/results'

const RESULT_KINDS: Record<ChatResult['type'], string> = {
  checkpoint: 'checkpoint.observed',
  terminal: 'terminal.output',
  test_run: 'test_run.observed',
  failure: 'failure.observed',
  files: 'files.changed',
  plan: 'plan.observed',
  task: 'task.observed',
}

/**
 * Marks and words are the producer's last word, not a fact about now: a status that
 * says work is under way animates only while the session is working, and after that
 * the line says "not finished". `unknown` and statuses with no mark make no claim.
 */
const workStatus = (status: ChatWorkStatus, live: boolean): TraceStatus | undefined => {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'cancelled':
      return 'cancelled'
    case 'pending':
      return live ? 'pending' : undefined
    case 'in_progress':
      return live ? 'running' : undefined
    default:
      return undefined
  }
}

const runStatus = (status: ChatResultStatus, live: boolean): TraceStatus | undefined => {
  switch (status) {
    case 'passed':
      return 'success'
    case 'failed':
      return 'error'
    case 'cancelled':
      return 'cancelled'
    case 'pending':
      return live ? 'pending' : undefined
    case 'running':
      return live ? 'running' : undefined
    default:
      return undefined
  }
}

const stoppedWord = (status: ChatResultStatus | ChatWorkStatus, live: boolean) =>
  !live && (status === 'running' || status === 'in_progress') ? 'not finished' : undefined

/** `2026-10-14T10:00:00.000Z` → `2026-10-14 10:00 UTC`: the same clock for everyone. */
function utcTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`
}

function FailureBlock(props: { failure: ChatResultFailure }): JSX.Element {
  const stack = () => stackText(props.failure)
  return (
    <TraceDetail data-result-failure={props.failure.failureId}>
      <Show when={props.failure.name}>{(name) => <strong>{name()}</strong>}</Show>
      <p class="m-0 whitespace-pre-wrap break-words">{props.failure.message}</p>
      <Show when={stack()}>{(text) => <StackTrace text={text()} />}</Show>
    </TraceDetail>
  )
}

function TerminalResult(props: {
  terminal: ChatTerminalResult
  live: boolean
  common: Record<string, string>
}): JSX.Element {
  const status = (): TraceStatus | undefined => {
    switch (props.terminal.status) {
      case 'succeeded':
        return 'success'
      case 'failed':
        return 'error'
      case 'cancelled':
        return 'cancelled'
      case 'running':
        return props.live ? 'running' : undefined
      default:
        return undefined
    }
  }
  // Only a reported exit code is a terminal status; a command that "succeeded" with
  // no code makes the shared terminal say nothing about how it ended.
  const terminalStatus = (): TerminalStatus | undefined => {
    const t = props.terminal
    if (t.status === 'running') return props.live ? { state: 'running' } : undefined
    if (t.status === 'cancelled') return { state: 'cancelled' }
    return t.exitCode === undefined ? undefined : { state: 'exited', code: t.exitCode }
  }
  const meta = () =>
    [
      props.terminal.status === 'running' && !props.live ? 'not finished' : undefined,
      props.terminal.durationMs !== undefined
        ? formatDuration(props.terminal.durationMs / 1000)
        : undefined,
    ]
      .filter(Boolean)
      .join(' · ') || undefined
  return (
    <TraceLine
      {...props.common}
      title={props.terminal.command ?? 'Terminal output'}
      status={status()}
      meta={meta()}
    >
      <Terminal output={props.terminal.text} status={terminalStatus()} size="sm" wrap />
      <Show when={props.terminal.cut}>
        <TraceDetail>Later output is not shown.</TraceDetail>
      </Show>
      <Show
        when={
          props.terminal.streams.includes('stdout') && props.terminal.streams.includes('stderr')
        }
      >
        <TraceDetail>Standard output and error are interleaved.</TraceDetail>
      </Show>
    </TraceLine>
  )
}

const TEST_STATUS: Partial<Record<ChatResultStatus, TestCaseStatus>> = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  running: 'running',
  pending: 'pending',
}

/**
 * The producer's tests grouped under the suites they name. A test that names no suite,
 * or one this report does not list, is shown under a plain "Tests" group rather than
 * dropped; a failure is attached to the test that names it.
 */
function testSuites(run: ChatTestRunResult, live: boolean): readonly TestSuite[] {
  const failures = new Map(run.failures.map((failure) => [failure.failureId, failure]))
  const attach = (test: ChatTestRunResult['tests'][number], failureIds?: readonly string[]) => {
    const linked = (failureIds ?? [])
      .map((id) => failures.get(id))
      .filter((failure): failure is ChatResultFailure => failure !== undefined)
    return {
      id: test.testId,
      name: test.name,
      // A test reported as running or pending is the producer's last word; once the
      // session is no longer live it is listed without a claim about now.
      ...(TEST_STATUS[test.status] !== undefined &&
      (live || (test.status !== 'running' && test.status !== 'pending'))
        ? { status: TEST_STATUS[test.status] }
        : {}),
      ...(test.durationMs !== undefined ? { durationMs: test.durationMs } : {}),
      ...(linked.length > 0
        ? {
            message: linked.map((failure) => failure.message).join('\n\n'),
            stack:
              linked
                .map(stackText)
                .filter((text): text is string => text !== undefined)
                .join('\n') || undefined,
          }
        : {}),
    } satisfies TestCase
  }
  const listed = new Set(run.suites.map((suite) => suite.suiteId))
  const bySuite = new Map<string | undefined, TestCase[]>()
  for (const test of run.tests) {
    const key = test.suiteId !== undefined && listed.has(test.suiteId) ? test.suiteId : undefined
    bySuite.set(key, [...(bySuite.get(key) ?? []), attach(test, test.failureIds)])
  }
  const suites: TestSuite[] = run.suites.map((suite) => ({
    id: suite.suiteId,
    name: suite.name,
    ...(suite.durationMs !== undefined ? { durationMs: suite.durationMs } : {}),
    tests: bySuite.get(suite.suiteId) ?? [],
  }))
  const rest = bySuite.get(undefined)
  return rest === undefined ? suites : [...suites, { id: 'unsuited', name: 'Tests', tests: rest }]
}

const SUITE_WORDS: Partial<Record<ChatResultStatus, string>> = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  cancelled: 'cancelled',
}

/** What the producer said about each suite, apart from the tests it happens to list. */
function suiteStatusWord(status: ChatResultStatus, live: boolean): string | undefined {
  if (status === 'running' || status === 'pending') return live ? status : 'not finished'
  return SUITE_WORDS[status]
}

function TestRunResult(props: {
  run: ChatTestRunResult
  live: boolean
  common: Record<string, string>
}): JSX.Element {
  // A failure no test names still has to be read.
  const unattached = () => {
    const named = new Set(props.run.tests.flatMap((test) => test.failureIds ?? []))
    return props.run.failures.filter((failure) => !named.has(failure.failureId))
  }
  const reportedSuites = () =>
    props.run.suites.flatMap((suite) => {
      const word = suiteStatusWord(suite.status, props.live)
      return word === undefined ? [] : [{ suiteId: suite.suiteId, name: suite.name, word }]
    })
  return (
    <TraceLine
      {...props.common}
      title="Test run"
      status={runStatus(props.run.status, props.live)}
      meta={stoppedWord(props.run.status, props.live)}
    >
      <TestResults
        suites={testSuites(props.run, props.live)}
        summary={props.run.summary}
        running={props.live && props.run.status === 'running'}
      />
      <Show when={reportedSuites().length > 0}>
        <TraceDetail data-suite-status="">
          <p class="m-0">Suite status as the producer reported it:</p>
          <ul class="m-0 list-none p-0">
            <For each={reportedSuites()}>
              {(suite) => (
                <li data-suite-id={suite.suiteId}>
                  {suite.name}: {suite.word}
                </li>
              )}
            </For>
          </ul>
        </TraceDetail>
      </Show>
      <For each={unattached()}>{(failure) => <FailureBlock failure={failure} />}</For>
      <Show when={props.run.complete === false}>
        <TraceDetail>The producer marked this report incomplete.</TraceDetail>
      </Show>
    </TraceLine>
  )
}

function FilesResult(props: {
  files: ChatFilesResult
  common: Record<string, string>
}): JSX.Element {
  const listed = () => props.files.files.length
  // A total, an addition count and a deletion count are the producer's claims: each is
  // drawn only if it was sent, and the length of the list is never presented as a total.
  const description = () => {
    const summary = props.files.summary
    const count =
      summary?.files !== undefined
        ? `${summary.files} ${summary.files === 1 ? 'file' : 'files'}${
            listed() < summary.files ? ` (${listed()} listed)` : ''
          }`
        : props.files.complete === true
          ? `${listed()} ${listed() === 1 ? 'file' : 'files'}`
          : `${listed()} listed`
    const lines = [
      summary?.additions !== undefined ? `+${summary.additions}` : undefined,
      summary?.deletions !== undefined ? `−${summary.deletions}` : undefined,
    ].filter(Boolean)
    return lines.length > 0 ? `${count} · ${lines.join(' ')}` : count
  }
  const partial = () =>
    props.files.complete === false ||
    (props.files.summary?.files !== undefined && listed() < props.files.summary.files)
  const unstated = () =>
    props.files.complete === undefined && props.files.summary?.files === undefined
  return (
    <TraceLine {...props.common} title="Changed files" description={description()}>
      <FileTree
        showSummary={false}
        files={props.files.files.map((file) => ({
          path: file.path,
          // `copied` and `untracked` have no mark in the shared tree; the file is
          // listed and nothing more is said about it.
          ...(file.change === 'added' ||
          file.change === 'modified' ||
          file.change === 'deleted' ||
          file.change === 'renamed'
            ? { change: file.change }
            : {}),
          ...(file.previousPath !== undefined ? { renamedFrom: file.previousPath } : {}),
          ...(file.additions !== undefined ? { additions: file.additions } : {}),
          ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
        }))}
      />
      <Show when={partial()}>
        <TraceDetail>Only part of the change set is listed.</TraceDetail>
      </Show>
      <Show when={unstated()}>
        <TraceDetail>The producer did not say whether this list is complete.</TraceDetail>
      </Show>
    </TraceLine>
  )
}

const STEP_STATUS = (status: ChatWorkStatus, live: boolean): PlanStepStatus | undefined => {
  switch (status) {
    case 'completed':
      return 'complete'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'skipped'
    case 'pending':
      return 'pending'
    case 'in_progress':
      return live ? 'active' : undefined
    default:
      return undefined
  }
}

const WORK_WORDS: Partial<Record<ChatWorkStatus, string>> = {
  pending: 'pending',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** The producer's status for a plan or an item, in words; work under way reads "not finished" once the session stops. */
const workWord = (status: ChatWorkStatus, live: boolean): string | undefined =>
  status === 'in_progress' ? (live ? 'in progress' : 'not finished') : WORK_WORDS[status]

function PlanResult(props: {
  plan: ChatPlanResult
  live: boolean
  common: Record<string, string>
}): JSX.Element {
  const listed = () => props.plan.items.length
  // "k of n steps done" is derived from the steps passed in, so it is only true when the
  // list is the whole plan. When the producer did not say so, the steps carry their own
  // words and no progress is computed.
  const whole = () => props.plan.complete === true
  const claimed = () => props.plan.summary?.total
  const note = () => {
    if (whole()) return undefined
    const counted = claimed() !== undefined ? ` The producer counts ${claimed()} steps.` : ''
    return props.plan.complete === false
      ? `The producer marked this plan incomplete: ${listed()} ${listed() === 1 ? 'step is' : 'steps are'} listed, so no progress is computed.${counted}`
      : `The producer did not say whether this list is complete, so no progress is computed.${counted}`
  }
  const meta = () =>
    [workWord(props.plan.status, props.live), whole() ? undefined : `${listed()} listed`]
      .filter(Boolean)
      .join(' · ') || undefined
  return (
    <Plan
      {...props.common}
      title={props.plan.title ?? 'Plan'}
      meta={meta()}
      steps={props.plan.items.map((item) => {
        const word = workWord(item.status, props.live)
        const status = whole() ? STEP_STATUS(item.status, props.live) : undefined
        const description = [!whole() ? word : undefined, item.description]
          .filter(Boolean)
          .join(' — ')
        return {
          id: item.id,
          label: item.title,
          ...(description.length > 0 ? { description } : {}),
          ...(status !== undefined ? { status } : {}),
        }
      })}
      description={note()}
    />
  )
}

function TaskResult(props: {
  task: ChatTaskResult
  live: boolean
  common: Record<string, string>
}): JSX.Element {
  return (
    <TraceLine
      {...props.common}
      title={props.task.title}
      description={props.task.description}
      status={workStatus(props.task.status, props.live)}
      meta={stoppedWord(props.task.status, props.live)}
    >
      <Show when={props.task.todos.length > 0}>
        <TaskItemList label={`${props.task.title} items`}>
          <For each={props.task.todos}>
            {(item) => (
              <TaskItemRow
                text={item.title}
                description={item.description}
                status={STEP_STATUS(item.status, props.live) as TaskItemStatus | undefined}
              />
            )}
          </For>
        </TaskItemList>
      </Show>
    </TraceLine>
  )
}

/** A structured result the producer observed, drawn with the shared AI Elements. */
export function ResultLine(props: {
  entry: () => ChatTurnResult
  live: () => boolean
  onRestoreCheckpoint?: (checkpoint: {
    checkpointId: string
    checkpointEventId: string
  }) => void | Promise<void>
}): JSX.Element {
  const result = () => props.entry().result
  const common = () => ({
    'data-entry-id': props.entry().id,
    'data-event-id': props.entry().id,
    'data-kind': RESULT_KINDS[result().type],
    'data-result': result().type,
  })
  const as = <T extends ChatResult['type']>(type: T) =>
    result().type === type ? (result() as Extract<ChatResult, { type: T }>) : undefined
  return (
    <>
      <Show when={as('terminal')}>
        {(terminal) => (
          <TerminalResult terminal={terminal()} live={props.live()} common={common()} />
        )}
      </Show>
      <Show when={as('checkpoint')}>
        {(checkpoint) => (
          // Restore is offered only when the host marked this checkpoint restorable AND gave the
          // canvas a restore operation; otherwise it is a marker that claims nothing about
          // whether it could be returned to.
          <li {...common()}>
            <Checkpoint
              label={checkpoint().name}
              time={utcTime(checkpoint().createdAt)}
              {...(checkpoint().restorable && props.onRestoreCheckpoint
                ? {
                    onRestore: () =>
                      props.onRestoreCheckpoint!({
                        checkpointId: checkpoint().checkpointId,
                        checkpointEventId: props.entry().id,
                      }),
                    consequence: CHECKPOINT_RESTORE_CONSEQUENCE,
                  }
                : {})}
            />
          </li>
        )}
      </Show>
      <Show when={as('test_run')}>
        {(run) => <TestRunResult run={run()} live={props.live()} common={common()} />}
      </Show>
      <Show when={as('failure')}>
        {(failure) => (
          <TraceLine
            {...common()}
            title={failure().name ?? 'Failure'}
            description={failure().message.split('\n')[0]?.slice(0, 120)}
            status="error"
          >
            <FailureBlock failure={failure()} />
          </TraceLine>
        )}
      </Show>
      <Show when={as('files')}>{(files) => <FilesResult files={files()} common={common()} />}</Show>
      <Show when={as('plan')}>
        {(plan) => <PlanResult plan={plan()} live={props.live()} common={common()} />}
      </Show>
      <Show when={as('task')}>
        {(task) => <TaskResult task={task()} live={props.live()} common={common()} />}
      </Show>
    </>
  )
}
