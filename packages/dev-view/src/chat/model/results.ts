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
    functionName?: string
    /** A worktree-relative path or an HTTPS address, as the producer observed it. */
    location?: string
    line?: number
    column?: number
    native?: boolean
  }>[]
  raw?: string
}>

/** The stack as text for the shared StackTrace: the producer's own text, else one line per frame. */
export function stackText(failure: ChatResultFailure): string | undefined {
  if (failure.raw !== undefined) return failure.raw
  if (failure.frames.length === 0) return undefined
  return failure.frames
    .map((frame) => {
      const place =
        frame.location === undefined
          ? frame.native === true
            ? 'native'
            : undefined
          : `${frame.location}${frame.line !== undefined ? `:${frame.line}` : ''}${
              frame.line !== undefined && frame.column !== undefined ? `:${frame.column}` : ''
            }`
      if (frame.functionName !== undefined)
        return place === undefined
          ? `    at ${frame.functionName}`
          : `    at ${frame.functionName} (${place})`
      return `    at ${place ?? '<anonymous>'}`
    })
    .join('\n')
}

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
    failureIds?: readonly string[]
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
  /** The producer's own tally, which may count steps the list does not hold. */
  summary?: Readonly<{
    total?: number
    pending?: number
    inProgress?: number
    completed?: number
    failed?: number
    cancelled?: number
  }>
}>

export type ChatTaskResult = Readonly<{
  type: 'task'
  taskId: string
  title: string
  status: ChatWorkStatus
  description?: string
  todos: readonly ChatWorkItem[]
}>

/**
 * A point the host named. `restorable` is the host's own statement for this checkpoint
 * (`restore.supported`), never a guess: only a marker the host says can be returned to may
 * offer a restore, and even then the host decides when the command is run.
 */
export type ChatCheckpointResult = Readonly<{
  type: 'checkpoint'
  checkpointId: string
  name: string
  createdAt: string
  restorable: boolean
}>

export type ChatResult =
  | ChatCheckpointResult
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
    case 'checkpoint':
      return JSON.stringify([result.type, result.checkpointId])
    case 'failure':
      return undefined
  }
}

const TERMINAL_RESULT = new Set<string>(['passed', 'failed', 'skipped', 'cancelled'])
const TERMINAL_WORK = new Set<string>(['completed', 'failed', 'cancelled'])

/**
 * A snapshot that can no longer be replaced: the producer ended the work. `complete`
 * only says the snapshot lists every item of its collection; it is not an end of the
 * work, so a later snapshot of the same plan, test run or change set still replaces it.
 */
export function resultSettled(result: ChatResult): boolean {
  switch (result.type) {
    case 'terminal':
      return result.phase === 'finished'
    case 'test_run':
      return TERMINAL_RESULT.has(result.status)
    case 'files':
      return false
    case 'plan':
      return TERMINAL_WORK.has(result.status)
    case 'task':
      return TERMINAL_WORK.has(result.status)
    case 'failure':
    case 'checkpoint':
      return true
  }
}

export const TERMINAL_TEXT_LIMIT = 16_384

// Terminal control sequences are removed before redaction, not after: a control
// byte or an escape sequence inserted inside a token would otherwise split it
// from the pattern that recognises a secret, and the display filter would then
// delete the break and show the token whole.
const TERMINAL_CONTROLS =
  // oxlint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

export function stripTerminalControls(text: string): string {
  return text.replace(TERMINAL_CONTROLS, '')
}
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
        functionName:
          frame.functionName === undefined ? undefined : redact(frame.functionName, PATH_LIMIT),
        location:
          frame.path === undefined && frame.url === undefined
            ? undefined
            : redact((frame.path ?? frame.url) as string, PATH_LIMIT),
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
      const text = redact(stripTerminalControls(p.text ?? ''), TERMINAL_TEXT_LIMIT, true)
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
    case 'checkpoint.observed': {
      const p = payload as {
        checkpointId: string
        name: string
        createdAt: string
        restore?: { supported?: boolean }
      }
      return {
        type: 'checkpoint',
        checkpointId: p.checkpointId,
        name: redact(p.name, NAME_LIMIT),
        createdAt: p.createdAt,
        restorable: p.restore?.supported === true,
      }
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
            failureIds: test.failureIds,
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
        summary: p.summary,
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
