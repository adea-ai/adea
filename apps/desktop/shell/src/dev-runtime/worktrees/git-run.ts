// Bounded, argv-only git execution for the worktree service.
//
// Every invocation is an argv array (never shell text) with a fixed minimal
// environment: `LC_ALL=C` for parseable output, `GIT_TERMINAL_PROMPT=0` so a
// credential problem fails typed instead of hanging the pipeline, and
// `GIT_OPTIONAL_LOCKS=0` so read paths never take the index lock. Time and
// output budgets are enforced by the runner; the default child limits follow
// the Dev Runtime limits registry (60 seconds and 10 MiB per git child).
import { WorktreeError, type WorktreeErrorCode } from './errors'

export type GitRunOptions = Readonly<{
  cwd?: string
  timeoutMs?: number
  maxOutputBytes?: number
  /** Map a non-zero exit to a typed error; return undefined to use the default mapping. */
  classify?: (result: { exitCode: number; stderr: string }) => WorktreeErrorCode | undefined
  signal?: AbortSignal
}>

export type GitRunResult = Readonly<{
  stdout: string
  stderr: string
  exitCode: number
}>

export const GIT_CHILD_TIMEOUT_MS = 60_000
export const GIT_CHILD_MAX_OUTPUT_BYTES = 10 * 1024 * 1024

export function gitChildEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME ?? '/',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  }
}

function classifyGitFailure(stderr: string): WorktreeErrorCode {
  const text = stderr.toLowerCase()
  if (text.includes('not a git repository')) return 'not_git_repo'
  if (
    text.includes('authentication failed') ||
    text.includes('could not read username') ||
    text.includes('permission denied (publickey') ||
    text.includes('terminal prompts disabled') ||
    (text.includes('403') && text.includes('git-receive-pack'))
  ) {
    return 'auth_required'
  }
  if (
    text.includes('could not resolve host') ||
    text.includes('failed to connect') ||
    text.includes('connection timed out') ||
    text.includes('connection refused') ||
    text.includes('ssl')
  ) {
    return 'remote_unavailable'
  }
  if (
    text.includes('bad revision') ||
    text.includes('unknown revision') ||
    text.includes('ambiguous argument')
  ) {
    return 'base_not_found'
  }
  return 'invalid_state'
}

// NUL can appear in neither a path nor a Git ref, so field boundaries stay
// unambiguous when splitting NUL-delimited machine output.
export const GIT_FIELD_SEPARATOR = '\u0000'

/** Run one bounded git child process. stdout/stderr are decoded as UTF-8 with
 *  replacement (git output is treated as machine text, never shell input). */
export async function runGit(
  args: readonly string[],
  options: GitRunOptions = {}
): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? GIT_CHILD_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? GIT_CHILD_MAX_OUTPUT_BYTES
  const proc = Bun.spawn(['git', ...args], {
    cwd: options.cwd,
    env: gitChildEnv(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      try {
        proc.kill()
      } catch {
        // Already exited.
      }
      reject(new WorktreeError('cancelled', 'git operation was cancelled'))
    }
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
  })

  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // Already exited.
      }
      reject(new WorktreeError('timeout', `git ${args[0]} exceeded ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
  })

  async function readCapped(stream: ReadableStream<Uint8Array>, what: string): Promise<string> {
    const decoder = new TextDecoder('utf-8', { fatal: false })
    let total = 0
    let text = ''
    for await (const chunk of stream) {
      total += chunk.byteLength
      if (total > maxOutputBytes) {
        try {
          proc.kill()
        } catch {
          // Already exited.
        }
        throw new WorktreeError('limit_exceeded', `git ${args[0]} ${what} exceeded output budget`)
      }
      text += decoder.decode(chunk, { stream: true })
    }
    text += decoder.decode()
    return text
  }

  const work = (async (): Promise<GitRunResult> => {
    const [stdout, stderr, exitCode] = await Promise.all([
      readCapped(proc.stdout, 'stdout'),
      readCapped(proc.stderr, 'stderr'),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  })()

  try {
    return await Promise.race([work, aborted, timeout])
  } finally {
    if (onAbort) options.signal?.removeEventListener('abort', onAbort)
  }
}

/** Run one git child process and throw a typed error on a non-zero exit. */
export async function runGitChecked(
  args: readonly string[],
  options: GitRunOptions = {}
): Promise<GitRunResult> {
  const result = await runGit(args, options)
  if (result.exitCode !== 0) {
    const code = options.classify?.({ exitCode: result.exitCode, stderr: result.stderr })
    throw new WorktreeError(code ?? classifyGitFailure(result.stderr), trimmed(result.stderr))
  }
  return result
}

/** `rev-parse` style single-value output. */
export async function gitRevParse(repoPath: string, ref: string): Promise<string> {
  const result = await runGitChecked(['rev-parse', ref], { cwd: repoPath })
  return result.stdout.trim()
}

function trimmed(text: string): string {
  return text.trim().length > 0 ? text.trim().slice(0, 2048) : 'git exited non-zero'
}
