/**
 * Private CP-to-Adea lead management host endpoint (M14.03.1,
 * adea-ai/adea#1215).
 *
 * The Control Plane host posts one management call with its signed exact-call
 * decision. This handler verifies the bearer decision, strictly decodes the
 * call envelope, and dispatches through the same lead tool surface the human
 * controls share. It grants nothing on its own: an invalid, mismatched or
 * replayed decision produces a typed failure with zero executor calls.
 *
 * No `server-only` marker: Bun-run unit tests import this module directly.
 */
import {
  isManagementOperationId,
  managementCallSchemaVersion,
  managementOperationSupport,
  type ManagementAuthorityDecision,
} from '@adea-ai/types/management'

import {
  executeLeadManagementTool,
  type LeadManagementAuthority,
  type LeadManagementToolCall,
  type LeadManagementToolsDependencies,
} from './lead-management-tools'
import type { ManagementCaller, ManagementOutcome } from './management-gateway'
import type { ManagementOperations } from './management-operations'
import { parseWorkspaceUpdate } from './workspace-request'
import type { ProjectMemberRole, ProjectSourceKind, ProjectVisibility } from '@adea-ai/types'

const BODY_LIMIT_BYTES = 64 * 1024
const RESULT_SCHEMA_VERSION = 'adea-management-result/v1'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type LeadManagementRouteDependencies = Readonly<{
  verify(request: Request): Promise<ManagementAuthorityDecision | null>
  operationsFor(caller: ManagementCaller): ManagementOperations
  /** Local single-use guard; the CP store remains the durable replay owner. */
  consumeDecision(decision: ManagementAuthorityDecision): Promise<boolean>
  now?(): number
}>

const unavailable = () =>
  Response.json(
    { code: 'LEAD_MANAGEMENT_UNAVAILABLE' },
    { status: 404, headers: { 'cache-control': 'private, no-store' } }
  )

async function readBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) return undefined
  try {
    const text = await request.text()
    if (text.length > BODY_LIMIT_BYTES) return undefined
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value)
}

function optionalMemberKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(input).every((key) => keys.includes(key))
}

function projectFields(
  input: Record<string, unknown>,
  options: Readonly<{ requireOne: boolean }>
): Readonly<{ iconKey?: string; name?: string; sourceKind?: ProjectSourceKind }> | null {
  if (!optionalMemberKeys(input, ['iconKey', 'name', 'sourceKind'])) return null
  const result: { iconKey?: string; name?: string; sourceKind?: ProjectSourceKind } = {}
  if ('iconKey' in input) {
    if (!boundedString(input.iconKey, 80) || input.iconKey.trim().length === 0) return null
    result.iconKey = input.iconKey.trim()
  }
  if ('name' in input) {
    if (!boundedString(input.name, 80) || input.name.trim().length === 0) return null
    result.name = input.name.trim()
  }
  if ('sourceKind' in input) {
    if (input.sourceKind !== 'none' && input.sourceKind !== 'repository') return null
    result.sourceKind = input.sourceKind
  }
  if (options.requireOne && Object.keys(result).length === 0) return null
  return result
}

/**
 * Strictly decodes the wire call into the typed lead tool union. The exact
 * input digest is revalidated against the signed decision by the adapter.
 */
export function parseLeadManagementCall(
  value: unknown,
  authority: LeadManagementAuthority
): LeadManagementToolCall | null {
  const body = record(value)
  if (!body || !exactKeys(body, ['input', 'operation', 'schemaVersion', 'targetId', 'workspaceId']))
    return null
  if (body.schemaVersion !== managementCallSchemaVersion) return null
  if (!isManagementOperationId(body.operation)) return null
  const operation = body.operation
  if (managementOperationSupport(operation, 'lead').state !== 'supported') return null
  if (!boundedString(body.workspaceId, 128)) return null
  if (body.targetId !== null && !boundedString(body.targetId, 128)) return null
  const input = record(body.input)
  if (!input) return null
  const targetId = body.targetId
  const workspaceId = body.workspaceId

  switch (operation) {
    case 'project.create': {
      if (!optionalMemberKeys(input, ['iconKey', 'id', 'name', 'sourceKind'])) return null
      if (!boundedString(input.iconKey, 80) || !boundedString(input.name, 80)) return null
      if (input.id !== undefined && !uuid(input.id)) return null
      if (
        input.sourceKind !== undefined &&
        input.sourceKind !== 'none' &&
        input.sourceKind !== 'repository'
      )
        return null
      const expectedTarget = input.id ?? null
      if (targetId !== expectedTarget) return null
      return {
        authority,
        iconKey: input.iconKey.trim(),
        ...(input.id ? { id: input.id } : {}),
        name: input.name.trim(),
        operation,
        ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}),
        workspaceId,
      }
    }
    case 'project.update': {
      if (!uuid(targetId)) return null
      const fields = projectFields(input, { requireOne: true })
      if (!fields) return null
      return {
        authority,
        ...fields,
        operation,
        projectId: targetId,
        workspaceId,
      }
    }
    case 'project.archive':
    case 'project.delete':
      if (!uuid(targetId) || !exactKeys(input, [])) return null
      return { authority, operation, projectId: targetId, workspaceId }
    case 'project.reorder': {
      if (targetId !== null || !exactKeys(input, ['projectIds'])) return null
      const projectIds = input.projectIds
      if (!Array.isArray(projectIds) || projectIds.length === 0 || !projectIds.every(uuid))
        return null
      return { authority, operation, projectIds, workspaceId }
    }
    case 'project.visibility.set': {
      if (!uuid(targetId) || !exactKeys(input, ['visibility'])) return null
      const visibility = input.visibility
      if (visibility !== 'workspace' && visibility !== 'members') return null
      return {
        authority,
        operation,
        projectId: targetId,
        visibility: visibility as ProjectVisibility,
        workspaceId,
      }
    }
    case 'project.member.set': {
      if (!uuid(targetId) || !exactKeys(input, ['projectId', 'role'])) return null
      if (!uuid(input.projectId)) return null
      const role = input.role
      if (role !== 'viewer' && role !== 'editor') return null
      return {
        authority,
        operation,
        projectId: input.projectId,
        role: role as ProjectMemberRole,
        userId: targetId,
        workspaceId,
      }
    }
    case 'project.member.remove': {
      if (!uuid(targetId) || !exactKeys(input, ['projectId'])) return null
      if (!uuid(input.projectId)) return null
      return {
        authority,
        operation,
        projectId: input.projectId,
        userId: targetId,
        workspaceId,
      }
    }
    case 'config.workspace.update': {
      if (targetId !== workspaceId) return null
      const parsed = parseWorkspaceUpdate(input)
      if (!parsed) return null
      return {
        authority,
        expectedVersion: parsed.expectedVersion,
        operation,
        update: parsed.update,
        workspaceId,
      }
    }
    case 'config.workspace.reopen':
      if (targetId !== workspaceId || !exactKeys(input, [])) return null
      return { authority, operation, workspaceId }
    default:
      return null
  }
}

function failureResponse(outcome: Extract<ManagementOutcome<unknown>, { ok: false }>) {
  const status =
    outcome.failure.code === 'forbidden' || outcome.failure.code === 'authority_required'
      ? 403
      : outcome.failure.code === 'stale_revision' || outcome.failure.code === 'conflict'
        ? 409
        : outcome.failure.code === 'unsupported'
          ? 501
          : 503
  return Response.json(
    {
      code: 'LEAD_MANAGEMENT_REFUSED',
      operation: outcome.failure.operation,
      ...(outcome.failure.reason ? { reason: outcome.failure.reason } : {}),
    },
    { status, headers: { 'cache-control': 'private, no-store' } }
  )
}

export function createLeadManagementHandler(dependencies: LeadManagementRouteDependencies) {
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'POST') return unavailable()
      const body = await readBody(request)
      if (body === undefined) return unavailable()
      const decision = await dependencies.verify(request)
      if (!decision) return unavailable()
      const call = parseLeadManagementCall(body, {
        authorityRef: decision.authorityRef,
        intentId: decision.intentId,
        leadAgentId: decision.leadAgentId,
      })
      if (!call) return unavailable()
      const tools: LeadManagementToolsDependencies = {
        consumeDecision: dependencies.consumeDecision,
        operationsFor: dependencies.operationsFor,
        resolveAuthority: async () => decision,
        ...(dependencies.now ? { now: dependencies.now } : {}),
      }
      const outcome = await executeLeadManagementTool(tools, call)
      if (!outcome.ok) return failureResponse(outcome)
      return Response.json(
        {
          operation: outcome.operation,
          schemaVersion: RESULT_SCHEMA_VERSION,
          value: outcome.value,
        },
        { status: 200, headers: { 'cache-control': 'private, no-store' } }
      )
    } catch {
      return unavailable()
    }
  }
}

/**
 * Bounded, process-local replay guard (defense in depth). CP932 owns the
 * durable single-use approval store; this only prevents a replayed decision
 * from executing twice in one warm process while the durable store rejects it
 * upstream.
 */
export function createBoundedDecisionConsumption(maxEntries = 1_024) {
  const consumed = new Set<string>()
  return async (decision: ManagementAuthorityDecision): Promise<boolean> => {
    if (consumed.has(decision.decisionId)) return false
    if (consumed.size >= maxEntries) {
      const oldest = consumed.values().next().value
      if (oldest !== undefined) consumed.delete(oldest)
    }
    consumed.add(decision.decisionId)
    return true
  }
}
