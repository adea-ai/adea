// On-device usage adapters for #424: production adapters over what is
// PROVABLY countable on this machine without any model-provider account.
//
// Every number traces to a durable record the runtime already owns: harness
// session counts and wall-clock durations come from the harness registrar's
// durable run history (`harness.history`), and terminal durable-history bytes
// come from the sealed checkpoint segments the terminal lane wrote under the
// owner-only runtime root (issue #396 layout). Sources are read-only and
// bounded — the same discipline as the `ps` sampler: injected seams, bounded
// reads, no shell, no network, no process spawning. Nothing here is billing
// truth: provider-billed usage has no reviewed endpoint and stays a typed
// `capability_unavailable` row with the precise reason, and the stream relay
// keeps its sessions in memory only, so file-stream bytes are typed-
// unavailable until a durable transfer journal exists. On-device records carry
// source `harness_protocol` (the runtime's own protocol-backed durable
// records), confidence `measured`, and a declared one-minute freshness so the
// cache refreshes instead of growing stale silently.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { HarnessRun } from '../../../../../../packages/types/src/dev-runtime'
import { listSealedSegments } from '../terminal/retention'
import type { UsageAdapter, UsageAdapterResult, UsageObservation } from './contract'
import { RUN_TERMINAL_STATES } from '../harness/status'

/** Declared freshness for on-device facts: the manual-refresh floor. The
 *  facts change as runs complete and segments seal, so the cache expires and
 *  refreshes rather than reporting a frozen snapshot. */
export const ON_DEVICE_FRESHNESS_SECONDS = 60

/** Bounded per-poll emission: the newest completed-run rows the adapter emits
 *  before the two aggregate rows. The store retains 200 runs, so one poll
 *  never exceeds the service's 120-records-per-provider cache window for the
 *  aggregates (aggregates are emitted last and survive the cache's tail
 *  slice). */
export const MAX_PER_RUN_ROWS = 100

/** Narrow read-only view of the harness registrar's durable run history
 *  (`HarnessRuntimeRegistration.history`). */
export type HarnessRunHistorySource = Readonly<{ list(): readonly HarnessRun[] }>

/** One wall-clock second string, or undefined when the durable record cannot
 *  prove the duration (missing or unparseable bound, or a negative span —
 *  never a guess, never a fabricated 0). */
export function runWallClockSeconds(run: {
  startedAt?: string
  finishedAt?: string
}): string | undefined {
  if (run.startedAt === undefined || run.finishedAt === undefined) return undefined
  const from = Date.parse(run.startedAt)
  const to = Date.parse(run.finishedAt)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return undefined
  return String(Math.round((to - from) / 1000))
}

/** The safe display label for a run: the model it ran, else the agent
 *  profile's display name, else the profile id. Never a credential or an
 *  account secret (spec: usage account labels are safe display labels). */
export function runDisplayLabel(run: HarnessRun): string {
  if (run.modelId !== undefined && run.modelId.length > 0) return run.modelId
  if (run.agentProfile.displayName.length > 0) return run.agentProfile.displayName
  return run.agentProfile.id
}

/**
 * The `device:harness` adapter: session counts and wall-clock durations from
 * the durable run history. Per-run rows carry the run id as `ownerId` (the
 * provenance chain: record → run record) and the durable period bounds; the
 * two aggregate rows (total and still-active session counts) summarize the
 * same store. A failed store read is a typed failure, never a fabricated 0.
 */
export function createHarnessUsageAdapter(input: {
  runs: HarnessRunHistorySource
  provider?: string
}): UsageAdapter {
  const provider = input.provider ?? 'device:harness'
  return {
    provider,
    source: 'harness_protocol',
    async fetchUsage(): Promise<UsageAdapterResult> {
      let runs: readonly HarnessRun[]
      try {
        runs = input.runs.list()
      } catch (error) {
        return {
          ok: false,
          code: 'unavailable',
          message: error instanceof Error ? error.message : 'harness run history is unreadable',
        }
      }
      const completed = runs
        .filter((run) => run.startedAt !== undefined && run.finishedAt !== undefined)
        .toSorted((left, right) => (left.finishedAt ?? '').localeCompare(right.finishedAt ?? ''))
      const perRun: readonly UsageObservation[] = completed.slice(-MAX_PER_RUN_ROWS).flatMap(
        (run): UsageObservation[] => {
          const seconds = runWallClockSeconds(run)
          if (seconds === undefined) return []
          return [
            {
              ownerId: run.id,
              provider: '',
              quantity: seconds,
              unit: 'seconds',
              confidence: 'measured',
              accountLabel: runDisplayLabel(run),
              period: {
                from: run.startedAt as string,
                to: run.finishedAt as string,
              },
              expiresInSeconds: ON_DEVICE_FRESHNESS_SECONDS,
            },
          ]
        }
      )
      const aggregates: readonly UsageObservation[] = [
        {
          ownerId: `usage:${provider}`,
          provider: '',
          quantity: String(runs.length),
          unit: 'sessions',
          confidence: 'measured',
          accountLabel: 'durable run history',
          expiresInSeconds: ON_DEVICE_FRESHNESS_SECONDS,
        },
        {
          ownerId: `usage:${provider}`,
          provider: '',
          quantity: String(runs.filter((run) => !RUN_TERMINAL_STATES.includes(run.state)).length),
          unit: 'active_sessions',
          confidence: 'measured',
          accountLabel: 'not in a terminal state',
          expiresInSeconds: ON_DEVICE_FRESHNESS_SECONDS,
        },
      ]
      return { ok: true, observations: [...perRun, ...aggregates] }
    },
  }
}

const TERMINAL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * The `device:terminal` adapter: durable-history bytes per terminal, counted
 * from the sealed checkpoint segments under the owner-only runtime root (the
 * terminal lane's durable record — issue #396 layout, read-only byte
 * accounting exactly like the retained-data projection). A terminal with no
 * sealed segments contributes nothing; an unreadable root contributes nothing
 * (absence is truthful, never zero). Terminal attach minutes are deliberately
 * NOT reported: the terminal manager keeps attach facts in memory only, so
 * no durable record proves them yet.
 */
export function createTerminalUsageAdapter(input: {
  /** Owner-only terminal runtime root; segments live at
   *  `<runtimeRoot>/<terminalId>/seg-*.adt`. */
  runtimeRoot: string
  provider?: string
}): UsageAdapter {
  const provider = input.provider ?? 'device:terminal'
  return {
    provider,
    source: 'harness_protocol',
    async fetchUsage(): Promise<UsageAdapterResult> {
      if (!existsSync(input.runtimeRoot)) return { ok: true, observations: [] }
      let names: string[]
      try {
        names = readdirSync(input.runtimeRoot)
      } catch {
        return { ok: true, observations: [] }
      }
      const observations: UsageObservation[] = []
      for (const name of names) {
        if (!TERMINAL_ID_PATTERN.test(name)) continue
        let segments
        try {
          segments = listSealedSegments(join(input.runtimeRoot, name))
        } catch {
          continue
        }
        if (segments.length === 0) continue
        const bytes = segments.reduce((total, segment) => total + segment.size, 0)
        observations.push({
          ownerId: name,
          provider: '',
          quantity: String(bytes),
          unit: 'bytes',
          confidence: 'measured',
          accountLabel: `checkpoint history (${segments.length} segment${segments.length === 1 ? '' : 's'})`,
          expiresInSeconds: ON_DEVICE_FRESHNESS_SECONDS,
        })
      }
      return { ok: true, observations }
    },
  }
}

/**
 * A typed-unavailable adapter: it never observes and never fabricates. The
 * listing shows an explicit failure row (quantity `unknown`) carrying the
 * precise reason — the spec's answer for a usage surface without a provable
 * source. Provider-billed usage composes one of these per provider until a
 * reviewed endpoint and a vault credential exist.
 */
export function createTypedUnavailableUsageAdapter(input: {
  provider: string
  /** The precise reason nothing is observable; surfaced verbatim. */
  reason: string
  source?: UsageAdapter['source']
}): UsageAdapter {
  return {
    provider: input.provider,
    source: input.source ?? 'official_api',
    async fetchUsage(): Promise<UsageAdapterResult> {
      return { ok: false, code: 'capability_unavailable', message: input.reason }
    },
  }
}
