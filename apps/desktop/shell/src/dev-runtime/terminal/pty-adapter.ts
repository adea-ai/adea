// The Bun 1.4 PTY adapter (issue #396).
//
// Provenance: adapter shape and spawn lifecycle adapted from t3code
// `apps/server/src/terminal/PtyAdapter.ts` and `BunPtyAdapter.ts`
// (revision 77bca8b2d76a1f42552e5eee7d277fcb1160347a, MIT). The pinned donor
// defects are deliberately not carried over and are covered by tests:
// - t3code decodes output through a streaming TextDecoder and hands listeners
//   a string. Adea's contract is byte-preserving `Uint8Array` chunks end to
//   end; decoding happens incrementally in the renderer only.
// - t3code's spawn races Bun's synchronous `terminal.data` callback against
//   wrapper assignment (`processHandle?.emitData`) and silently drops the
//   bytes that arrive first. Adea buffers that pre-assignment window and
//   flushes it once the wrapper exists.
// - t3code dies on win32 at layer construction. Adea reports the typed
//   `unsupported_capability` error at spawn so capability state stays
//   observable; there is no silent library or shell fallback.
//
// ADR 0008 note: `Bun.spawn`'s `terminal` option is an execution-runtime API
// used inside the shell/sidecar lane; the application build path stays
// Vite/Rolldown (docs/specs/dev-runtime.md, "PTY adapter").
import type { DevErrorCode } from '../../../../../../packages/types/src/dev-runtime'

export type PtyExitEvent = Readonly<{ exitCode: number; signal: number | null }>

export type PtySpawnResult =
  | { ok: true; value: PtyProcess }
  | { ok: false; code: DevErrorCode; message: string }

export interface PtyProcess {
  readonly pid: number
  write(data: Uint8Array): void
  resize(cols: number, rows: number): void
  kill(signal?: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP'): void
  onData(callback: (data: Uint8Array) => void): () => void
  onExit(callback: (event: PtyExitEvent) => void): () => void
}

export interface PtySpawnInput {
  readonly shell: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly env: Record<string, string>
}

export interface PtyAdapter {
  /** Platform capability truth for observability; never selects a fallback. */
  readonly capability:
    | { supported: true }
    | { supported: false; platform: string; reason: 'pty_requires_posix_process_groups' }
  spawn(input: PtySpawnInput): PtySpawnResult
}

const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux'])

class BunPtyProcess implements PtyProcess {
  private readonly dataListeners = new Set<(data: Uint8Array) => void>()
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>()
  private readonly process: Bun.Subprocess
  private didExit = false

  constructor(process: Bun.Subprocess) {
    this.process = process
    void this.process.exited
      .then((exitCode) => {
        this.emitExit({
          exitCode: Number.isInteger(exitCode) ? exitCode : 0,
          signal: typeof this.process.signalCode === 'number' ? this.process.signalCode : null,
        })
      })
      .catch(() => {
        this.emitExit({ exitCode: 1, signal: null })
      })
  }

  get pid(): number {
    return this.process.pid
  }

  write(data: Uint8Array): void {
    if (!this.process.terminal) {
      throw new Error(`Bun PTY write is unavailable for process ${this.pid}`)
    }
    this.process.terminal.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.process.terminal?.resize) {
      throw new Error(`Bun PTY resize is unavailable for process ${this.pid}`)
    }
    this.process.terminal.resize(cols, rows)
  }

  kill(signal?: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP'): void {
    // A forkpty child is its own session/process-group leader, so the negative
    // PID signals the whole owned group; fall back to the child itself if the
    // group signal is refused (e.g. the child already exited).
    if (signal && process.platform !== 'win32') {
      try {
        process.kill(-this.process.pid, signal)
        return
      } catch {
        /* fall through to the direct child kill */
      }
    }
    if (signal) this.process.kill(signal)
    else this.process.kill()
  }

  onData(callback: (data: Uint8Array) => void): () => void {
    this.dataListeners.add(callback)
    return () => {
      this.dataListeners.delete(callback)
    }
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback)
    return () => {
      this.exitListeners.delete(callback)
    }
  }

  /** Forwards the exact source bytes; no decoding, no trimming. */
  emitData(data: Uint8Array): void {
    if (this.didExit || data.byteLength === 0) return
    for (const listener of this.dataListeners) listener(data)
  }

  private emitExit(event: PtyExitEvent): void {
    if (this.didExit) return
    this.didExit = true
    for (const listener of this.exitListeners) listener(event)
  }
}

function unsupportedAdapter(platform: string): PtyAdapter {
  return {
    capability: { supported: false, platform, reason: 'pty_requires_posix_process_groups' },
    spawn() {
      return {
        ok: false,
        code: 'unsupported_capability',
        message: `Adea's Bun PTY terminal has no supported implementation on ${platform}; no fallback was selected`,
      }
    },
  }
}

export function createBunPtyAdapter(platform: NodeJS.Platform = process.platform): PtyAdapter {
  if (!SUPPORTED_PLATFORMS.has(platform)) return unsupportedAdapter(platform)
  return {
    capability: { supported: true },
    spawn(input) {
      // Bun may invoke the data callback synchronously during spawn(), before
      // the wrapper below exists. Those bytes are buffered here and flushed
      // right after assignment; dropping them would corrupt the byte stream.
      const preAssignment: Uint8Array[] = []
      let handle: BunPtyProcess | null = null
      let subprocess: Bun.Subprocess
      try {
        subprocess = Bun.spawn([input.shell, ...input.args], {
          cwd: input.cwd,
          env: input.env,
          terminal: {
            cols: input.cols,
            rows: input.rows,
            data: (_terminal, data) => {
              if (handle) handle.emitData(data)
              else preAssignment.push(data)
            },
          },
        })
      } catch (cause) {
        return {
          ok: false,
          code: 'spawn_failed',
          message: `failed to spawn PTY for ${input.shell}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }
      }
      handle = new BunPtyProcess(subprocess)
      for (const chunk of preAssignment) handle.emitData(chunk)
      return { ok: true, value: handle }
    },
  }
}
