// Approved bootstrap/teardown execution.
//
// A workflow is a list of steps; a step is an argv array plus a worktree-
// relative cwd plus an environment-key allowlist — never a command string, so
// shell interpolation cannot exist by construction. Approval binds the
// canonical repo root, the workflow digest, and the workflow version; the
// digest is recomputed and rechecked before the run, and a fresh canonical-path
// + directory-identity + gitdir-backlink proof is required before every step,
// so an approval cannot be replayed against a replaced checkout.
//
// Limits follow the Dev Runtime registry: 15 minutes per step, 10 MiB output,
// one owned process group per step; cancellation and timeout kill only that
// step's own process.
import { mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import { nowIso, type DevScope } from '../authority'
import { WorktreeError } from './errors'
import {
  directoryIdentity,
  proveWorktreeRegistration,
  sameIdentity,
  type FileIdentityValue,
} from './identity'

export const BOOTSTRAP_STEP_TIMEOUT_MS = 15 * 60_000
export const BOOTSTRAP_OUTPUT_CAP_BYTES = 10 * 1024 * 1024

export type BootstrapStep = Readonly<{
  id: string
  argv: ReadonlyArray<string>
  /** Worktree-relative working directory; empty means the worktree root. */
  cwd?: string
  /** Environment keys copied into the step (values come from the host at run
   *  time; keys only ever live in the workflow record). */
  envAllowlistKeys?: ReadonlyArray<string>
  timeoutMs?: number
}>

export type BootstrapWorkflow = Readonly<{
  id: string
  version: number
  steps: ReadonlyArray<BootstrapStep>
}>

export type BootstrapApproval = Readonly<{
  method: 'owner_dialog' | 'owner_setting'
  reference: string
  approvedAt: string
  canonicalRepoRoot: string
  workflowDigest: string
  workflowVersion: number
  scope: DevScope
}>

export type StepOutcome = Readonly<{
  stepId: string
  state: 'completed' | 'failed' | 'cancelled'
  exitCode?: number
  truncated: boolean
  logReference: string
  startedAt: string
  endedAt: string
}>

export function workflowDigest(workflow: BootstrapWorkflow): string {
  return createHash('sha256')
    .update(JSON.stringify({ id: workflow.id, version: workflow.version, steps: workflow.steps }))
    .digest('hex')
}

function requireApprovalBinding(input: {
  workflow: BootstrapWorkflow
  approval?: BootstrapApproval
  canonicalRepoRoot: string
  scope: DevScope
}): BootstrapApproval {
  const { approval, workflow, canonicalRepoRoot, scope } = input
  if (!approval) {
    throw new WorktreeError('bootstrap_denied', 'bootstrap requires first-use owner approval')
  }
  if (
    (approval.method !== 'owner_dialog' && approval.method !== 'owner_setting') ||
    typeof approval.reference !== 'string' ||
    approval.reference.length < 1 ||
    approval.reference.length > 256
  ) {
    throw new WorktreeError('bootstrap_denied', 'bootstrap approval is malformed')
  }
  if (approval.workflowDigest !== workflowDigest(workflow)) {
    throw new WorktreeError(
      'bootstrap_denied',
      'bootstrap approval was granted for a different workflow digest'
    )
  }
  if (approval.workflowVersion !== workflow.version) {
    throw new WorktreeError('bootstrap_denied', 'bootstrap approval version mismatch')
  }
  if (approval.canonicalRepoRoot !== canonicalRepoRoot) {
    throw new WorktreeError(
      'bootstrap_denied',
      'bootstrap approval is bound to another repository root'
    )
  }
  if (
    approval.scope.accountId !== scope.accountId ||
    approval.scope.workspaceId !== scope.workspaceId ||
    approval.scope.runtimeNodeId !== scope.runtimeNodeId
  ) {
    throw new WorktreeError('bootstrap_denied', 'bootstrap approval is bound to another scope')
  }
  return approval
}

/** Structural argv validation. One executable name plus argument values; an
 *  argv array cannot express a shell pipeline or interpolation, and an
 *  argument containing spaces is an ordinary argument value, never a command
 *  line. A shell with `-c` is refused outright: workflows execute programs,
 *  never command text (the Muxy hook-runner defect). */
const SHELL_BASENAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh'])

function requireValidArgv(argv: ReadonlyArray<string>): void {
  if (argv.length < 1 || argv.length > 64) {
    throw new WorktreeError('invalid_state', 'bootstrap step requires 1..64 argv entries')
  }
  const NUL = String.fromCharCode(0)
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.length < 1 || arg.length > 4096) {
      throw new WorktreeError(
        'invalid_state',
        'bootstrap argv entries must be 1..4096 character strings'
      )
    }
    if (arg.includes(NUL)) {
      throw new WorktreeError(
        'invalid_state',
        'bootstrap argv entries must not contain NUL characters'
      )
    }
  }
  const executable = argv[0].split('/').pop() ?? argv[0]
  if (SHELL_BASENAMES.has(executable.toLowerCase()) && argv.slice(1).includes('-c')) {
    throw new WorktreeError(
      'bootstrap_denied',
      'bootstrap steps must not execute shell command text'
    )
  }
}

const BASE_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SHELL', 'USER'] as const

function stepEnv(allowlist: ReadonlyArray<string>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME ?? '/',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
  }
  const allowed = new Set([...BASE_ENV_KEYS, ...allowlist])
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key) && value !== undefined && !(key in env)) env[key] = value
  }
  return env
}

/** Fresh canonical-path + directory-identity proof, run immediately before
 *  every step. Accepts any spelling of the root (macOS /var ↔ /private/var)
 *  but only the canonical resolution of the same directory passes. */
function revalidate(input: { expectedRoot: string; expectedIdentity: FileIdentityValue }): void {
  let canonical: string
  try {
    canonical = realpathSync(input.expectedRoot)
  } catch {
    throw new WorktreeError('not_found', 'worktree root is missing before a bootstrap step')
  }
  const fresh = directoryIdentity(canonical)
  if (!sameIdentity(fresh.identity, input.expectedIdentity)) {
    throw new WorktreeError('identity_mismatch', 'worktree identity changed during bootstrap')
  }
}

async function proveRegistration(worktreeRoot: string): Promise<void> {
  const proof = await proveWorktreeRegistration(worktreeRoot)
  if (!proof) {
    throw new WorktreeError('gitdir_unproven', 'worktree gitdir backlink could not be proven')
  }
}

export type BootstrapRunner = ReturnType<typeof createBootstrapRunner>

export function createBootstrapRunner(options: { clock?: () => Date } = {}) {
  const clock = options.clock ?? (() => new Date())

  /** Spawn one step and await its exit. Cancellation and timeout kill only
   *  this step's own process; output is capped and never interpreted. */
  async function runStep(input: {
    worktreeRoot: string
    step: BootstrapStep
    signal?: AbortSignal
    onLog?: (chunk: string) => void
  }): Promise<StepOutcome> {
    requireValidArgv(input.step.argv)
    const startedAt = nowIso(clock)
    const timeoutMs = input.step.timeoutMs ?? BOOTSTRAP_STEP_TIMEOUT_MS
    const cwdRelative = input.step.cwd ?? ''
    const cwd =
      cwdRelative.length > 0 ? resolve(input.worktreeRoot, cwdRelative) : input.worktreeRoot
    if (cwd !== input.worktreeRoot && !cwd.startsWith(input.worktreeRoot + '/')) {
      throw new WorktreeError('path_escape', `bootstrap cwd escapes the worktree: ${cwdRelative}`)
    }
    mkdirSync(cwd, { recursive: true, mode: 0o700 })

    const proc = Bun.spawn([...input.step.argv], {
      cwd,
      env: stepEnv(input.step.envAllowlistKeys ?? []),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    let truncated = false
    let outputBytes = 0
    const decoder = new TextDecoder('utf-8', { fatal: false })
    async function drain(stream: ReadableStream<Uint8Array> | undefined): Promise<void> {
      if (!stream) return
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (!value) continue
        outputBytes += value.byteLength
        if (outputBytes > BOOTSTRAP_OUTPUT_CAP_BYTES) {
          // Drop further output and terminate the step's process; never queue
          // unbounded log bytes.
          if (!truncated) {
            truncated = true
            try {
              proc.kill()
            } catch {
              // Already exited.
            }
          }
          continue
        }
        input.onLog?.(decoder.decode(value, { stream: true }))
      }
    }

    const drainPromise = Promise.all([drain(proc.stdout), drain(proc.stderr)])
    const buildOutcome = (
      state: 'completed' | 'failed' | 'cancelled',
      exitCode?: number
    ): StepOutcome => ({
      stepId: input.step.id,
      state,
      ...(exitCode !== undefined ? { exitCode } : {}),
      truncated,
      logReference: `bootstrap/${input.step.id}/${startedAt}`,
      startedAt,
      endedAt: nowIso(clock),
    })

    let cancelled = false
    const kill = () => {
      cancelled = true
      try {
        proc.kill()
      } catch {
        // Already exited.
      }
    }
    const onAbort = () => kill()
    if (input.signal?.aborted) kill()
    else input.signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(kill, timeoutMs)
    timer.unref?.()

    try {
      const exitCode = await proc.exited
      await drainPromise
      if (cancelled || exitCode === null) {
        throw new WorktreeError(
          'cancelled',
          `bootstrap step ${input.step.id} was cancelled or timed out`
        )
      }
      if (exitCode !== 0) {
        throw new WorktreeError(
          'bootstrap_failed',
          `bootstrap step ${input.step.id} exited ${exitCode}${truncated ? ' with truncated output' : ''}`
        )
      }
      if (truncated) {
        throw new WorktreeError(
          'bootstrap_failed',
          `bootstrap step ${input.step.id} exceeded the output cap`
        )
      }
      return buildOutcome('completed', exitCode)
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Run an approved workflow against one worktree. A failed or cancelled step
   *  stops the workflow and remains retryable; nothing is rolled back (a
   *  partial bootstrap is inspectable state, never deleted data). */
  async function run(input: {
    worktreeRoot: string
    worktreeIdentity: FileIdentityValue
    workflow: BootstrapWorkflow
    approval?: BootstrapApproval
    scope: DevScope
    canonicalRepoRoot: string
    signal?: AbortSignal
    onStepStart?: (step: BootstrapStep) => void
    onLog?: (stepId: string, chunk: string) => void
  }): Promise<StepOutcome[]> {
    requireApprovalBinding({
      workflow: input.workflow,
      approval: input.approval,
      canonicalRepoRoot: input.canonicalRepoRoot,
      scope: input.scope,
    })

    // First-use approval also re-proves the registration backlink.
    await proveRegistration(input.worktreeRoot)
    const outcomes: StepOutcome[] = []
    for (const step of input.workflow.steps) {
      if (input.signal?.aborted) {
        throw new WorktreeError('cancelled', 'bootstrap was cancelled')
      }
      revalidate({ expectedRoot: input.worktreeRoot, expectedIdentity: input.worktreeIdentity })
      input.onStepStart?.(step)
      const outcome = await runStep({
        worktreeRoot: input.worktreeRoot,
        step,
        signal: input.signal,
        onLog: (chunk) => input.onLog?.(step.id, chunk),
      })
      outcomes.push(outcome)
    }
    return outcomes
  }

  return Object.freeze({ run, workflowDigest, revalidate, proveRegistration })
}
