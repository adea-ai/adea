import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const childScript = resolve(root, 'scripts/disposable-postgres-signal/child.ts')

/** How long the child may take to tear down and terminate. */
const TERMINATION_BOUND_MS = 15_000

/** How long the child may take to report that it is ready. */
const READY_BOUND_MS = 15_000

type ChildOutcome = {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
  readonly containerRemovals: readonly string[]
  readonly materialRemovals: readonly string[]
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

async function waitForFile(path: string, boundMs: number): Promise<boolean> {
  const deadline = Date.now() + boundMs
  for (;;) {
    if (existsSync(path)) return true
    if (Date.now() >= deadline) return false
    await new Promise((done) => setTimeout(done, 25))
  }
}

/**
 * Runs the disposable child, signals it, and collects how it terminated and
 * what its teardown did.
 *
 * The signal reaches this child only. The child is killed outright if it has
 * not terminated within the bound, so a broken teardown fails the test instead
 * of leaving a process behind.
 */
async function interruptChild(
  signal: NodeJS.Signals,
  options: { readonly failRemoval: boolean } = { failRemoval: false }
): Promise<ChildOutcome> {
  const directory = mkdtempSync(join(tmpdir(), 'adea-signal-test-'))
  const containerRemovalLog = join(directory, 'container-removal.log')
  const materialRemovalLog = join(directory, 'material-removal.log')
  const readyPath = join(directory, 'ready')

  const child = spawn(process.execPath, [childScript, directory], {
    env: {
      ...process.env,
      ADEA_SIGNAL_TEST_FAIL_REMOVAL: options.failRemoval ? 'true' : 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once('exit', (code, exitSignal) => done({ code, signal: exitSignal }))
  })

  try {
    const ready = await waitForFile(readyPath, READY_BOUND_MS)
    expect(ready).toBe(true)
    expect(child.pid).toBeDefined()

    // The signal targets this child only.
    child.kill(signal)

    const outcome = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `the child did not terminate within ${TERMINATION_BOUND_MS}ms after ${signal}`
            )
          )
        }, TERMINATION_BOUND_MS)
      }),
    ])

    return {
      code: outcome.code,
      signal: outcome.signal,
      stderr,
      containerRemovals: readLines(containerRemovalLog),
      materialRemovals: readLines(materialRemovalLog),
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('the owned container teardown on an interrupted run', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    test(
      `a ${signal} removes the owned container exactly once and the temporary material`,
      async () => {
        const outcome = await interruptChild(signal)

        expect(outcome.containerRemovals).toEqual(['adea-ci-postgres-owned'])
        expect(outcome.materialRemovals).toEqual(['removed'])
      },
      TERMINATION_BOUND_MS + 10_000
    )

    test(
      `a ${signal} ends the run by the signal, not successfully`,
      async () => {
        const outcome = await interruptChild(signal)

        // The listener is detached before the signal is re-raised, so the default
        // action ends the process: it is terminated by the signal and has no
        // exit code of its own.
        expect(outcome.signal).toBe(signal)
        expect(outcome.code).toBeNull()
        expect(outcome.code).not.toBe(0)
      },
      TERMINATION_BOUND_MS + 10_000
    )
  }

  test(
    'a failed cleanup is reported, does not re-enter, and still ends the run unsuccessfully',
    async () => {
      const outcome = await interruptChild('SIGTERM', { failRemoval: true })

      // The removal was attempted exactly once, so the teardown did not recurse.
      expect(outcome.containerRemovals).toEqual(['adea-ci-postgres-owned'])
      // The temporary material is still removed after a failed container removal.
      expect(outcome.materialRemovals).toEqual(['removed'])
      // The failure is reported rather than thrown out of the signal handler.
      expect(outcome.stderr).toContain('cleanup failure')
      expect(outcome.stderr).toContain('the disposable container removal failed')
      // The interrupted run never ends successfully.
      expect(outcome.signal).toBe('SIGTERM')
      expect(outcome.code).toBeNull()
      expect(outcome.code).not.toBe(0)
    },
    TERMINATION_BOUND_MS + 10_000
  )
})
