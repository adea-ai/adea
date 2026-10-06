// Child-process guard for the single-process desktop suite (preloaded by
// apps/desktop/bunfig.toml).
//
// `bun test` runs every file on one thread and, at each file boundary, sweeps
// any subprocess the file left behind ("killed N dangling process"). When that
// sweep lands on a child that has exited but whose exit the event loop has not
// processed yet, Bun 1.4 spins forever on the unreaped zombie: the whole run
// hangs and no test timeout can fire. The usual sources are fire-and-forget
// children — every composed dev-runtime boot runs `xcrun simctl`, `adb` and
// `emulator` inventory probes that nothing awaits — and background work that
// spawns after a file's last test.
//
// The guard wraps `Bun.spawn` and makes sure the sweep never has anything to
// do:
// - after every test it waits (bounded) for the children that test started,
//   so short-lived children are exited and reaped before the next test;
// - after every file (an `afterAll` appended to each test module, running
//   after the file's own hooks) it waits for every remaining child, then
//   SIGKILLs and reaps stragglers and fails the file naming them, so a leaked
//   long-lived child is reported instead of racing the sweep.
// A child still running after a test's settle window belongs to a fixture
// that spans tests (a sidecar booted in `beforeAll`); it is carried until the
// file ends, where its owner must already have torn it down.
import { afterAll, afterEach } from 'bun:test'
import { plugin } from 'bun'

/** Upper bound a test's children get to exit before being carried (host
 * inventory probes self-kill at 2 s, so they always settle inside it). */
export const CHILD_SETTLE_MS = 3_000
/** Upper bound a file's remaining children get before they count as leaked. */
export const FILE_SETTLE_MS = 10_000
const REAP_MS = 2_000

type TrackedChild = {
  readonly process: Bun.Subprocess
  readonly argv: string
  /** First test-file frame of the spawning stack, for leak reports. */
  readonly origin: string
  /** Outlived a settle window: owned by a cross-test fixture. */
  carried: boolean
}

const live = new Set<TrackedChild>()

/** Children spawned through `Bun.spawn` whose exit has not been observed. */
export function liveChildren(): readonly {
  pid: number
  argv: string
  origin: string
  carried: boolean
}[] {
  return [...live].map((child) => ({
    pid: child.process.pid,
    argv: child.argv,
    origin: child.origin,
    carried: child.carried,
  }))
}

function describeArgv(args: unknown[]): string {
  const first = args[0]
  const argv = Array.isArray(first)
    ? first
    : ((first as { cmd?: unknown[] } | undefined)?.cmd ?? [])
  return argv.map(String).join(' ').slice(0, 200)
}

function spawnOrigin(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1)
  const frame =
    frames.find((line) => /\/tests\/.*\.test\.ts/.test(line)) ??
    frames.find((line) => !line.includes('child-process-guard')) ??
    ''
  return frame.trim()
}

const GUARD_INSTALLED = Symbol.for('adea.desktop.childProcessGuard')

if (!(Bun.spawn as unknown as Record<symbol, boolean>)[GUARD_INSTALLED]) {
  const spawn = Bun.spawn.bind(Bun) as (...args: unknown[]) => Bun.Subprocess
  const guarded = (...args: unknown[]): Bun.Subprocess => {
    const process = spawn(...args)
    const child: TrackedChild = {
      process,
      argv: describeArgv(args),
      origin: spawnOrigin(),
      carried: false,
    }
    live.add(child)
    const forget = () => live.delete(child)
    process.exited.then(forget, forget)
    return process
  }
  Object.defineProperty(guarded, GUARD_INSTALLED, { value: true })
  Bun.spawn = guarded as unknown as typeof Bun.spawn
}

async function awaitExits(children: readonly TrackedChild[], timeoutMs: number): Promise<void> {
  if (children.length === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled(children.map((child) => child.process.exited)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  if (timer) clearTimeout(timer)
}

/** Waits for every uncarried child to exit; returns how many were carried. */
export async function settleChildren(timeoutMs = CHILD_SETTLE_MS): Promise<number> {
  const pending = [...live].filter((child) => !child.carried)
  await awaitExits(pending, timeoutMs)
  let carried = 0
  for (const child of pending) {
    if (live.has(child)) {
      child.carried = true
      carried += 1
    }
  }
  return carried
}

/**
 * File-end enforcement: waits for every remaining child, then SIGKILLs and
 * reaps the stragglers. Returns the leaked children (empty when clean).
 */
export async function reapFileChildren(
  timeoutMs = FILE_SETTLE_MS
): Promise<readonly { pid: number; argv: string; origin: string }[]> {
  // Children spawned by work still unwinding from the file's last hooks land
  // in `live` on later turns; settle until a pass starts with nothing live.
  const deadline = Date.now() + timeoutMs
  while (live.size > 0 && Date.now() < deadline) {
    await awaitExits([...live], deadline - Date.now())
  }
  const leaked = [...live]
  for (const child of leaked) {
    try {
      child.process.kill('SIGKILL')
    } catch {
      /* already exited */
    }
  }
  await awaitExits(leaked, REAP_MS)
  return leaked.map((child) => ({
    pid: child.process.pid,
    argv: child.argv,
    origin: child.origin,
  }))
}

afterEach(async () => {
  await settleChildren()
}, CHILD_SETTLE_MS + 1_000)

const FILE_END_HOOK = '__adeaDesktopChildProcessFileEnd'

;(globalThis as Record<string, unknown>)[FILE_END_HOOK] = () =>
  afterAll(
    async () => {
      const leaked = await reapFileChildren()
      if (leaked.length > 0) {
        throw new Error(
          `test file leaked ${leaked.length} child process(es) past its own teardown; ` +
            `they were SIGKILLed so the file-boundary sweep cannot hang the suite:\n` +
            leaked
              .map((child) => `  pid ${child.pid}: ${child.argv}\n    ${child.origin}`)
              .join('\n')
        )
      }
    },
    FILE_SETTLE_MS + REAP_MS + 1_000
  )

// Appends the file-end hook to every test module. It is registered after the
// module's own top-level hooks, so it runs after the file's own `afterAll`
// teardown; appending keeps every source line number unchanged.
plugin({
  name: 'adea-desktop-child-process-guard',
  setup(build) {
    build.onLoad({ filter: /\/apps\/desktop\/tests\/.*\.test\.ts$/ }, async (args) => ({
      loader: 'ts',
      contents: `${await Bun.file(args.path).text()}\n;(globalThis as Record<string, () => void>).${FILE_END_HOOK}()\n`,
    }))
  },
})
