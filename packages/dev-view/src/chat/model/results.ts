// Structured results a producer observed and the chat may draw as such: terminal
// output, test runs, failures with stack frames, changed files, plans and tasks.
//
// An event becomes a result only after the whole event passed the wire gate
// (`decodeRuntimeEvent`: native, ACP or owned-hook source, authoritative
// confidence, schema, bounds). The host's log admits a versioned activity payload
// only from a producer that owns that kind, so a payload that merely looks like one
// stays a plain line. Every string is redacted and bounded for display here, and
// nothing is computed or inferred: a count, a status and a completeness claim are
// drawn only when the producer sent it.
import type { RuntimeActivityPayloads } from '@adea-ai/types/dev-runtime'

/** Redact and bound one string for display; `layout` keeps line breaks and tabs. */
export type ResultRedactor = (text: string, limit: number, layout?: boolean) => string

export type ChatResultStatus =
  | 'unknown'
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export type ChatWorkStatus =
  | 'unknown'
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type ChatResultFailure = Readonly<{
  failureId: string
  message: string
  name?: string
  testId?: string
  frames: readonly Readonly<{
    label: string
    line?: number
    column?: number
    native?: boolean
  }>[]
  raw?: string
}>

export type ChatWorkItem = Readonly<{
  id: string
  title: string
  status: ChatWorkStatus
  description?: string
}>

export type ChatResultCounts = Readonly<{
  total?: number
  passed?: number
  failed?: number
  skipped?: number
  pending?: number
  durationMs?: number
}>

export type ChatTerminalResult = Readonly<{
  type: 'terminal'
  terminalId: string
  commandId: string
  command?: string
  phase: 'started' | 'output' | 'finished'
  status: 'unknown' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  /** The redacted start of the output; what follows the display bound is not kept. */
  text: string
  /** Later output exists that the display bound does not show. */
  cut: boolean
  exitCode?: number
  durationMs?: number
  /** Which streams the text came from; both `stdout` and `stderr` mean it is interleaved. */
  streams: readonly ('stdout' | 'stderr' | 'combined')[]
}>

export type ChatTestRunResult = Readonly<{
  type: 'test_run'
  testRunId: string
  status: ChatResultStatus
  summary?: ChatResultCounts
  suites: readonly Readonly<{
    suiteId: string
    name: string
    status: ChatResultStatus
    durationMs?: number
  }>[]
  tests: readonly Readonly<{
    testId: string
    name: string
    status: ChatResultStatus
    suiteId?: string
    durationMs?: number
  }>[]
  failures: readonly ChatResultFailure[]
  complete?: boolean
}>

export type ChatFailureResult = Readonly<{ type: 'failure' }> & ChatResultFailure

export type ChatFilesResult = Readonly<{
  type: 'files'
  changeSetId: string
  files: readonly Readonly<{
    path: string
    change: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked'
    previousPath?: string
    additions?: number
    deletions?: number
  }>[]
  complete?: boolean
  summary?: Readonly<{ files?: number; additions?: number; deletions?: number }>
}>

export type ChatPlanResult = Readonly<{
  type: 'plan'
  planId: string
  status: ChatWorkStatus
  title?: string
  items: readonly ChatWorkItem[]
  complete?: boolean
}>

export type ChatTaskResult = Readonly<{
  type: 'task'
  taskId: string
  title: string
  status: ChatWorkStatus
  description?: string
  todos: readonly ChatWorkItem[]
}>

export type ChatResult =
  | ChatTerminalResult
  | ChatTestRunResult
  | ChatFailureResult
  | ChatFilesResult
  | ChatPlanResult
  | ChatTaskResult

/** The kind of identity a result folds on, or none: a failure is a fact, not a snapshot. */
export function resultIdentity(result: ChatResult): string | undefined {
  switch (result.type) {
    case 'terminal':
      return JSON.stringify([result.type, result.terminalId, result.commandId])
    case 'test_run':
      return JSON.stringify([result.type, result.testRunId])
    case 'files':
      return JSON.stringify([result.type, result.changeSetId])
    case 'plan':
      return JSON.stringify([result.type, result.planId])
    case 'task':
      return JSON.stringify([result.type, result.taskId])
    case 'failure':
      return undefined
  }
}

const TERMINAL_RESULT = new Set<string>(['passed', 'failed', 'skipped', 'cancelled'])
const TERMINAL_WORK = new Set<string>(['completed', 'failed', 'cancelled'])

/** A snapshot that can no longer be replaced: the producer said it ended. */
export function resultSettled(result: ChatResult): boolean {
  switch (result.type) {
    case 'terminal':
      return result.phase === 'finished'
    case 'test_run':
      return TERMINAL_RESULT.has(result.status) || result.complete === true
    case 'files':
      return result.complete === true
    case 'plan':
      return TERMINAL_WORK.has(result.status) || result.complete === true
    case 'task':
      return TERMINAL_WORK.has(result.status)
    case 'failure':
      return true
  }
}

export const TERMINAL_TEXT_LIMIT = 16_384
const MESSAGE_LIMIT = 2_048
const NAME_LIMIT = 256
const PATH_LIMIT = 512
const DESCRIPTION_LIMIT = 1_024
const RAW_STACK_LIMIT = 8_192

const definite = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T

function failureOf(
  record: {
    failureId: string
    message: string
    name?: string
    testId?: string
    stack?: {
      frames: readonly {
        functionName?: string
        path?: string
        url?: string
        line?: number
        column?: number
        native?: boolean
      }[]
      raw?: string
    }
  },
  redact: ResultRedactor
): ChatResultFailure {
  return definite({
    failureId: record.failureId,
    message: redact(record.message, MESSAGE_LIMIT, true),
    name: record.name === undefined ? undefined : redact(record.name, NAME_LIMIT),
    testId: record.testId,
    frames: (record.stack?.frames ?? []).map((frame) =>
      definite({
        label: redact(
          [
            frame.functionName,
            frame.path ?? frame.url,
            frame.native === true && frame.path === undefined && frame.url === undefined
              ? '[native]'
              : undefined,
          ]
            .filter((part) => part !== undefined)
            .join(' ') || '[native]',
          PATH_LIMIT
        ),
        line: frame.line,
        column: frame.column,
        native: frame.native,
      })
    ),
    raw:
      record.stack?.raw === undefined ? undefined : redact(record.stack.raw, RAW_STACK_LIMIT, true),
  })
}

function workItems(
  items: readonly { id: string; title: string; status: ChatWorkStatus; description?: string }[],
  redact: ResultRedactor
): readonly ChatWorkItem[] {
  return items.map((item) =>
    definite({
      id: item.id,
      title: redact(item.title, NAME_LIMIT),
      status: item.status,
      description:
        item.description === undefined
          ? undefined
          : redact(item.description, DESCRIPTION_LIMIT, true),
    })
  )
}

/** The result a gate-accepted activity event carries, bounded and redacted for display. */
export function projectActivityResult(
  kind: string,
  payload: unknown,
  redact: ResultRedactor
): ChatResult | undefined {
  switch (kind) {
    case 'terminal.output': {
      const p = payload as RuntimeActivityPayloads['terminal.output']
      const text = redact(p.text ?? '', TERMINAL_TEXT_LIMIT, true)
      return definite({
        type: 'terminal' as const,
        terminalId: p.terminalId,
        commandId: p.commandId,
        command: p.command === undefined ? undefined : redact(p.command, MESSAGE_LIMIT),
        phase: p.phase,
        status: p.status,
        text,
        cut: false,
        streams: [p.stream],
        exitCode: p.exitCode,
        durationMs: p.durationMs,
      })
    }
    case 'test_run.observed': {
      const p = payload as RuntimeActivityPayloads['test_run.observed']
      return definite({
        type: 'test_run' as const,
        testRunId: p.testRunId,
        status: p.status,
        summary: p.summary,
        suites: (p.suites ?? []).map((suite) =>
          definite({
            suiteId: suite.suiteId,
            name: redact(suite.name, NAME_LIMIT),
            status: suite.status,
            durationMs: suite.durationMs,
          })
        ),
        tests: (p.tests ?? []).map((test) =>
          definite({
            testId: test.testId,
            name: redact(test.name, NAME_LIMIT),
            status: test.status,
            suiteId: test.suiteId,
            durationMs: test.durationMs,
          })
        ),
        failures: (p.failures ?? []).map((failure) => failureOf(failure, redact)),
        complete: p.complete,
      })
    }
    case 'failure.observed': {
      const p = payload as RuntimeActivityPayloads['failure.observed']
      return { type: 'failure', ...failureOf(p, redact) }
    }
    case 'files.changed': {
      const p = payload as RuntimeActivityPayloads['files.changed']
      return definite({
        type: 'files' as const,
        changeSetId: p.changeSetId,
        files: p.files.map((file) =>
          definite({
            path: redact(file.path, PATH_LIMIT),
            change: file.change,
            previousPath:
              file.previousPath === undefined ? undefined : redact(file.previousPath, PATH_LIMIT),
            additions: file.additions,
            deletions: file.deletions,
          })
        ),
        complete: p.complete,
        summary: p.summary,
      })
    }
    case 'plan.observed': {
      const p = payload as RuntimeActivityPayloads['plan.observed']
      return definite({
        type: 'plan' as const,
        planId: p.planId,
        status: p.status,
        title: p.title === undefined ? undefined : redact(p.title, NAME_LIMIT),
        items: workItems(p.items, redact),
        complete: p.complete,
      })
    }
    case 'task.observed': {
      const p = payload as RuntimeActivityPayloads['task.observed']
      return definite({
        type: 'task' as const,
        taskId: p.taskId,
        title: redact(p.title, NAME_LIMIT),
        status: p.status,
        description:
          p.description === undefined ? undefined : redact(p.description, DESCRIPTION_LIMIT, true),
        todos: workItems(p.todos ?? [], redact),
      })
    }
    default:
      return undefined
  }
}
