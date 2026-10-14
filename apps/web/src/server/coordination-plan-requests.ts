import {
  createCoordinationPlan,
  readCoordinationPlanJobReferences,
  reviseCoordinationPlan,
} from '@adea-ai/db'

import { conversationErrorResponse, isConversationUuid } from './conversation-request'
import { applicationDatabase } from './database'
import { guardDesktopWorkspaceRequest } from './desktop-workspace'
import { authorizeConversationWrite, authorizeWorkspace } from './workspace-authorization'
import { resolveWorkspacePrincipal } from './workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from './workspace-response'

/*
 * Coordination plans that cite separately owned jobs (M15.03, adea-ai/adea#1217).
 *
 * The actor is always the authenticated principal: no request field names an author. Writes need
 * the same conversation-write authorization as posting a message; the read needs workspace read
 * access. The database then repeats the channel, participation and publication checks under its
 * own locks, so nothing here is the last gate. Every refusal that could tell a caller whether a
 * job, plan, revision or channel exists is the same workspace-unavailable answer.
 */

export type PlanChannelParams = Readonly<{ channelId: string; workspaceId: string }>
export type PlanRevisionParams = PlanChannelParams & Readonly<{ planId: string }>
export type PlanReferencesParams = PlanRevisionParams & Readonly<{ revision: string }>

const NO_STORE = { 'cache-control': 'private, no-store' }
const REVISION = /^[1-9][0-9]{0,9}$/

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function readJobIds(value: unknown): string[] | null {
  // Shape only. Bounds, deduplication and release to the actor are the database's to decide.
  return Array.isArray(value) && value.length <= 200 && value.every(isConversationUuid)
    ? (value as string[])
    : null
}

/** POST …/channels/:channelId/plans — creates a plan at revision 1. */
export async function postCoordinationPlan(request: Request, params: PlanChannelParams) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { channelId, workspaceId } = params
  if (!isConversationUuid(channelId)) return workspaceUnavailableResponse(request)
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeConversationWrite(resolution.principal, workspaceId, { channelId })))
    return workspaceUnavailableResponse(request)
  const idempotencyKey = request.headers.get('idempotency-key')?.trim()
  const body = await readBody(request)
  const jobIds = readJobIds(body?.jobIds)
  if (!idempotencyKey || idempotencyKey.length > 128 || !jobIds)
    return workspaceInvalidRequestResponse(request)
  try {
    const payload = await createCoordinationPlan(
      applicationDatabase(),
      workspaceId,
      channelId,
      resolution.principal,
      { idempotencyKey, jobIds }
    )
    return workspaceJsonResponse(payload, resolution, request, {
      headers: NO_STORE,
      status: 201,
    })
  } catch (error) {
    return conversationErrorResponse(error, resolution, request)
  }
}

/** POST …/plans/:planId/revisions — writes revision `expectedRevision + 1`; a stale writer gets 409. */
export async function postCoordinationPlanRevision(request: Request, params: PlanRevisionParams) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { channelId, planId, workspaceId } = params
  if (!isConversationUuid(channelId) || !isConversationUuid(planId))
    return workspaceUnavailableResponse(request)
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeConversationWrite(resolution.principal, workspaceId, { channelId })))
    return workspaceUnavailableResponse(request)
  const body = await readBody(request)
  const jobIds = readJobIds(body?.jobIds)
  const expectedRevision = body?.expectedRevision
  if (!jobIds || typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision))
    return workspaceInvalidRequestResponse(request)
  try {
    const payload = await reviseCoordinationPlan(
      applicationDatabase(),
      workspaceId,
      channelId,
      planId,
      resolution.principal,
      { expectedRevision, jobIds }
    )
    return workspaceJsonResponse(payload, resolution, request, {
      headers: NO_STORE,
      status: 201,
    })
  } catch (error) {
    return conversationErrorResponse(error, resolution, request)
  }
}

/** GET …/plans/:planId/revisions/:revision/job-references — the safe projection for this reader. */
export async function getCoordinationPlanJobReferences(
  request: Request,
  params: PlanReferencesParams
) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { channelId, planId, revision, workspaceId } = params
  // A malformed path is the same answer as a plan that is not there.
  if (!isConversationUuid(channelId) || !isConversationUuid(planId) || !REVISION.test(revision))
    return workspaceUnavailableResponse(request)
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.read', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  try {
    const payload = await readCoordinationPlanJobReferences(
      applicationDatabase(),
      workspaceId,
      channelId,
      planId,
      Number(revision),
      resolution.principal
    )
    return workspaceJsonResponse(payload, resolution, request, { headers: NO_STORE })
  } catch (error) {
    return conversationErrorResponse(error, resolution, request)
  }
}
