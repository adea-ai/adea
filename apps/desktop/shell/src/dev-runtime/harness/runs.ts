// Durable harness run history (#400): the bounded store behind
// `dev.harness.runs` and the resume-as-new-generation substrate.
//
// Retention mirrors the local-stack supervision records: bounded per scope,
// oldest TERMINAL records drop first, an active run is never evicted, and
// every run keeps its observed transitions (bounded per run) so history shows
// observed facts, not guesses. Writes go through the durable JSON store
// (fsync + rename + directory fsync), so a crash cannot lose a run record.
//
// The `transitions` journal is host-side diagnostic history; it never crosses
// the wire inside the `HarnessRun` DTO (its strict decoder allows no extra
// keys) — status changes surface as canonical runtime events instead.
import { join } from 'node:path'

import type {
  HarnessRun,
  HarnessRunState,
  RuntimeEvent,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { createDurableJsonStore } from '../host-store'
import {
  RUN_ACTIVE_STATES,
  RUN_TERMINAL_STATES,
  RunStatusError,
  assertRunTransition,
} from './status'

/** One observed status transition on a run (bounded per run). */
export type RunTransition = Readonly<{
  from: HarnessRunState
  to: HarnessRunState
  source: RuntimeEvent['source']
  observedAt: string
  detail?: string
}>

type StoredHarnessRun = HarnessRun & { transitions?: RunTransition[] }

/** Maximum retained runs per scope; terminal runs drop oldest-first. */
export const MAX_RETAINED_RUNS = 200
/** Maximum retained observed transitions per run. */
export const MAX_TRANSITIONS_PER_RUN = 50

function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

function stripTransitions(run: StoredHarnessRun): HarnessRun {
  const { transitions: _, ...rest } = run
  return { ...rest }
}

function endedAt(run: StoredHarnessRun): string {
  return run.finishedAt ?? run.startedAt ?? ''
}

export type RunHistoryStore = Readonly<{
  list(): HarnessRun[]
  get(id: string): HarnessRun | undefined
  append(run: HarnessRun): void
  replace(run: HarnessRun): void
  transitions(runId: string): readonly RunTransition[]
  /**
   * Applies an observed transition through the canonical machine. Same-state
   * re-observation is an idempotent no-op returning the stored run; a legal
   * edge records the observation (bounded), stamps `finishedAt` on terminal
   * states, and returns the updated run; illegal edges and terminal states
   * throw the typed refusal.
   */
  observe(input: {
    runId: string
    to: HarnessRunState
    source: RuntimeEvent['source']
    observedAt: string
    detail?: string
  }): HarnessRun
}>

export function createRunHistoryStore(input: { dataDir: string; scope: Scope }): RunHistoryStore {
  const store = createDurableJsonStore<StoredHarnessRun>({
    file: join(input.dataDir, 'dev-runtime', 'harness', 'runs.json'),
    schemaVersion: 1,
    label: 'harness runs',
  })

  const inScope = (): StoredHarnessRun[] =>
    store.load().records.filter((run) => sameScope(run.scope, input.scope))

  const save = (records: readonly StoredHarnessRun[]): void => store.save([...records])

  /** Bounded retention: cap total runs per scope, dropping the oldest
   * terminal runs; an active run is never evicted. */
  function applyRetention(records: StoredHarnessRun[]): StoredHarnessRun[] {
    if (records.length <= MAX_RETAINED_RUNS) return records
    const droppable = records
      .filter((run) => RUN_TERMINAL_STATES.includes(run.state))
      .toSorted((left, right) => endedAt(left).localeCompare(endedAt(right)))
    const drop = new Set(
      droppable.slice(0, records.length - MAX_RETAINED_RUNS).map((run) => run.id)
    )
    return records.filter((run) => !drop.has(run.id))
  }

  return {
    list: () => inScope().map(stripTransitions),
    get: (id) => {
      const found = inScope().find((run) => run.id === id)
      return found ? stripTransitions(found) : undefined
    },
    append: (run) => save(applyRetention([...inScope(), run])),
    replace: (run) => save(inScope().map((entry) => (entry.id === run.id ? run : entry))),
    transitions: (runId) => inScope().find((run) => run.id === runId)?.transitions ?? [],
    observe({ runId, to, source, observedAt, detail }) {
      const run = inScope().find((entry) => entry.id === runId)
      if (!run) {
        throw { code: 'not_found', retryable: false, message: 'harness run not found' }
      }
      let changed: boolean
      try {
        changed = assertRunTransition(run.state, to)
      } catch (error) {
        if (error instanceof RunStatusError) {
          // Typed contract refusals, never a raw throw through the gate.
          throw {
            code: error.code === 'already_completed' ? 'already_completed' : 'invalid_state',
            retryable: false,
            message: error.message,
          }
        }
        throw error
      }
      if (!changed) return stripTransitions(run)
      const transitions = [
        ...(run.transitions ?? []),
        { from: run.state, to, source, observedAt, ...(detail !== undefined ? { detail } : {}) },
      ].slice(-MAX_TRANSITIONS_PER_RUN)
      const next: StoredHarnessRun = {
        ...run,
        state: to,
        transitions,
        ...(RUN_TERMINAL_STATES.includes(to) ? { finishedAt: observedAt } : {}),
        version: run.version + 1,
      }
      save(applyRetention(inScope().map((entry) => (entry.id === next.id ? next : entry))))
      return stripTransitions(next)
    },
  }
}

/** Re-exported for the register's active-run fencing (single source of truth). */
export { RUN_ACTIVE_STATES, RUN_TERMINAL_STATES }
