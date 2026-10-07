import { and, eq, isNull } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { projects, workspaces } from './schema'

/**
 * Control Plane scope identifiers (ADR 0013). Adea mints one opaque, prefixed
 * ULID per workspace (`wsp_`) and project (`prj_`) — never derived from the
 * Adea UUID and never reused. Runtime nodes carry stable `rnr_` references.
 * Task and agent prefixes are reserved for when
 * executions are wired. The grammar is the Control Plane's own
 * (`packages/contracts/src/identifiers.ts` in that repository).
 */
export type ControlPlaneIdentifierPrefix = 'agt' | 'prj' | 'rnr' | 'tsk' | 'wsp'

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export const CONTROL_PLANE_IDENTIFIER_PATTERN = /^(wsp|prj|rnr|tsk|agt)_[0-9A-HJKMNP-TV-Z]{26}$/u

export function isControlPlaneIdentifier(
  prefix: ControlPlaneIdentifierPrefix,
  value: unknown
): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(`${prefix}_`) &&
    CONTROL_PLANE_IDENTIFIER_PATTERN.test(value)
  )
}

/**
 * Mints `<prefix>_<ULID>`: ten characters of the millisecond timestamp, then
 * sixteen characters (80 bits) from the platform CSPRNG. Works in Workers,
 * Bun and Node through `crypto.getRandomValues`.
 */
export function mintControlPlaneIdentifier(
  prefix: ControlPlaneIdentifierPrefix,
  now: number = Date.now()
): string {
  let time = Math.max(0, Math.floor(now))
  let timePart = ''
  for (let index = 0; index < 10; index += 1) {
    timePart = CROCKFORD_ALPHABET[time % 32] + timePart
    time = Math.floor(time / 32)
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let randomPart = ''
  // Each random character takes the low five bits of its own byte: uniform
  // over the 32-symbol alphabet and 80 bits in total.
  for (const byte of bytes) randomPart += CROCKFORD_ALPHABET[byte & 31]
  return `${prefix}_${timePart}${randomPart}`
}

export type ControlPlaneScopeIds = Readonly<{
  /** The mapped `wsp_` identifier. */
  workspaceId: string
  /** The mapped `prj_` identifier when a project was requested. */
  projectId?: string
}>

/**
 * The Control Plane scope mapped to a live Adea workspace (and optionally one
 * of its live projects). Returns null when either is absent or deleted, or
 * when the project belongs to another workspace. Callers authorize the Adea
 * workspace first; this only translates identifiers.
 */
export async function controlPlaneScopeIds(
  database: AgentHqDatabase | AgentHqTransaction,
  input: Readonly<{ workspaceId: string; projectId?: string }>
): Promise<ControlPlaneScopeIds | null> {
  const [workspace] = await database
    .select({ controlPlaneWorkspaceId: workspaces.controlPlaneWorkspaceId })
    .from(workspaces)
    .where(and(eq(workspaces.id, input.workspaceId), isNull(workspaces.deletedAt)))
    .limit(1)
  if (!workspace || !isControlPlaneIdentifier('wsp', workspace.controlPlaneWorkspaceId)) return null
  if (input.projectId === undefined)
    return Object.freeze({ workspaceId: workspace.controlPlaneWorkspaceId })
  const [project] = await database
    .select({ controlPlaneProjectId: projects.controlPlaneProjectId })
    .from(projects)
    .where(
      and(
        eq(projects.id, input.projectId),
        eq(projects.workspaceId, input.workspaceId),
        isNull(projects.deletedAt)
      )
    )
    .limit(1)
  if (!project || !isControlPlaneIdentifier('prj', project.controlPlaneProjectId)) return null
  return Object.freeze({
    projectId: project.controlPlaneProjectId,
    workspaceId: workspace.controlPlaneWorkspaceId,
  })
}
