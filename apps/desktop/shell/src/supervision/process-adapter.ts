// The real (packaged-lane) SupervisionAdapter for macOS: turns the
// supervision engine's deterministic seam into actual process side effects —
// spawn, observe, signal. `supervisor.ts` keeps every decision on the seam so
// restart policy and PID-reuse races stay unit-testable; this adapter is the
// only place real OS state enters (packaged smoke lane, M10 #185/#34).
//
// Identity observations use `ps` (the same source the terminal sidecar's
// self-recorded start identity uses):
// - `lstart=` — process start time; a reused PID gets a new start identity.
//   Resolution is one second, which is the same fidelity the sidecar records;
//   the durable launch record plus generation fencing bound any same-second
//   same-binary reuse residual.
// - `comm=` — the executable path; a swapped artifact at the same start
//   identity breaks the ownership proof.
// - `pgid=` — observable process group; joins the ownership proof when
//   present. This adapter does not setpgid (no portable setsid on darwin), so
//   the recorded group is the child's real observed group, not a fresh one.
// Every field is validated against its expected row shape (macOS ps can
// intermittently print header lines) and an unparseable observation fails
// closed to `null` — an identity is never guessed.
//
// No secrets, paths beyond the resolved command, or output content ever enter
// the audit trail: the adapter returns identity facts only.
import type { ComponentSpec } from './component-manifest'
import type { ProcessIdentity } from './records'
import type { CurrentProcessIdentity, SupervisionAdapter } from './supervisor'

/** What the packaging lane resolves for one component: the exact argv to
 *  launch plus optional environment/cwd. The production manifest lane owns
 *  install-location resolution; this type is the seam the smoke and the
 *  packaged lane both fill. */
export type ComponentCommand = {
  argv: string[]
  env?: Record<string, string>
  cwd?: string
}

const PS_IDENTITY_ATTEMPTS = 20
const PS_IDENTITY_RETRY_MS = 50

/** macOS `ps` start-time shape ("Sat Sep 19 16:30:31 2026"; single-digit days
 *  are space-padded). macOS ps intermittently emits a header line ("STARTED
 *  PPID PGID ...") above the data row even with `=`-suppressed names, so a
 *  raw first line must never be trusted: only a row matching this shape — or
 *  numeric ppid/pgid below — counts as an observation, and anything else
 *  fails closed (unobservable). */
const LSTART_PATTERN = /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/

/** The last non-empty ps line whose leading columns are real data rows:
 *  header lines fail the shape check and are skipped. */
function lastDataRow(stdout: string, valid: (tokens: string[]) => boolean): string | null {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const tokens = lines[index]?.trim().split(/\s+/) ?? []
    if (valid(tokens)) return lines[index] ?? null
  }
  return null
}

/** Observe the OS identity of `pid`, or null when nothing lives there (or the
 *  observation cannot be parsed — never guess an identity). */
export function observeIdentity(pid: number): CurrentProcessIdentity | null {
  const started = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)])
  const startLine = lastDataRow(started.stdout.toString(), (tokens) => {
    const joined = tokens.join(' ')
    return LSTART_PATTERN.test(joined)
  })
  if (!startLine) return null
  const rest = Bun.spawnSync(['ps', '-o', 'ppid=,pgid=,comm=', '-p', String(pid)])
  const restLine = lastDataRow(rest.stdout.toString(), (tokens) => {
    return tokens.length >= 3 && /^\d+$/.test(tokens[0] ?? '') && /^\d+$/.test(tokens[1] ?? '')
  })
  if (!restLine) return null
  const tokens = restLine.trim().split(/\s+/)
  const pgid = tokens[1] ?? ''
  const comm = tokens.slice(2).join(' ')
  if (!pgid || !comm) return null
  return {
    pid,
    pidStartIdentity: startLine.trim(),
    executableIdentity: comm,
    processGroup: pgid,
  }
}

export function createProcessAdapter(
  commands: Record<string, ComponentCommand>
): SupervisionAdapter {
  return {
    async spawn(spec: ComponentSpec) {
      const command = commands[spec.id]
      if (!command) throw new Error(`no packaged command registered for component ${spec.id}`)
      const child = Bun.spawn(command.argv, {
        env: command.env ? { ...process.env, ...command.env } : process.env,
        cwd: command.cwd,
        stdout: 'ignore',
        stderr: 'ignore',
      })
      // The child may not have exec'd when the first ps lands; retry briefly
      // so the launch record always carries an observed (never assumed)
      // identity. Failing that, the spawn is torn down and reported failed.
      let identity: CurrentProcessIdentity | null = null
      for (let attempt = 0; attempt < PS_IDENTITY_ATTEMPTS; attempt += 1) {
        identity = observeIdentity(child.pid)
        if (identity) break
        await new Promise<void>((resolve) => setTimeout(resolve, PS_IDENTITY_RETRY_MS))
      }
      if (!identity) {
        child.kill(9)
        throw new Error(`spawned component ${spec.id} was never observable at pid ${child.pid}`)
      }
      return {
        identity: {
          pid: identity.pid,
          pidStartIdentity: identity.pidStartIdentity,
          executableIdentity: identity.executableIdentity,
        },
        processGroup: identity.processGroup ?? `pid-${identity.pid}`,
      }
    },

    async currentIdentity(pid: number) {
      return observeIdentity(pid)
    },

    async probe(_spec: ComponentSpec, identity: ProcessIdentity) {
      return observeIdentity(identity.pid) ? 'responsive' : 'unresponsive'
    },

    async signalIdentity(identity: ProcessIdentity, signalName) {
      try {
        process.kill(identity.pid, signalName)
      } catch (error) {
        // The supervisor rechecks the ownership proof immediately before the
        // signal; if the process still died inside that residual window,
        // ESRCH is the OS confirming the exit the observation loop is about
        // to see. Anything else (EPERM, for instance) surfaces.
        if ((error as { code?: string }).code === 'ESRCH') return
        throw error
      }
    },
  }
}
