import type { SimFrameMessage } from './messages'
import type { SimLaunchGrant } from './launch'

/**
 * What the host knows about a hosted Agent Sim launch, as a pure state machine. The host shows only
 * what this state says: nothing is "running" until the frame reports it, and every failure names a
 * cause. Chat and Dev never read this state, so a failed or offline sim cannot affect them.
 */

export const SIM_UNAVAILABLE_REASONS = [
  'unauthenticated',
  'not_entitled',
  'not_configured',
  'service_unavailable',
  'origin_refused',
  'bridge_incompatible',
  'launch_rejected',
  'engine_failed',
  'frame_timeout',
] as const
export type SimUnavailableReason = (typeof SIM_UNAVAILABLE_REASONS)[number]

type GrantedLaunch = Extract<SimLaunchGrant, { status: 'granted' }>

/**
 * Every state carries the `attempt` it belongs to. `start` begins attempt N+1, and every event
 * that answers a specific attempt (`grant`, `frame`, `timeout`) names the attempt it was issued
 * for. An event for any other attempt is dropped, so a late grant, frame message or timer from an
 * abandoned attempt can never launch, fail or close a newer one. Callers also mint a fresh
 * `bridgeId` per attempt, which stops a stale frame at the message layer as well.
 */
export type SimLaunchState =
  | Readonly<{ phase: 'idle'; attempt: number }>
  | Readonly<{ phase: 'requesting'; attempt: number }>
  | Readonly<{ phase: 'awaiting_frame'; attempt: number; grant: GrantedLaunch }>
  | Readonly<{ phase: 'launching'; attempt: number }>
  | Readonly<{ phase: 'running'; attempt: number }>
  | Readonly<{ phase: 'unavailable'; attempt: number; reason: SimUnavailableReason }>
  | Readonly<{ phase: 'offline'; attempt: number }>

export type SimLaunchEvent =
  | Readonly<{ type: 'start' }>
  /** The backend's parsed reply for `attempt`; `null` is a reply that failed validation. */
  | Readonly<{ type: 'grant'; attempt: number; grant: SimLaunchGrant | null }>
  | Readonly<{ type: 'frame'; attempt: number; message: SimFrameMessage; now: number }>
  | Readonly<{ type: 'timeout'; attempt: number }>
  | Readonly<{ type: 'offline' }>
  | Readonly<{ type: 'dispose' }>

export type SimLaunchEffect =
  | Readonly<{ type: 'request_grant'; attempt: number }>
  | Readonly<{ type: 'post_launch'; attempt: number; grant: GrantedLaunch }>
  | Readonly<{ type: 'dispose_frame'; attempt: number }>

export type SimLaunchStep = Readonly<{ state: SimLaunchState; effect?: SimLaunchEffect }>

const FRAME_ERROR_REASONS = {
  launch_rejected: 'launch_rejected',
  asset_unavailable: 'service_unavailable',
  engine_failed: 'engine_failed',
  bridge_incompatible: 'bridge_incompatible',
} as const

export const SIM_IDLE: SimLaunchState = { phase: 'idle', attempt: 0 }

function stay(state: SimLaunchState): SimLaunchStep {
  return { state }
}

function unavailable(attempt: number, reason: SimUnavailableReason): SimLaunchStep {
  return { state: { phase: 'unavailable', attempt, reason } }
}

function reduceFrame(state: SimLaunchState, message: SimFrameMessage, now: number): SimLaunchStep {
  const { attempt } = state
  switch (message.type) {
    case 'frame.ready': {
      // Only the first ready of an awaited frame launches; a replay changes nothing.
      if (state.phase !== 'awaiting_frame') return stay(state)
      if (Date.parse(state.grant.expiresAt) <= now) return unavailable(attempt, 'frame_timeout')
      return {
        state: { phase: 'launching', attempt },
        effect: { type: 'post_launch', attempt, grant: state.grant },
      }
    }
    case 'frame.state': {
      if (state.phase !== 'launching' && state.phase !== 'running') return stay(state)
      const { state: reported, reason } = message.payload
      if (reported === 'running') return stay({ phase: 'running', attempt })
      if (reported === 'offline') return stay({ phase: 'offline', attempt })
      if (reported === 'unavailable') return unavailable(attempt, reason ?? 'service_unavailable')
      return stay(state)
    }
    case 'frame.error':
      if (state.phase !== 'launching' && state.phase !== 'running') return stay(state)
      return unavailable(attempt, FRAME_ERROR_REASONS[message.payload.code])
    case 'frame.close':
      return state.phase === 'idle' ? stay(state) : stay({ phase: 'idle', attempt })
  }
}

export function reduceSimLaunch(state: SimLaunchState, event: SimLaunchEvent): SimLaunchStep {
  const { attempt } = state
  switch (event.type) {
    case 'start': {
      if (state.phase !== 'idle' && state.phase !== 'unavailable' && state.phase !== 'offline')
        return stay(state)
      const next = attempt + 1
      return {
        state: { phase: 'requesting', attempt: next },
        effect: { type: 'request_grant', attempt: next },
      }
    }
    case 'grant': {
      if (event.attempt !== attempt || state.phase !== 'requesting') return stay(state)
      const { grant } = event
      if (!grant) return unavailable(attempt, 'service_unavailable')
      if (grant.status === 'granted') return stay({ phase: 'awaiting_frame', attempt, grant })
      return unavailable(attempt, grant.reason)
    }
    case 'frame':
      return event.attempt === attempt ? reduceFrame(state, event.message, event.now) : stay(state)
    case 'timeout':
      return event.attempt === attempt &&
        (state.phase === 'awaiting_frame' || state.phase === 'launching')
        ? unavailable(attempt, 'frame_timeout')
        : stay(state)
    case 'offline':
      return state.phase === 'idle' ? stay(state) : stay({ phase: 'offline', attempt })
    case 'dispose':
      return state.phase === 'idle'
        ? stay(state)
        : { state: { phase: 'idle', attempt }, effect: { type: 'dispose_frame', attempt } }
  }
}

export type SimAvailabilityNotice = Readonly<{
  tone: 'neutral' | 'error'
  title: string
  detail: string
  /** Whether trying again can help without the user changing anything else. */
  retryable: boolean
}>

const REASON_COPY: Record<SimUnavailableReason, Omit<SimAvailabilityNotice, 'tone'>> = {
  unauthenticated: {
    title: 'Sign in to open Agent Sim',
    detail: 'Agent Sim needs your Adea account.',
    retryable: false,
  },
  not_entitled: {
    title: 'Agent Sim is not included in this account',
    detail: 'Your account does not include Agent Sim.',
    retryable: false,
  },
  not_configured: {
    title: 'Agent Sim is not set up here',
    detail: 'This deployment has no Agent Sim service configured.',
    retryable: false,
  },
  service_unavailable: {
    title: 'Agent Sim is unavailable right now',
    detail: 'The Agent Sim service did not respond.',
    retryable: true,
  },
  origin_refused: {
    title: 'Agent Sim was blocked',
    detail: 'The Agent Sim frame did not come from an allowed address.',
    retryable: false,
  },
  bridge_incompatible: {
    title: 'Agent Sim needs an update',
    detail: 'This version of Adea and Agent Sim cannot talk to each other.',
    retryable: false,
  },
  launch_rejected: {
    title: 'Agent Sim could not start',
    detail: 'The launch was refused or had already expired.',
    retryable: true,
  },
  engine_failed: {
    title: 'Agent Sim stopped working',
    detail: 'The simulation hit an error.',
    retryable: true,
  },
  frame_timeout: {
    title: 'Agent Sim took too long to start',
    detail: 'It did not finish loading in time.',
    retryable: true,
  },
}

const INDEPENDENCE = ' Chat and Dev are not affected.'

/** Truthful copy for a state, or null when the surface has nothing to say (idle, loading, running). */
export function describeSimAvailability(state: SimLaunchState): SimAvailabilityNotice | null {
  switch (state.phase) {
    case 'offline':
      return {
        tone: 'error',
        title: 'Agent Sim is offline',
        detail: `You are offline, so Agent Sim cannot load.${INDEPENDENCE}`,
        retryable: true,
      }
    case 'unavailable': {
      const copy = REASON_COPY[state.reason]
      return { tone: 'error', ...copy, detail: `${copy.detail}${INDEPENDENCE}` }
    }
    case 'requesting':
    case 'awaiting_frame':
    case 'launching':
      return {
        tone: 'neutral',
        title: 'Opening Agent Sim',
        detail: 'Checking your account and loading the simulation.',
        retryable: false,
      }
    default:
      return null
  }
}
