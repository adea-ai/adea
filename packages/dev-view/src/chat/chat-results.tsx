import { For, Show, type JSX } from 'solid-js'
import { TraceDetail, TraceLine, type TraceStatus } from '@adea-ai/ui/components/ui/trace'
import { formatDuration } from '@adea-ai/ui/components/composites/reasoning'
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
function testSuites(run: ChatTestRunResult): readonly TestSuite[] {
  const failures = new Map(run.failures.map((failure) => [failure.failureId, failure]))
  const attach = (test: ChatTestRunResult['tests'][number], failureIds?: readonly string[]) => {
    const linked = (failureIds ?? [])
      .map((id) => failures.get(id))
      .filter((failure): failure is ChatResultFailure => failure !== undefined)
    return {
      id: test.testId,
      name: test.name,
      ...(TEST_STATUS[test.status] !== undefined ? { status: TEST_STATUS[test.status] } : {}),
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
  return (
    <TraceLine
      {...props.common}
      title="Test run"
      status={runStatus(props.run.status, props.live)}
      meta={stoppedWord(props.run.status, props.live)}
    >
      <TestResults
        suites={testSuites(props.run)}
        summary={props.run.summary}
        running={props.live && props.run.status === 'running'}
      />
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
  const total = () => props.files.summary?.files ?? props.files.files.length
  const description = () => {
    const summary = props.files.summary
    const lines =
      summary?.additions !== undefined || summary?.deletions !== undefined
        ? ` · +${summary?.additions ?? 0} −${summary?.deletions ?? 0}`
        : ''
    return `${total()} ${total() === 1 ? 'file' : 'files'}${lines}`
  }
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
      <Show when={props.files.complete === false || props.files.files.length < total()}>
        <TraceDetail>Only part of the change set is listed.</TraceDetail>
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

function PlanResult(props: {
  plan: ChatPlanResult
  live: boolean
  common: Record<string, string>
}): JSX.Element {
  return (
    <Plan
      {...props.common}
      title={props.plan.title ?? 'Plan'}
      meta={stoppedWord(props.plan.status, props.live)}
      steps={props.plan.items.map((item) => ({
        id: item.id,
        label: item.title,
        ...(item.description !== undefined ? { description: item.description } : {}),
        ...(STEP_STATUS(item.status, props.live) !== undefined
          ? { status: STEP_STATUS(item.status, props.live) }
          : {}),
      }))}
      description={
        props.plan.complete === false ? 'The producer marked this plan incomplete.' : undefined
      }
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
