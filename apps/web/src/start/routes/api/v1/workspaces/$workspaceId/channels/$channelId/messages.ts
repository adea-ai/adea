import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import type { ApiMessagePage, ApiMessageResponse } from '@adea-ai/api-client'
import {
  createLeadTurn,
  createMessage,
  getChannelForUser,
  listGroupChannelMessagesForUser,
  listMessagesForUser,
  parseHandoffTarget,
  parseRequestedRoleModelSelections,
  postGroupChannelMessage,
} from '@adea-ai/db'
import { parseLeadTurnMode } from '../../../../../../../../server/lead-turn-request'

import {
  conversationErrorResponse,
  isConversationUuid,
  parseConversationParticipant,
} from '../../../../../../../../server/conversation-request'
import { applicationDatabase } from '../../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../../server/desktop-workspace'
import {
  authorizeConversationWrite,
  authorizeWorkspace,
} from '../../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../../server/workspace-response'

type Context = { params: { channelId: string; workspaceId: string } }
async function get(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { channelId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.read', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  const url = new URL(request.url)
  const afterSequence = url.searchParams.has('afterSequence')
    ? Number(url.searchParams.get('afterSequence'))
    : undefined
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
  const threadRootMessageId = url.searchParams.get('threadRootMessageId') ?? undefined
  if (
    (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) ||
    (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) ||
    (threadRootMessageId !== undefined && !isConversationUuid(threadRootMessageId))
  )
    return workspaceInvalidRequestResponse(request)
  try {
    const channel = await getChannelForUser(
      applicationDatabase(),
      workspaceId,
      channelId,
      resolution.principal
    )
    if (channel.kind === 'group') {
      // Join-point-filtered group history: earlier entries stay held without
      // an explicit audience-aware sharing grant. No caller instant is
      // passed: the shared read evaluates on trusted time it reads itself.
      const payload: ApiMessagePage = await listGroupChannelMessagesForUser(
        applicationDatabase(),
        workspaceId,
        channelId,
        resolution.principal,
        { afterSequence, limit, threadRootMessageId }
      )
      return workspaceJsonResponse(payload, resolution, request, {
        headers: { 'cache-control': 'private, no-store' },
      })
    }
    const payload: ApiMessagePage = await listMessagesForUser(
      applicationDatabase(),
      workspaceId,
      channelId,
      resolution.principal,
      { afterSequence, limit, threadRootMessageId }
    )
    return workspaceJsonResponse(payload, resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    return conversationErrorResponse(error, resolution, request)
  }
}

async function post(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { channelId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeConversationWrite(resolution.principal, workspaceId, { channelId })))
    return workspaceUnavailableResponse(request)
  const idempotencyKey = request.headers.get('idempotency-key')?.trim()
  // Host-mediated channel: a validated Desktop credential proves the request
  // rode the authenticated desktop-host channel (vault-held, PKCE-issued,
  // revocable). Validity is already established above by principal
  // resolution (anything else 401s before admission); this flag only
  // records which validated channel carried it, so target-bearing
  // admissions can require host mediation.
  const hostMediatedChannel = request.headers.get('authorization')?.startsWith('Desktop ') ?? false
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  const hasBodyText = typeof body?.bodyText === 'string' && Boolean(body.bodyText.trim())
  const leadTurnMode = body && !Array.isArray(body) ? parseLeadTurnMode(body) : null
  let handoffTarget
  try {
    handoffTarget = parseHandoffTarget(body?.handoffTarget)
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  // Unverifiable target claims never reach retention: without host
  // mediation the cloud cannot prove session binding, currency, or
  // control, so the request fails closed here (the database enforces
  // the same rule for any other caller).
  if (handoffTarget !== undefined && !hostMediatedChannel)
    return workspaceInvalidRequestResponse(request)
  let requestedModelSelections
  try {
    requestedModelSelections = parseRequestedRoleModelSelections(body?.requestedModelSelections)
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  const hasBodyRef = isConversationUuid(body?.bodyContentRefId)
  const mentions = Array.isArray(body?.mentions)
    ? body.mentions.map(parseConversationParticipant)
    : []
  if (
    !body ||
    leadTurnMode === null ||
    !idempotencyKey ||
    idempotencyKey.length > 128 ||
    hasBodyText === hasBodyRef ||
    (hasBodyText && (body.bodyText as string).length > 100_000) ||
    (body.mentions !== undefined &&
      (!Array.isArray(body.mentions) ||
        body.mentions.length > 64 ||
        mentions.some((value) => !value))) ||
    (body.artifactIds !== undefined &&
      (!Array.isArray(body.artifactIds) ||
        body.artifactIds.length > 64 ||
        !body.artifactIds.every(isConversationUuid))) ||
    [body.taskId, body.replyToMessageId, body.threadRootMessageId]
      .filter((value) => value !== undefined)
      .some((value) => !isConversationUuid(value)) ||
    [body.executionRef, body.externalSessionRef]
      .filter((value) => value !== undefined)
      .some((value) => typeof value !== 'string' || !value.trim() || value.length > 256)
  )
    return workspaceInvalidRequestResponse(request)
  try {
    const channel = await getChannelForUser(
      applicationDatabase(),
      workspaceId,
      channelId,
      resolution.principal
    )
    if (channel.kind === 'group') {
      // ONE shared transaction/fence: the current admission/grant check and
      // the actual message/turn write commit together, so a revocation
      // landing between a separate check and write cannot slip a forbidden
      // turn through. Dispatch and orchestration stay with the turn
      // coordinator; this fence only gates.
      if (leadTurnMode === 'lead') {
        const payload: ApiMessageResponse = await postGroupChannelMessage(
          applicationDatabase(),
          workspaceId,
          channelId,
          resolution.principal,
          resolution.principal,
          {
            lead: {
              ...(Array.isArray(body.artifactIds)
                ? { artifactIds: body.artifactIds as string[] }
                : {}),
              ...(hasBodyRef ? { bodyContentRefId: body.bodyContentRefId as string } : {}),
              ...(hasBodyText ? { bodyText: body.bodyText as string } : {}),
              idempotencyKey,
              mentions: mentions as never,
            },
            mode: 'lead',
          }
        )
        return workspaceJsonResponse(payload, resolution, request, { status: 201 })
      }
      const payload: ApiMessageResponse = {
        message: await postGroupChannelMessage(
          applicationDatabase(),
          workspaceId,
          channelId,
          resolution.principal,
          resolution.principal,
          {
            message: {
              ...(Array.isArray(body.artifactIds)
                ? { artifactIds: body.artifactIds as string[] }
                : {}),
              ...(hasBodyRef ? { bodyContentRefId: body.bodyContentRefId as string } : {}),
              ...(hasBodyText ? { bodyText: body.bodyText as string } : {}),
              ...(typeof body.executionRef === 'string' ? { executionRef: body.executionRef } : {}),
              ...(typeof body.externalSessionRef === 'string'
                ? { externalSessionRef: body.externalSessionRef }
                : {}),
              idempotencyKey,
              mentions: mentions as never,
              ...(isConversationUuid(body.replyToMessageId)
                ? { replyToMessageId: body.replyToMessageId }
                : {}),
              ...(isConversationUuid(body.taskId) ? { taskId: body.taskId } : {}),
              ...(isConversationUuid(body.threadRootMessageId)
                ? { threadRootMessageId: body.threadRootMessageId }
                : {}),
            },
            mode: 'direct',
          }
        ),
      }
      return workspaceJsonResponse(payload, resolution, request, { status: 201 })
    }
    if (leadTurnMode === 'lead') {
      const payload: ApiMessageResponse = await createLeadTurn(
        applicationDatabase(),
        workspaceId,
        channelId,
        resolution.principal,
        {
          ...(Array.isArray(body.artifactIds) ? { artifactIds: body.artifactIds as string[] } : {}),
          ...(hasBodyRef ? { bodyContentRefId: body.bodyContentRefId as string } : {}),
          ...(hasBodyText ? { bodyText: body.bodyText as string } : {}),
          ...(handoffTarget ? { handoffTarget } : {}),
          idempotencyKey,
          ...(requestedModelSelections ? { requestedModelSelections } : {}),
          mentions: mentions as never,
        },
        { hostMediated: hostMediatedChannel }
      )
      return workspaceJsonResponse(payload, resolution, request, { status: 201 })
    }
    const payload: ApiMessageResponse = {
      message: await createMessage(
        applicationDatabase(),
        workspaceId,
        channelId,
        resolution.principal,
        {
          ...(Array.isArray(body.artifactIds) ? { artifactIds: body.artifactIds as string[] } : {}),
          ...(hasBodyRef ? { bodyContentRefId: body.bodyContentRefId as string } : {}),
          ...(hasBodyText ? { bodyText: body.bodyText as string } : {}),
          ...(typeof body.executionRef === 'string' ? { executionRef: body.executionRef } : {}),
          ...(typeof body.externalSessionRef === 'string'
            ? { externalSessionRef: body.externalSessionRef }
            : {}),
          idempotencyKey,
          mentions: mentions as never,
          ...(isConversationUuid(body.replyToMessageId)
            ? { replyToMessageId: body.replyToMessageId }
            : {}),
          sender: resolution.principal,
          ...(isConversationUuid(body.taskId) ? { taskId: body.taskId } : {}),
          ...(isConversationUuid(body.threadRootMessageId)
            ? { threadRootMessageId: body.threadRootMessageId }
            : {}),
        }
      ),
    }
    return workspaceJsonResponse(payload, resolution, request, { status: 201 })
  } catch (error) {
    return conversationErrorResponse(error, resolution, request)
  }
}
export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/channels/$channelId/messages'
)({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => get(request, { params })),
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
