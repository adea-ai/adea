// Bounded, fixed-argv, read-only command runner for the machine-wide resource
// inventory (spec "Machine-wide inventory and foreign stop"). Every
// observation the inventory makes goes through one of these: the argv is a
// fixed array (never a shell string), the child is killed when it exceeds the
// timeout or the output cap, and a killed or failed run reports that fact so
// the caller can leave its field absent instead of reporting empty truth.

export const CAPPED_COMMAND_TIMEOUT_MS = 5_000
export const CAPPED_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024

export type CappedCommandResult = Readonly<{
  exitCode: number | null
  stdout: string
  /** The child exceeded the timeout and was killed; stdout is partial. */
  timedOut: boolean
  /** The child exceeded the output cap and was killed; stdout is partial. */
  truncated: boolean
  /** The executable could not be started at all. */
  spawnFailed: boolean
}>

export type CappedCommandRunner = (argv: readonly string[]) => Promise<CappedCommandResult>

/** A complete, trustworthy result: exited zero inside both budgets. */
export function completed(result: CappedCommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.truncated && !result.spawnFailed
}

export function createCappedCommandRunner(
  options: { timeoutMs?: number; maxOutputBytes?: number } = {}
): CappedCommandRunner {
  const timeoutMs = options.timeoutMs ?? CAPPED_COMMAND_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? CAPPED_COMMAND_MAX_OUTPUT_BYTES
  return async (argv) => {
    if (argv.length === 0) throw new Error('capped command requires an executable')
    let child: ReturnType<typeof Bun.spawn>
    try {
      child = Bun.spawn([...argv], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    } catch {
      return { exitCode: null, stdout: '', timedOut: false, truncated: false, spawnFailed: true }
    }
    let timedOut = false
    let truncated = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const chunks: Uint8Array[] = []
    let received = 0
    try {
      const stream = child.stdout as ReadableStream<Uint8Array>
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > maxOutputBytes) {
          truncated = true
          child.kill('SIGKILL')
          await reader.cancel().catch(() => undefined)
          break
        }
        chunks.push(value)
      }
    } catch {
      // A read failure after a kill is expected; the flags carry the verdict.
    }
    const exitCode = await child.exited.catch(() => null)
    clearTimeout(timer)
    const stdout = new TextDecoder().decode(Buffer.concat(chunks))
    return { exitCode, stdout, timedOut, truncated, spawnFailed: false }
  }
}
