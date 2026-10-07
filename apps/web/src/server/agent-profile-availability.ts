/** Response-local checks. Catalog state is never persisted as an Agent pin mutation. */
import type { AgentProfileState, AgentSummary } from '@adea-ai/types'
import { resolveAgentProfilePin } from './agent-profile-pin'
import { isAgentProfilePin } from './agent-profile-request'
import {
  ControlPlaneProxyError,
  type AdminCorrelation,
  type ControlPlaneHopDependencies,
} from './control-plane-client'

export const AGENT_PROFILE_READ_LIMITS = Object.freeze({
  concurrency: 4,
  distinctPins: 32,
  deadlineMs: 5_000,
})

export async function withAgentProfileAvailability(
  agents: readonly AgentSummary[],
  correlation: AdminCorrelation,
  dependencies: ControlPlaneHopDependencies,
  signal?: AbortSignal
): Promise<AgentSummary[]> {
  if (!agents.length) return []
  const checkedAt = new Date(dependencies.now?.() ?? Date.now()).toISOString()
  const controller = new AbortController()
  const deadline = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
  const timer = setTimeout(() => controller.abort(), AGENT_PROFILE_READ_LIMITS.deadlineMs)
  const states = new Map<string, AgentProfileState>()
  const pins = new Map<string, AgentSummary['profile']>()
  for (const agent of agents) {
    const key = JSON.stringify([agent.profile.id, agent.profile.version])
    states.set(key, 'unavailable')
    if (pins.size < AGENT_PROFILE_READ_LIMITS.distinctPins) pins.set(key, agent.profile)
  }
  const queue = [...pins.entries()]
  let cursor = 0
  const fetchImplementation = dependencies.fetch ?? fetch
  const boundedFetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      deadline.throwIfAborted()
      return fetchImplementation(input, {
        ...init,
        signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]),
      })
    },
    { preconnect: fetchImplementation.preconnect }
  )
  const boundedDependencies: ControlPlaneHopDependencies = {
    ...dependencies,
    fetch: boundedFetch,
  }
  async function worker() {
    while (cursor < queue.length && !deadline.aborted) {
      const [key, profile] = queue[cursor++]!
      const pin = { profileId: profile.id, profileVersion: profile.version }
      if (!isAgentProfilePin(pin)) {
        states.set(key, 'incompatible')
        continue
      }
      try {
        await untilAborted(resolveAgentProfilePin(pin, correlation, boundedDependencies), deadline)
        if (!deadline.aborted) states.set(key, 'available')
      } catch (error) {
        states.set(key, deadline.aborted ? 'unavailable' : refusalState(error))
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: AGENT_PROFILE_READ_LIMITS.concurrency }, worker))
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  return agents.map((agent) => ({
    ...agent,
    profile: Object.freeze({
      ...agent.profile,
      state: states.get(JSON.stringify([agent.profile.id, agent.profile.version])) ?? 'unavailable',
      checkedAt,
    }),
  }))
}

function refusalState(error: unknown): AgentProfileState {
  if (!(error instanceof ControlPlaneProxyError)) return 'unavailable'
  switch (error.code) {
    case 'AGENT_PROFILE_DEPRECATED':
      return 'deprecated'
    case 'AGENT_PROFILE_REVOKED':
      return 'revoked'
    case 'AGENT_PROFILE_MISSING':
      return 'missing'
    case 'AGENT_PROFILE_DRAFT':
    case 'AGENT_PROFILE_SUPERSEDED':
      return 'unapproved'
    default:
      if (error.status === 404) return 'missing'
      if (error.status === 403) return 'unapproved'
      if (error.status === 422) return 'incompatible'
      return 'unavailable'
  }
}

/** Also bounds credential/scope work; ignored late results cannot change the response. */
function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('Profile read unavailable'))
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}
