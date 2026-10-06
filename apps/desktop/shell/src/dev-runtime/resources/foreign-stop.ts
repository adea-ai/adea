// User-confirmed stop for a process Adea did not launch (spec "Machine-wide
// inventory and foreign stop", threat TM-018).
//
// This path never decides ownership and never runs on its own: the renderer
// shows the plan in an AlertDialog and the user confirms one process at a
// time. The plan binds the observed identity of the row and its child set;
// the commit re-reads every PID immediately before signalling it and sends
// nothing to a PID whose start identity, executable identity, or owner uid
// changed, or that became protected. The first signal is a graceful SIGTERM,
// children first; SIGKILL is sent only when the plan asked for force, only
// after the graceful window, and only after the same re-proof. Foreign stop
// never participates in automatic cleanup, cleanup policies, or worktree
// Complete-and-clean.
import { createHash, randomUUID } from 'node:crypto'

import type {
  DevCommand,
  DevError,
  ForeignStopResult,
  MutationPlan,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { completed, type CappedCommandRunner } from './capped-command'
import {
  normalizeStartIdentity,
  type ForeignMember,
  type MachineInventory,
} from './machine-inventory'

export const FOREIGN_PLAN_TTL_MS = 60_000
export const FOREIGN_GRACEFUL_WINDOW_MS = 10_000
export const FOREIGN_KILL_WINDOW_MS = 2_000
const POLL_INTERVAL_MS = 200

export type LiveIdentity = Readonly<{
  uid: number
  startIdentity: string
  executableIdentity: string
}>

/** Reads one PID's live identity, or `null` when it no longer exists. An
 * observation that could not complete throws: unknown is not "gone". */
export type ObserveLiveIdentity = (pid: number) => Promise<LiveIdentity | null>

export function createLiveIdentityObserver(run: CappedCommandRunner): ObserveLiveIdentity {
  return async (pid) => {
    const result = await run(['ps', '-o', 'uid=,lstart=,comm=', '-p', String(pid)])
    // `ps -p` exits 1 with no output when the PID does not exist.
    if (
      result.exitCode === 1 &&
      result.stdout.trim() === '' &&
      !result.timedOut &&
      !result.truncated
    )
      return null
    if (!completed(result)) throw new Error('process identity could not be observed')
    const match =
      /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(
        result.stdout.trim()
      )
    if (!match) throw new Error('process identity output was not recognized')
    return {
      uid: Number(match[1]),
      startIdentity: normalizeStartIdentity(match[2] as string),
      executableIdentity: (match[3] as string).trim(),
    }
  }
}

export type ForeignSignal = (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void

export function defaultForeignSignal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    // ESRCH: the process exited between re-proof and signal; nothing to do.
    if ((error as { code?: string }).code !== 'ESRCH') throw error
  }
}

type PlanEntry = {
  plan: MutationPlan
  foreignProcessId: string
  generation: number
  root: ForeignMember
  members: readonly ForeignMember[]
  force: boolean
  expiresAt: number
}

function devError(code: DevError['code'], message: string, retryable = false): DevError {
  return { code, retryable, message }
}

function digest(facts: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(facts, Object.keys(facts).toSorted()))
    .digest('hex')
}

function matches(member: ForeignMember, live: LiveIdentity): boolean {
  return (
    live.uid === member.uid &&
    live.startIdentity === member.startIdentity &&
    live.executableIdentity === member.executableIdentity
  )
}

export type ForeignStopAuthorityInput = Readonly<{
  scope: Scope
  inventory: MachineInventory
  observe: ObserveLiveIdentity
  signal?: ForeignSignal
  /** The uid the Adea shell runs as; only its processes are ever signalled. */
  selfUid?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  randomId?: () => string
  gracefulWindowMs?: number
  killWindowMs?: number
  /** Called once per committed stop with secret-free facts only. */
  audit?: (
    event: Readonly<{
      foreignProcessId: string
      attribution: string
      outcome: ForeignStopResult['outcome']
      signalled: number
    }>
  ) => void
}>

export type ForeignStopAuthority = Readonly<{
  plan(command: DevCommand, body: Readonly<Record<string, unknown>>): MutationPlan
  commit(command: DevCommand, body: Readonly<Record<string, unknown>>): Promise<ForeignStopResult>
}>

export function createForeignStopAuthority(input: ForeignStopAuthorityInput): ForeignStopAuthority {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const randomId = input.randomId ?? randomUUID
  const signal = input.signal ?? defaultForeignSignal
  const selfUid = input.selfUid ?? process.getuid?.() ?? -1
  const gracefulWindowMs = input.gracefulWindowMs ?? FOREIGN_GRACEFUL_WINDOW_MS
  const killWindowMs = input.killWindowMs ?? FOREIGN_KILL_WINDOW_MS
  const plans = new Map<string, PlanEntry>()

  function requireBinding(command: DevCommand, foreignProcessId: string): void {
    if (command.resource === undefined)
      throw devError('identity_mismatch', 'operation requires a foreign_process resource binding')
    if (command.resource.kind !== 'foreign_process')
      throw devError('identity_mismatch', 'resource kind must be foreign_process')
    if (command.resource.id !== foreignProcessId)
      throw devError('identity_mismatch', 'resource id does not match the request body')
  }

  /** True when the member may be signalled right now. */
  async function reprove(member: ForeignMember): Promise<'ok' | 'gone' | 'changed'> {
    const live = await input.observe(member.pid)
    if (live === null) return 'gone'
    if (!matches(member, live)) return 'changed'
    if (live.uid !== selfUid) return 'changed'
    if (input.inventory.protection(member) !== 'none') return 'changed'
    return 'ok'
  }

  async function waitForExit(member: ForeignMember, windowMs: number): Promise<boolean> {
    const deadline = now() + windowMs
    for (;;) {
      const live = await input.observe(member.pid)
      if (live === null || !matches(member, live)) return true
      if (now() >= deadline) return false
      await sleep(POLL_INTERVAL_MS)
    }
  }

  return Object.freeze({
    plan(command, body) {
      const foreignProcessId = body.foreignProcessId as string
      requireBinding(command, foreignProcessId)
      const observation = input.inventory.lookup(foreignProcessId)
      if (!observation)
        throw devError('not_found', 'this process is not in the latest machine observation')
      const { record } = observation
      if (command.resource!.generation !== record.observationGeneration)
        throw devError('stale_generation', 'the process observation generation has changed')
      if (!record.stoppable || record.protection !== 'none')
        throw devError('ownership_unproven', 'this process is protected and cannot be stopped')
      const force = body.force === true
      const reason = body.reason as string
      const members = observation.members
      const planDigest = digest({
        executableIdentity: observation.root.executableIdentity,
        force,
        foreignProcessId,
        generation: record.observationGeneration,
        members: members.map((member) => `${member.pid}:${member.startIdentity}`),
        pid: observation.root.pid,
        reason,
        startIdentity: observation.root.startIdentity,
        uid: observation.root.uid,
      })
      const plan: MutationPlan = {
        id: randomId(),
        operation: 'dev.resources.foreignStopCommit',
        scope: input.scope,
        resource: {
          kind: 'foreign_process',
          id: foreignProcessId,
          generation: record.observationGeneration,
        },
        factVersions: { identityDigest: planDigest },
        steps: [...members, observation.root].map((member, index) => ({
          id: `signal-${index}`,
          kind: 'stop_foreign_process',
          targetId: String(member.pid),
          dependsOn: [],
        })),
        blockers: [],
        requiredApprovalIds: [],
        digest: planDigest,
        expiresAt: new Date(now() + FOREIGN_PLAN_TTL_MS).toISOString(),
      }
      plans.set(plan.id, {
        plan,
        foreignProcessId,
        generation: record.observationGeneration,
        root: observation.root,
        members,
        force,
        expiresAt: now() + FOREIGN_PLAN_TTL_MS,
      })
      return plan
    },

    async commit(command, body) {
      if (command.resource === undefined)
        throw devError('identity_mismatch', 'operation requires a foreign_process resource binding')
      const entry = plans.get(body.planId as string)
      if (!entry || entry.expiresAt <= now()) {
        plans.delete(body.planId as string)
        throw devError('plan_stale', 'the plan is unknown, expired, or already consumed')
      }
      requireBinding(command, entry.foreignProcessId)
      if (command.resource.generation !== entry.generation)
        throw devError('stale_generation', 'the plan is bound to another observation generation')
      if ((body.planDigest as string) !== entry.plan.digest)
        throw devError('invalid_state', 'the plan digest does not match the staged plan')
      // A plan is single use whatever happens next.
      plans.delete(entry.plan.id)

      const observedAt = () => new Date(now()).toISOString()
      const finish = (outcome: ForeignStopResult['outcome'], signalled: number[]) => {
        input.audit?.({
          foreignProcessId: entry.foreignProcessId,
          attribution:
            input.inventory.lookup(entry.foreignProcessId)?.record.attribution.kind ?? 'unknown',
          outcome,
          signalled: signalled.length,
        })
        return {
          foreignProcessId: entry.foreignProcessId,
          outcome,
          signalledPids: signalled,
          observedAt: observedAt(),
        } satisfies ForeignStopResult
      }

      const rootState = await reprove(entry.root)
      if (rootState === 'gone') return finish('already_gone', [])
      if (rootState === 'changed')
        throw devError(
          'ownership_unproven',
          'the process changed identity, owner, or protection since the plan; nothing was signalled'
        )

      const signalled: number[] = []
      // Children first, deepest first, then the root. A child that changed or
      // is gone is skipped; it is never signalled on a stale identity.
      for (const member of [...entry.members, entry.root]) {
        if ((await reprove(member)) !== 'ok') continue
        signal(member.pid, 'SIGTERM')
        signalled.push(member.pid)
      }
      if (await waitForExit(entry.root, gracefulWindowMs)) return finish('stopped', signalled)
      if (!entry.force) return finish('still_running', signalled)

      for (const member of [...entry.members, entry.root]) {
        if ((await reprove(member)) !== 'ok') continue
        signal(member.pid, 'SIGKILL')
        if (!signalled.includes(member.pid)) signalled.push(member.pid)
      }
      if (await waitForExit(entry.root, killWindowMs)) return finish('forced', signalled)
      return finish('still_running', signalled)
    },
  })
}
