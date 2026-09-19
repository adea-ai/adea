// The supervised-component stand-in for the packaged supervision smoke
// (M10 #185). This is a real OS process on the packaged app path: it behaves
// like a bundled component for each supervision rule the smoke proves.
//
// Usage: supervision-smoke-child.ts --signal-log <path> [--stubborn]
//
// - default (graceful component): exits 0 on SIGTERM, like a well-behaved
//   daemon flushing and shutting down;
// - --stubborn: receives SIGTERM, appends the receipt to the signal log, and
//   IGNORES it — only SIGKILL ends it, proving the supervisor's bounded
//   escalation against a process that refuses the graceful window.
//
// The signal log is the child's own testimony that a signal was DELIVERED
// (the supervisor's audit ring alone cannot prove delivery to a process that
// ignores it). The `ready` line marks that the handlers are installed; a
// signal arriving before it would hit the default disposition and kill the
// child without testimony, which would prove nothing about supervision. No
// secrets, no network, no PTY.
import { appendFileSync } from 'node:fs'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const signalLog = argValue('--signal-log')
const stubborn = process.argv.includes('--stubborn')

function record(signal: string): void {
  if (!signalLog) return
  try {
    appendFileSync(signalLog, `${signal}\n`, { mode: 0o600 })
  } catch {
    // Testimony is best-effort; the supervisor observes exits itself.
  }
}

process.on('SIGTERM', () => {
  record('SIGTERM')
  if (!stubborn) process.exit(0)
})
process.on('SIGINT', () => {
  record('SIGINT')
  if (!stubborn) process.exit(0)
})

record('ready')

// Keep the event loop alive until supervised. This interval is the only open
// handle, so it must NOT be unref'd — an unref'd loop exits the child the
// instant it finishes booting.
setInterval(() => {}, 30_000)
