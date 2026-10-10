/**
 * Lead management tool surface (M14.03.1, adea-ai/adea#1215).
 *
 * The workspace lead executes the same inventory operations as the human
 * controls, through the same {@link ManagementOperations} gateway. This module
 * only resolves the lead's inherited turn authority and maps a tool call onto
 * the shared operation; it never mints a principal or imports a database.
 *
 * A lead tool without a resolved upstream authority fails closed with the
 * typed `upstream_authority_unavailable` reason, and an operation that the
 * inventory does not mark callable on the lead lane is refused before any
 * authority lookup, so a missing upstream contract can never widen a grant.
 *
 * No `server-only` marker: Bun-run unit tests import this module directly.
 */
import type { UserPrincipalRef } from '@adea-ai/types'
import {
  isManagementOperationId,
  managementOperationSupport,
  managementOperations,
  type ManagementDomain,
  type ManagementOperationId,
} from '@adea-ai/types/management'

import type { ManagementCaller, ManagementOutcome } from './management-gateway'
import type { ManagementOperations } from './management-operations'

/** The immutable upstream turn authority reference a lead tool must carry. */
export type LeadManagementAuthority = Readonly<{
  authorityRef: string
  intentId: string
  leadAgentId: string
}>

export type LeadManagementToolDefinition = Readonly<{
  description: string
  domain: ManagementDomain
  name: ManagementOperationId
}>

const LEAD_TOOL_METHODS = {
  projectArchive: 'project.archive',
  projectCreate: 'project.create',
  projectDelete: 'project.delete',
  projectPromote: 'project.promote',
  projectMemberRemove: 'project.member.remove',
  projectMemberSet: 'project.member.set',
  projectReorder: 'project.reorder',
  projectUpdate: 'project.update',
  projectVisibilitySet: 'project.visibility.set',
  workspaceReopen: 'config.workspace.reopen',
  workspaceUpdate: 'config.workspace.update',
} as const

type LeadToolMethod = keyof typeof LEAD_TOOL_METHODS
type LeadToolInput<Method extends LeadToolMethod> = Omit<
  Parameters<ManagementOperations[Method]>[0],
  'principal'
>

export type LeadManagementToolCall = {
  [Method in LeadToolMethod]: Readonly<
    {
      authority: LeadManagementAuthority
      operation: (typeof LEAD_TOOL_METHODS)[Method]
    } & LeadToolInput<Method>
  >
}[LeadToolMethod]

export type LeadManagementToolsDependencies = Readonly<{
  operationsFor(caller: ManagementCaller): ManagementOperations
  /**
   * Resolves the canonical turn authority for this exact lead/authority/intent
   * binding. Absent or unresolved authority fails closed; the adapter never
   * fabricates one.
   */
  resolveAuthority?(
    input: LeadManagementAuthority
  ): Promise<Readonly<{ principal: UserPrincipalRef }> | null>
}>

/** The lead-callable slice of the inventory, derived from the same catalog. */
export function leadManagementToolDefinitions(): readonly LeadManagementToolDefinition[] {
  return Object.freeze(
    Object.values(LEAD_TOOL_METHODS).map((id) => {
      const operation = managementOperations[id]
      return Object.freeze({
        description: `Workspace ${operation.domain} management: ${id}`,
        domain: operation.domain,
        name: id,
      })
    })
  )
}

function authorityFailure(
  operation: ManagementOperationId,
  reason:
    | 'device_required'
    | 'not_implemented'
    | 'upstream_authority_unavailable' = 'upstream_authority_unavailable'
): ManagementOutcome<never> {
  return Object.freeze({
    failure: Object.freeze({
      ...(reason === 'upstream_authority_unavailable'
        ? {
            code: 'authority_required' as const,
            message: 'Lead management authority is unavailable',
          }
        : {
            code: 'unsupported' as const,
            message: 'Management operation is not available on this lane',
          }),
      operation,
      reason,
    }),
    ok: false,
  })
}

/** Removes the routing fields so only the operation input reaches the gateway. */
function inputOf<Call extends LeadManagementToolCall>(
  call: Call
): Omit<Call, 'authority' | 'operation'> {
  const { authority, operation, ...input } = call
  void authority
  void operation
  return input as Omit<Call, 'authority' | 'operation'>
}

function invoke(
  operations: ManagementOperations,
  call: LeadManagementToolCall,
  principal: UserPrincipalRef
): Promise<ManagementOutcome<unknown>> {
  switch (call.operation) {
    case 'project.archive':
      return operations.projectArchive({ ...inputOf(call), principal })
    case 'project.create':
      return operations.projectCreate({ ...inputOf(call), principal })
    case 'project.delete':
      return operations.projectDelete({ ...inputOf(call), principal })
    case 'project.promote':
      return operations.projectPromote({ ...inputOf(call), principal })
    case 'project.member.remove':
      return operations.projectMemberRemove({ ...inputOf(call), principal })
    case 'project.member.set':
      return operations.projectMemberSet({ ...inputOf(call), principal })
    case 'project.reorder':
      return operations.projectReorder({ ...inputOf(call), principal })
    case 'project.update':
      return operations.projectUpdate({ ...inputOf(call), principal })
    case 'project.visibility.set':
      return operations.projectVisibilitySet({ ...inputOf(call), principal })
    case 'config.workspace.reopen':
      return operations.workspaceReopen({ ...inputOf(call), principal })
    case 'config.workspace.update':
      return operations.workspaceUpdate({ ...inputOf(call), principal })
  }
}

export async function executeLeadManagementTool(
  dependencies: LeadManagementToolsDependencies,
  call: LeadManagementToolCall
): Promise<ManagementOutcome<unknown>> {
  // The runtime check duplicates the type-level union so a malformed caller
  // (or an operation smuggled past the type) is refused before any authority
  // lookup or executor call.
  if (!isManagementOperationId(call.operation)) return authorityFailure('project.update')
  const support = managementOperationSupport(call.operation, 'lead')
  if (support.state === 'unsupported') return authorityFailure(call.operation, support.reason)

  const authority = call.authority
  const complete =
    authority.authorityRef.trim().length > 0 &&
    authority.intentId.trim().length > 0 &&
    authority.leadAgentId.trim().length > 0
  if (!complete) return authorityFailure(call.operation)

  const resolved = dependencies.resolveAuthority
    ? await dependencies.resolveAuthority(authority)
    : null
  if (!resolved?.principal) return authorityFailure(call.operation)

  const caller: ManagementCaller = {
    authorityRef: authority.authorityRef,
    intentId: authority.intentId,
    kind: 'lead',
    leadAgentId: authority.leadAgentId,
  }
  return invoke(dependencies.operationsFor(caller), call, resolved.principal)
}
