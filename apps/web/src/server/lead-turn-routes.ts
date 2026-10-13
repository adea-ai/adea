import 'server-only'
import { applicationDatabase } from './database'
import { isConversationUuid } from './conversation-request'
import { guardDesktopWorkspaceRequest } from './desktop-workspace'
import { authorizeWorkspace } from './workspace-authorization'
import { resolveWorkspacePrincipal } from './workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from './workspace-response'
import { configuredLeadTurnProductDependencies, createLeadTurnProduct } from './lead-turn-product'

export type LeadTurnOperation = 'prepare' | 'dispatch' | 'status' | 'progress' | 'cancel' | 'latest'
/** Public commands contain no authority, payer, model, project or session fields. */
export async function handleLeadTurnRequest(
  request: Request,
  params: Readonly<{ workspaceId: string; intentId?: string; channelId?: string }>,
  operation: LeadTurnOperation
) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  if (
    !isConversationUuid(params.workspaceId) ||
    (operation === 'latest'
      ? !isConversationUuid(params.channelId)
      : !isConversationUuid(params.intentId))
  )
    return workspaceUnavailableResponse(request)
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const mutation = ['prepare', 'dispatch', 'cancel'].includes(operation)
  if (
    !(
      await authorizeWorkspace(
        resolution.principal,
        mutation ? 'runtime.invoke' : 'workspace.read',
        params.workspaceId
      )
    ).allowed
  )
    return workspaceUnavailableResponse(request)
  if (mutation) {
    try {
      const text = await request.text()
      if (text.length > 512) return workspaceInvalidRequestResponse(request)
      const body = JSON.parse(text)
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
        return workspaceInvalidRequestResponse(request)
    } catch {
      return workspaceInvalidRequestResponse(request)
    }
  }
  const url = new URL(request.url)
  const afterSequence = Number(url.searchParams.get('afterSequence') ?? 0)
  const targetSessionId = url.searchParams.get('targetSessionId') ?? undefined
  if (
    targetSessionId !== undefined &&
    (operation !== 'latest' || !targetSessionId.trim() || targetSessionId.trim().length > 256)
  )
    return workspaceInvalidRequestResponse(request)
  if (
    (operation === 'progress' && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) ||
    [...url.searchParams.keys()].some(
      (key) =>
        (operation !== 'progress' || key !== 'afterSequence') &&
        (operation !== 'latest' || key !== 'targetSessionId')
    )
  )
    return workspaceInvalidRequestResponse(request)
  try {
    const database = applicationDatabase()
    const service = createLeadTurnProduct(
      database,
      await configuredLeadTurnProductDependencies(database, params.workspaceId, request)
    )
    const scope = {
      workspaceId: params.workspaceId,
      intentId: params.intentId!,
      userId: resolution.principal.userId,
    }
    const payload =
      operation === 'latest'
        ? {
            leadTurn:
              targetSessionId === undefined
                ? await service.latest(params.workspaceId, params.channelId!, scope.userId)
                : await service.latestForTarget(
                    params.workspaceId,
                    params.channelId!,
                    targetSessionId.trim(),
                    scope.userId
                  ),
          }
        : operation === 'progress'
          ? await service.progress(scope, afterSequence)
          : { leadTurn: await service[operation](scope) }
    return workspaceJsonResponse(payload, resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch {
    // Neither provider errors nor canonical body/query details enter the public error.
    return workspaceUnavailableResponse(request)
  }
}
