// Canonical HarnessRun status machine (#400).
//
// Pure and clock-free by design: precedence and transition rules are table
// driven so tests can pin every edge on injected clocks. The Dev Runtime owns
// NO process signals here — a transition is applied only from an OBSERVED
// fact carried by the gate (`dev.harness.runStatus`), mirroring the local
// stack supervision discipline: a signal is never treated as an exit, and an
// unknown protocol response never becomes success. `stale` is metadata
// (`source` + `observedAt`), never a replacement success state.
import type {
  HarnessRunState,
  RuntimeEvent,
} from '../../../../../../packages/types/src/dev-runtime'

export type RunObservationSource = RuntimeEvent['source']

/** States that accept no further transitions; cancel/launch refuse on them. */
export const RUN_TERMINAL_STATES: readonly HarnessRunState[] = [
  'completed',
  'failed',
  'cancelled',
  'disconnected',
]

/** States where a run is live: an active run fences a second launch. */
export const RUN_ACTIVE_STATES: readonly HarnessRunState[] = [
  'resolving',
  'starting',
  'working',
  'awaiting_input',
  'awaiting_approval',
]

/**
 * The canonical transition table. Absence of a target is an illegal edge:
 * `unknown` is a truthful holding state whose only exits re-derive facts
 * (working/failed/cancelled/disconnected/completed) — it never silently
 * rewrites history.
 */
export const RUN_TRANSITIONS: Readonly<Record<HarnessRunState, readonly HarnessRunState[]>> = {
  resolving: ['starting', 'failed', 'cancelled', 'disconnected'],
  starting: [
    'working',
    'awaiting_input',
    'awaiting_approval',
    'failed',
    'cancelled',
    'disconnected',
    'unknown',
  ],
  working: [
    'awaiting_input',
    'awaiting_approval',
    'completed',
    'failed',
    'cancelled',
    'disconnected',
    'unknown',
  ],
  awaiting_input: ['working', 'completed', 'failed', 'cancelled', 'disconnected', 'unknown'],
  awaiting_approval: ['working', 'completed', 'failed', 'cancelled', 'disconnected', 'unknown'],
  completed: [],
  failed: [],
  cancelled: [],
  disconnected: [],
  unknown: ['working', 'completed', 'failed', 'cancelled', 'disconnected'],
}

export function isTerminalRunState(state: HarnessRunState): boolean {
  return RUN_TERMINAL_STATES.includes(state)
}

export function isActiveRunState(state: HarnessRunState): boolean {
  return RUN_ACTIVE_STATES.includes(state)
}

export class RunStatusError extends Error {
  constructor(
    readonly code: 'invalid_transition' | 'already_completed',
    message: string
  ) {
    super(message)
    this.name = 'RunStatusError'
  }
}

/** True exactly when `from → to` is a canonical edge. */
export function canTransitionRun(from: HarnessRunState, to: HarnessRunState): boolean {
  return RUN_TRANSITIONS[from].includes(to)
}

/**
 * Validates one observed transition. Same-state re-observation is an ignored
 * idempotent replay (returns false — nothing changed); an illegal edge throws
 * the typed refusal; a terminal state refuses everything.
 */
export function assertRunTransition(from: HarnessRunState, to: HarnessRunState): boolean {
  if (from === to) return false
  if (isTerminalRunState(from)) {
    throw new RunStatusError('already_completed', `harness run is already ${from}`)
  }
  if (!canTransitionRun(from, to)) {
    throw new RunStatusError('invalid_transition', `harness run cannot move ${from} → ${to}`)
  }
  return true
}

/** The canonical runtime-event kind for a run reaching `state`. */
export function runEventKind(state: HarnessRunState): RuntimeEvent['kind'] | undefined {
  switch (state) {
    case 'resolving':
    case 'starting':
      return 'run.starting'
    case 'working':
      return 'run.ready'
    case 'awaiting_input':
    case 'awaiting_approval':
      // Awaiting states are run liveness facts; the approval/question
      // request/resolution events themselves come from the event tiers.
      return 'run.ready'
    case 'completed':
      return 'run.completed'
    case 'failed':
      return 'run.failed'
    case 'cancelled':
      return 'run.cancelled'
    case 'disconnected':
      return 'run.disconnected'
    default:
      return undefined
  }
}
