/**
 * Lead management tool surface (M14.03.1, adea-ai/adea#1215).
 *
 * The workspace lead executes the same inventory operations as the human
 * controls, through the same {@link ManagementOperations} gateway. This module
 * resolves the lead's inherited turn authority, requires an immutable CP
 * decision bound to the exact operation, workspace, target and input, and
 * revalidates that binding locally before any authorization or executor call.
 *
 * A malformed, absent, changed, expired, denied or replayed decision fails
 * closed with a typed reason. The surface imports no database and mints no
 * principal: it only forwards the decision's original user principal.
 *
 * No `server-only` marker: Bun-run unit tests import this module directly.
 */
import type { UserPrincipalRef } from '@adea-ai/types'
import {
  isManagementOperationId,
  managementCallBinding,
  managementOperationSupport,
  managementOperations,
  parseManagementAuthorityDecision,
  validateManagementAuthorityDecision,
  type ManagementAuthorityReasonCode,
  type ManagementCallBinding,
  type ManagementDomain,
  type ManagementOperationId,
} from '@adea-ai/types/management'

import type { ManagementCaller, ManagementFailure, ManagementOutcome } from './management-gateway'
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
   * Resolves the current immutable decision for this exact call. The upstream
   * authority (CP932) must recheck current grants and atomically consume any
   * single-use approval before returning; absent or unresolved authority fails
   * closed. The adapter never fabricates one.
   */
  resolveAuthority?(
    input: Readonly<LeadManagementAuthority & { binding: ManagementCallBinding }>
  ): Promise<unknown>
  now?(): number
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonBlankString(field: unknown): field is string {
  return typeof field === 'string' && field.trim().length > 0
}

/** Safe runtime read of the authority reference; never calls `.trim` on unknown. */
function readAuthorityRef(
  value: unknown
): Readonly<{ authorityRef: string; intentId: string; leadAgentId: string }> | null {
  if (!isPlainRecord(value)) return null
  const { authorityRef, intentId, leadAgentId } = value
  if (!nonBlankString(authorityRef) || !nonBlankString(intentId) || !nonBlankString(leadAgentId))
    return null
  return { authorityRef, intentId, leadAgentId }
}

function authorityFailure(
  operation: ManagementOperationId,
  reason: ManagementAuthorityReasonCode
): ManagementOutcome<never> {
  return Object.freeze({
    failure: Object.freeze({
      code: 'authority_required' as const,
      message: 'Lead management authority is unavailable',
      operation,
      reason,
    }),
    ok: false,
  })
}

function unsupportedFailure(
  operation: ManagementOperationId,
  reason: 'device_required' | 'not_implemented' | 'upstream_authority_unavailable'
): ManagementOutcome<never> {
  return Object.freeze({
    failure: Object.freeze({
      code: 'unsupported' as const,
      message: 'Management operation is not available on this lane',
      operation,
      reason,
    }),
    ok: false,
  })
}

function unavailableFailure(
  operation: ManagementOperationId,
  message: string
): ManagementOutcome<never> {
  return Object.freeze({
    failure: Object.freeze({ code: 'unavailable' as const, message, operation }),
    ok: false,
  })
}

/** The exact canonical input object the decision's digest must cover. */
function leadToolBindingInput(
  call: LeadManagementToolCall
): Readonly<{ input: Readonly<Record<string, unknown>>; targetId: string | null }> | null {
  switch (call.operation) {
    case 'project.archive':
    case 'project.delete':
      return { input: {}, targetId: call.projectId }
    case 'project.create':
      return {
        input: {
          iconKey: call.iconKey,
          ...(call.id ? { id: call.id } : {}),
          name: call.name,
          ...(call.sourceKind ? { sourceKind: call.sourceKind } : {}),
        },
        targetId: call.id ?? null,
      }
    case 'project.member.remove':
      return { input: { projectId: call.projectId }, targetId: call.userId }
    case 'project.member.set':
      return {
        input: { projectId: call.projectId, role: call.role },
        targetId: call.userId,
      }
    case 'project.reorder':
      return { input: { projectIds: [...call.projectIds] }, targetId: null }
    case 'project.update':
      return {
        input: {
          ...(call.iconKey !== undefined ? { iconKey: call.iconKey } : {}),
          ...(call.name !== undefined ? { name: call.name } : {}),
          ...(call.sourceKind !== undefined ? { sourceKind: call.sourceKind } : {}),
        },
        targetId: call.projectId,
      }
    case 'project.visibility.set':
      return { input: { visibility: call.visibility }, targetId: call.projectId }
    case 'config.workspace.reopen':
      return { input: {}, targetId: call.workspaceId }
    case 'config.workspace.update':
      return {
        input: { expectedVersion: call.expectedVersion, ...call.update },
        targetId: call.workspaceId,
      }
  }
}

/** Computes the exact-call binding the authority decision must match. */
export async function leadManagementToolBinding(
  call: LeadManagementToolCall
): Promise<ManagementCallBinding | null> {
  if (!isManagementOperationId(call.operation)) return null
  const bindingInput = leadToolBindingInput(call)
  if (!bindingInput) return null
  return managementCallBinding({
    input: bindingInput.input,
    operation: call.operation,
    targetId: bindingInput.targetId,
    workspaceId: call.workspaceId,
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
  principal: UserPrincipalRef,
  binding: ManagementCallBinding
): Promise<ManagementOutcome<unknown>> {
  switch (call.operation) {
    case 'project.archive':
      return operations.projectArchive({ ...inputOf(call), principal }, binding)
    case 'project.create':
      return operations.projectCreate({ ...inputOf(call), principal }, binding)
    case 'project.delete':
      return operations.projectDelete({ ...inputOf(call), principal }, binding)
    case 'project.member.remove':
      return operations.projectMemberRemove({ ...inputOf(call), principal }, binding)
    case 'project.member.set':
      return operations.projectMemberSet({ ...inputOf(call), principal }, binding)
    case 'project.reorder':
      return operations.projectReorder({ ...inputOf(call), principal }, binding)
    case 'project.update':
      return operations.projectUpdate({ ...inputOf(call), principal }, binding)
    case 'project.visibility.set':
      return operations.projectVisibilitySet({ ...inputOf(call), principal }, binding)
    case 'config.workspace.reopen':
      return operations.workspaceReopen({ ...inputOf(call), principal }, binding)
    case 'config.workspace.update':
      return operations.workspaceUpdate({ ...inputOf(call), principal }, binding)
  }
}

export async function executeLeadManagementTool(
  dependencies: LeadManagementToolsDependencies,
  call: LeadManagementToolCall
): Promise<ManagementOutcome<unknown>> {
  if (!isPlainRecord(call) || !isManagementOperationId(call.operation))
    return authorityFailure('project.update', 'authority_malformed')
  const operation = call.operation
  const support = managementOperationSupport(operation, 'lead')
  if (support.state === 'unsupported') return unsupportedFailure(operation, support.reason)

  const authority = readAuthorityRef(call.authority)
  if (!authority) return authorityFailure(operation, 'authority_malformed')
  const binding = await leadManagementToolBinding(call)
  if (!binding) return authorityFailure(operation, 'authority_malformed')

  let resolved: unknown
  try {
    resolved = dependencies.resolveAuthority
      ? await dependencies.resolveAuthority({ ...authority, binding })
      : null
  } catch {
    return authorityFailure(operation, 'authority_unavailable')
  }
  if (resolved === null || resolved === undefined)
    return authorityFailure(operation, 'authority_unavailable')

  const decision = parseManagementAuthorityDecision(resolved)
  if (!decision) return authorityFailure(operation, 'authority_malformed')
  const invalid = validateManagementAuthorityDecision(decision, {
    authorityRef: authority.authorityRef,
    binding,
    intentId: authority.intentId,
    leadAgentId: authority.leadAgentId,
    now: dependencies.now?.() ?? Date.now(),
  })
  if (invalid) return authorityFailure(operation, invalid)

  let operations: ManagementOperations
  try {
    operations = dependencies.operationsFor({ decision, kind: 'lead', reference: authority })
  } catch {
    return unavailableFailure(operation, 'Management operations are unavailable')
  }
  try {
    return await invoke(operations, call, decision.principal, binding)
  } catch {
    return unavailableFailure(operation, 'Management operation is unavailable')
  }
}

export type { ManagementFailure }
