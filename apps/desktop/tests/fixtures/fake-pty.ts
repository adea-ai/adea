// Deterministic in-memory PTY fixture for terminal host tests (Dev Runtime
// spec, "Test contract": fake PTY fixtures). It mirrors the real Bun
// adapter's byte contract so manager/service tests never decode strings.
import type {
  PtyAdapter,
  PtyExitEvent,
  PtyProcess,
  PtySpawnInput,
} from '../../shell/src/dev-runtime/terminal/pty-adapter'

export class FakePtyProcess implements PtyProcess {
  readonly pid: number
  readonly written: Uint8Array[] = []
  readonly resizes: Array<{ cols: number; rows: number }> = []
  readonly kills: string[] = []
  private readonly dataListeners = new Set<(data: Uint8Array) => void>()
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>()
  private exited = false

  constructor(pid: number) {
    this.pid = pid
  }

  /** Test hook: emit exact source bytes (any fragmentation, any validity). */
  emit(data: Uint8Array): void {
    if (this.exited) return
    for (const listener of [...this.dataListeners]) listener(data)
  }

  /** Test hook: simulate process exit with a code/signal. */
  exit(exitCode: number, signal: number | null = null): void {
    if (this.exited) return
    this.exited = true
    for (const listener of [...this.exitListeners]) listener({ exitCode, signal })
  }

  /** When true, signals are recorded but do not end the process (an unresponsive child). */
  ignoreSignals = false

  write(data: Uint8Array): void {
    this.written.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows })
  }

  kill(signal: 'SIGTERM' | 'SIGKILL' | 'SIGHUP' = 'SIGTERM'): void {
    this.kills.push(signal)
    // SIGKILL cannot be caught or ignored; everything else can.
    if (!this.ignoreSignals || signal === 'SIGKILL') this.exit(143, signal === 'SIGKILL' ? 9 : 15)
  }

  onData(callback: (data: Uint8Array) => void): () => void {
    this.dataListeners.add(callback)
    return () => this.dataListeners.delete(callback)
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }
}

export function createFakePtyAdapter(platform: NodeJS.Platform = 'darwin'): {
  adapter: PtyAdapter
  processes: FakePtyProcess[]
  spawnInputs: PtySpawnInput[]
  failNextSpawnWith: (code: 'spawn_failed' | 'unsupported_capability', message: string) => void
} {
  const processes: FakePtyProcess[] = []
  const spawnInputs: PtySpawnInput[] = []
  let failure: { code: 'spawn_failed' | 'unsupported_capability'; message: string } | null = null
  let nextPid = 4000
  const adapter: PtyAdapter = {
    capability:
      platform === 'win32'
        ? { supported: false, platform, reason: 'pty_requires_posix_process_groups' }
        : { supported: true },
    spawn(input) {
      if (failure) {
        const result = { ok: false as const, code: failure.code, message: failure.message }
        failure = null
        return result
      }
      spawnInputs.push(input)
      const process = new FakePtyProcess(nextPid)
      nextPid += 1
      processes.push(process)
      return { ok: true, value: process }
    },
  }
  return {
    adapter,
    processes,
    spawnInputs,
    failNextSpawnWith: (code, message) => {
      failure = { code, message }
    },
  }
}
