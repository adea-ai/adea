// Agent persona (profile/presentation) changes never broaden grants (M14.03.2,
// adea#1218).
//
// An Agent's authority to act is structural: the workspace that owns it, the
// project it may work in, its workspace-lead designation and its lifecycle
// state. Its persona — the picked profile pin, name, role summary, avatar and
// presentation metadata — is presentation and behaviour selection only. This
// module is the one guard that keeps the two apart:
//
// - `decideAgentPersonaChange` refuses any change record that names a
//   structural/authority field, so a persona call cannot move an Agent into
//   another project or workspace, make it a workspace lead, revive an
//   archived Agent or rewrite its revision token. It also refuses a stale
//   expected revision and a blank profile pin.
// - `AgentPersonaPlan.preservedAuthority` carries the observed authority
//   unchanged, so a caller (the shared audited management API) can assert and
//   audit that the change broadened nothing.
//
// The plan is pure and carries no database handle; `changeAgentProfile` in
// `agents.ts` applies it in the same transaction that writes the profile pin.
import type { AgentLifecycleState } from '@adea-ai/types'

/** The structural fields a persona change may never touch. */
export const AGENT_AUTHORITY_FIELDS = [
  'id',
  'workspaceId',
  'projectId',
  'isWorkspaceLead',
  'lifecycleState',
  'profileRevision',
] as const

export type AgentAuthorityField = (typeof AGENT_AUTHORITY_FIELDS)[number]

export type AgentPersonaRefusalReason =
  | 'agent_unavailable'
  /** The change record names a structural field; fails closed, nothing written. */
  | 'persona_change_would_broaden_grants'
  | 'persona_stale_revision'
  | 'persona_invalid_profile'

export type AgentAuthoritySnapshot = Readonly<{
  agentId: string
  workspaceId: string
  projectId?: string
  isWorkspaceLead: boolean
  lifecycleState: AgentLifecycleState
  profileRevision: number
}>

/**
 * A persona change as the shared API receives it. The index signature is
 * deliberate: an untyped caller that smuggles `projectId` into the patch is
 * still refused by name rather than by accident of TypeScript narrowing.
 */
export type AgentPersonaChange = Readonly<{
  avatarRef?: unknown
  characterRef?: unknown
  name?: unknown
  presentationMetadata?: unknown
  profileId?: unknown
  profileState?: unknown
  profileVersion?: unknown
  roleSummary?: unknown
  [field: string]: unknown
}>

export type AgentPersonaPlan = Readonly<{
  agentId: string
  /** The workspace whose Agent changes; never re-derived from the change. */
  workspaceId: string
  /** Authority exactly as observed; the change writes none of it. */
  preservedAuthority: AgentAuthoritySnapshot
  /** The normalized profile pin the write applies. */
  profileId: string
  profileVersion: string
  observedProfileRevision: number
  nextProfileRevision: number
}>

export type AgentPersonaDecision =
  | Readonly<{ allowed: true; plan: AgentPersonaPlan }>
  | Readonly<{ allowed: false; reason: AgentPersonaRefusalReason }>

export class AgentPersonaPolicyError extends Error {
  readonly reason: AgentPersonaRefusalReason
  constructor(reason: AgentPersonaRefusalReason) {
    super(
      reason === 'persona_stale_revision'
        ? 'Agent profile changed; refresh and retry'
        : 'Agent persona change refused'
    )
    this.name = 'AgentPersonaPolicyError'
    this.reason = reason
  }
}

function nonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * The one persona decision. Order: audience, then structural broadening (the
 * security-relevant refusal), then staleness, then pin validity.
 */
export function decideAgentPersonaChange(input: {
  agent: AgentAuthoritySnapshot | null
  authorizedWorkspaceId: string
  expectedRevision: number
  change: AgentPersonaChange
}): AgentPersonaDecision {
  const { agent } = input
  if (!agent || agent.workspaceId !== input.authorizedWorkspaceId) {
    return { allowed: false, reason: 'agent_unavailable' }
  }
  for (const field of AGENT_AUTHORITY_FIELDS) {
    if (input.change[field] !== undefined) {
      return { allowed: false, reason: 'persona_change_would_broaden_grants' }
    }
  }
  if (agent.profileRevision !== input.expectedRevision) {
    return { allowed: false, reason: 'persona_stale_revision' }
  }
  const profileId = nonBlankString(input.change.profileId)
  const profileVersion = nonBlankString(input.change.profileVersion)
  if (!profileId || !profileVersion) {
    return { allowed: false, reason: 'persona_invalid_profile' }
  }
  return {
    allowed: true,
    plan: Object.freeze({
      agentId: agent.agentId,
      workspaceId: agent.workspaceId,
      preservedAuthority: Object.freeze({ ...agent }),
      profileId,
      profileVersion,
      observedProfileRevision: agent.profileRevision,
      nextProfileRevision: agent.profileRevision + 1,
    }),
  }
}
