/**
 * The authorized consumer of an Agent's profile pin.
 *
 * The Control Plane owns AgentProfile versions. An Agent stores an exact pin —
 * profile id, version and revision — and this consumer resolves that exact pin
 * against the profile catalog. It never checks a newer version in place of the
 * saved one, and it never moves an Agent: a version change is a separate,
 * explicit and authorized decision that leaves an audit record.
 *
 * The read model produced here is not an execution authorization. It says
 * whether the exact saved pin is currently available and what to do about it
 * when it is not.
 */

import {
  decideExecutionProfileAdmission,
  type AgentExecutionIdentity,
  type AgentProfileExecutionReadModel,
  type ExecutionProfileBlocker,
  type ExecutionProfileDecision,
  type ExecutionProfilePin,
  type ExecutionProfileRemediation,
  type ExecutionProfileState,
} from './execution-location'

/** What the profile catalog says about one exact profile version. */
export type AgentProfileCatalogEntry = Readonly<{
  profileId: string
  version: string
  revision: number
  /** The catalog lifecycle of that version. */
  lifecycle: 'published' | 'deprecated' | 'revoked' | 'superseded'
  /** Whether the version is approved for execution in the owning workspace. */
  approved: boolean
  /** Whether the version is compatible with the current runtime. */
  compatible: boolean
}>

/**
 * The read port of the profile catalog.
 *
 * The port resolves the *exact* pinned revision. A version whose current
 * revision no longer matches the pin is not that pin, so the port reports it as
 * absent rather than substituting the newer revision.
 */
export interface AgentProfileCatalogPort {
  readProfileVersion(input: {
    profileId: string
    version: string
    revision: number
  }): Promise<AgentProfileCatalogEntry | undefined>
}

/**
 * The read-time availability of an exact pin, derived from the catalog entry.
 *
 * The stored catalog state never asserts a read-time availability claim; this
 * derivation is what turns a catalog answer into one.
 */
export function resolveAgentProfileState(
  entry: AgentProfileCatalogEntry | undefined
): ExecutionProfileState {
  if (entry === undefined) return 'missing'
  if (entry.lifecycle === 'revoked' || entry.lifecycle === 'superseded') return 'revoked'
  if (entry.lifecycle === 'deprecated') return 'deprecated'
  if (!entry.compatible) return 'incompatible'
  if (!entry.approved) return 'unapproved'
  return 'available'
}

/** The outcome of resolving one Agent's pin against the profile catalog. */
export type AgentProfileResolution = Readonly<{
  readModel: AgentProfileExecutionReadModel
  decision: ExecutionProfileDecision
}>

/**
 * Resolve one Agent's exact profile pin against the profile catalog.
 *
 * A catalog read that cannot be completed is `unavailable`, which blocks with
 * a retry remediation instead of being reported as an available profile. The
 * saved pin is never replaced by a newer version.
 */
export async function resolveAgentProfileExecution(input: {
  identity: AgentExecutionIdentity
  pin: ExecutionProfilePin
  catalog: AgentProfileCatalogPort
  checkedAt: string
}): Promise<AgentProfileResolution> {
  let state: ExecutionProfileState
  try {
    const entry = await input.catalog.readProfileVersion({
      profileId: input.pin.id,
      version: input.pin.version,
      revision: input.pin.revision,
    })
    state = resolveAgentProfileState(entry)
  } catch {
    state = 'unavailable'
  }
  const readModel: AgentProfileExecutionReadModel = {
    identity: input.identity,
    pin: input.pin,
    state,
    checkedAt: input.checkedAt,
  }
  return { readModel, decision: decideExecutionProfileAdmission(readModel) }
}

/** The authorization that permits one exact profile pin change. */
export type AgentProfileChangeAuthorization = Readonly<{
  /** The principal that authorized the change. */
  authorizedBy: string
  authorizedAt: string
  /** The exact pin the authorization is bound to. */
  approvedPin: ExecutionProfilePin
}>

/** The audit record one authorized profile change leaves behind. */
export type AgentProfileChangeAudit = Readonly<{
  agentId: string
  previousPin: ExecutionProfilePin
  requestedPin: ExecutionProfilePin
  authorizedBy: string
  authorizedAt: string
  decidedAt: string
}>

/** The outcome of an explicit profile version change. */
export type AgentProfileChangeOutcome =
  | Readonly<{
      ok: true
      pin: ExecutionProfilePin
      audit: AgentProfileChangeAudit
    }>
  | Readonly<{
      ok: false
      blocker: ExecutionProfileBlocker
      remediation: ExecutionProfileRemediation
      requestedPin: ExecutionProfilePin
    }>

/**
 * Decide one explicit profile version change.
 *
 * The change is applied only when an authorization exists and that authorization
 * is bound to the exact requested pin, so an Agent is never silently moved to a
 * newer profile version. The requested pin must also resolve to an available
 * version. Every applied change produces the audit record the caller persists.
 */
export async function authorizeAgentProfileChange(input: {
  identity: AgentExecutionIdentity
  currentPin: ExecutionProfilePin
  requestedPin: ExecutionProfilePin
  authorization: AgentProfileChangeAuthorization | undefined
  catalog: AgentProfileCatalogPort
  decidedAt: string
}): Promise<AgentProfileChangeOutcome> {
  const unapproved = (): AgentProfileChangeOutcome => {
    const readModel: AgentProfileExecutionReadModel = {
      identity: input.identity,
      pin: input.requestedPin,
      state: 'unapproved',
      checkedAt: input.decidedAt,
    }
    const decision = decideExecutionProfileAdmission(readModel)
    if (decision.action !== 'block') throw new Error('AGENT_PROFILE_CHANGE_NOT_BLOCKED')
    return {
      ok: false,
      blocker: decision.blocker,
      remediation: decision.remediation,
      requestedPin: input.requestedPin,
    }
  }
  const authorization = input.authorization
  if (authorization === undefined) return unapproved()
  if (!pinsMatch(authorization.approvedPin, input.requestedPin)) return unapproved()
  let state: ExecutionProfileState
  try {
    const entry = await input.catalog.readProfileVersion({
      profileId: input.requestedPin.id,
      version: input.requestedPin.version,
      revision: input.requestedPin.revision,
    })
    state = resolveAgentProfileState(entry)
  } catch {
    state = 'unavailable'
  }
  const readModel: AgentProfileExecutionReadModel = {
    identity: input.identity,
    pin: input.requestedPin,
    state,
    checkedAt: input.decidedAt,
  }
  const decision = decideExecutionProfileAdmission(readModel)
  if (decision.action !== 'execute') {
    return {
      ok: false,
      blocker: decision.blocker,
      remediation: decision.remediation,
      requestedPin: input.requestedPin,
    }
  }
  return {
    ok: true,
    pin: input.requestedPin,
    audit: {
      agentId: input.identity.id,
      previousPin: input.currentPin,
      requestedPin: input.requestedPin,
      authorizedBy: authorization.authorizedBy,
      authorizedAt: authorization.authorizedAt,
      decidedAt: input.decidedAt,
    },
  }
}

function pinsMatch(left: ExecutionProfilePin, right: ExecutionProfilePin): boolean {
  return left.id === right.id && left.version === right.version && left.revision === right.revision
}
