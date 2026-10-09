import type { UserPrincipalRef } from '@adea-ai/types'
import {
  managementCallBinding,
  managementAuthoritySchemaVersion,
  type ManagementAuthorityDecision,
  type ManagementOperationId,
} from '@adea-ai/types/management'

export const MANAGEMENT_NOW = Date.parse('2026-10-09T00:00:00.000Z')
export const MANAGEMENT_WORKSPACE = '0f3a2e1c-0000-4000-8000-000000000001'
export const MANAGEMENT_PROJECT = '0f3a2e1c-0000-4000-8000-000000000002'
export const MANAGEMENT_PRINCIPAL: UserPrincipalRef = { kind: 'user', userId: 'user-1' }

/** Builds a current, allowed, exact-call bound decision for tests. */
export async function managementAuthorityDecision(options: {
  operation: ManagementOperationId
  workspaceId?: string
  targetId: string | null
  input: unknown
  authorityRef?: string
  authorityRevision?: number
  decision?: 'allowed' | 'denied'
  decisionId?: string
  expiresAt?: string
  intentId?: string
  issuedAt?: string
  leadAgentId?: string
  now?: number
  principal?: UserPrincipalRef
}): Promise<ManagementAuthorityDecision> {
  const now = options.now ?? MANAGEMENT_NOW
  const binding = await managementCallBinding({
    input: options.input,
    operation: options.operation,
    targetId: options.targetId,
    workspaceId: options.workspaceId ?? MANAGEMENT_WORKSPACE,
  })
  if (!binding) throw new Error('test decision input is not canonically bound')
  return Object.freeze({
    authorityRef: options.authorityRef ?? 'authority-1',
    authorityRevision: options.authorityRevision ?? 7,
    binding,
    decision: options.decision ?? 'allowed',
    decisionId: options.decisionId ?? 'decision-1',
    expiresAt: options.expiresAt ?? new Date(now + 60_000).toISOString(),
    intentId: options.intentId ?? 'intent-1',
    issuedAt: options.issuedAt ?? new Date(now - 1_000).toISOString(),
    leadAgentId: options.leadAgentId ?? 'agent-lead-1',
    principal: options.principal ?? MANAGEMENT_PRINCIPAL,
    schemaVersion: managementAuthoritySchemaVersion,
  })
}
