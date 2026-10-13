import { randomUUID } from 'node:crypto'

import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../server/request-scope'
import type { ApiChannelResponse } from '@adea-ai/api-client'
import type { GroupAudienceGrant, GroupAgentEnlistmentGrant } from '@adea-ai/types'
import {
  createDirectAgentChannel,
  createDirectAgentTopic,
  createGroupChannelWithGrants,
  createProjectChannel,
  groupCreationCandidatesFromGrants,
  listChannelsForUser,
} from '@adea-ai/db'

import {
  conversationErrorResponse,
  isConversationUuid,
  parseGroupAudienceGrant,
  parseGroupEnlistmentGrant,
} from '../../../../../../server/conversation-request'
import { applicationDatabase } from '../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../server/workspace-response'

type Context = { params: { workspaceId: string } }
async function get(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.read', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  return workspaceJsonResponse(
    await listChannelsForUser(applicationDatabase(), workspaceId, resolution.principal),
    resolution,
    request,
    { headers: { 'cache-control': 'private, no-store' } }
  )
}

async function post(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.update', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  const idempotencyKey = request.headers.get('idempotency-key')?.trim()
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (
    !body ||
    !idempotencyKey ||
    idempotencyKey.length > 128 ||
    !['project', 'direct_agent', 'group'].includes(String(body.kind)) ||
    typeof body.title !== 'string' ||
    !body.title.trim() ||
    body.title.length > 120 ||
    (body.taskId !== undefined && !isConversationUuid(body.taskId))
  )
    return workspaceInvalidRequestResponse(request)
  try {
    let channel
    if (body.kind === 'project') {
      if (!isConversationUuid(body.projectId)) return workspaceInvalidRequestResponse(request)
      channel = await createProjectChannel(
        applicationDatabase(),
        workspaceId,
        body.projectId,
        resolution.principal,
        {
          idempotencyKey,
          ...(isConversationUuid(body.taskId) ? { taskId: body.taskId } : {}),
          title: body.title,
        }
      )
    } else if (body.kind === 'direct_agent') {
      if (
        !isConversationUuid(body.agentId) ||
        (body.mode !== undefined && body.mode !== 'new_topic') ||
        Object.keys(body).some((key) => !['kind', 'mode', 'agentId', 'title'].includes(key))
      )
        return workspaceInvalidRequestResponse(request)
      if (body.mode === 'new_topic') {
        channel = await createDirectAgentTopic(
          applicationDatabase(),
          workspaceId,
          body.agentId,
          resolution.principal,
          { idempotencyKey, title: body.title }
        )
      } else {
        if (idempotencyKey !== `direct-agent:${body.agentId}`)
          return workspaceInvalidRequestResponse(request)
        channel = await createDirectAgentChannel(
          applicationDatabase(),
          workspaceId,
          body.agentId,
          resolution.principal
        )
      }
    } else {
      // Grant-gated groups: task bindings are rejected (groups isolate from
      // task authority), the creator is founded explicitly, and every extra
      // participant needs an explicit grant already bound to the new group.
      if (
        body.taskId !== undefined ||
        Object.keys(body).some(
          (key) =>
            !['kind', 'title', 'channelId', 'audienceGrants', 'enlistmentGrants'].includes(key)
        )
      )
        return workspaceInvalidRequestResponse(request)
      const channelId =
        body.channelId !== undefined
          ? isConversationUuid(body.channelId)
            ? (body.channelId as string)
            : null
          : randomUUID()
      const audienceInputs = Array.isArray(body.audienceGrants) ? body.audienceGrants : []
      const enlistmentInputs = Array.isArray(body.enlistmentGrants) ? body.enlistmentGrants : []
      if (
        channelId === null ||
        (!Array.isArray(body.audienceGrants) && body.audienceGrants !== undefined) ||
        (!Array.isArray(body.enlistmentGrants) && body.enlistmentGrants !== undefined) ||
        audienceInputs.length + enlistmentInputs.length > 100
      )
        return workspaceInvalidRequestResponse(request)
      const audienceGrants: GroupAudienceGrant[] = []
      for (const input of audienceInputs) {
        const grant = parseGroupAudienceGrant(input)
        if (!grant || grant.groupId !== channelId) return workspaceInvalidRequestResponse(request)
        audienceGrants.push(grant)
      }
      const enlistmentGrants: GroupAgentEnlistmentGrant[] = []
      for (const input of enlistmentInputs) {
        const grant = parseGroupEnlistmentGrant(input)
        if (!grant || grant.groupId !== channelId) return workspaceInvalidRequestResponse(request)
        enlistmentGrants.push(grant)
      }
      const issuedAt = new Date().toISOString()
      const created = await createGroupChannelWithGrants(
        applicationDatabase(),
        workspaceId,
        resolution.principal,
        {
          candidates: groupCreationCandidatesFromGrants(workspaceId, {
            audienceGrants: [
              {
                expiresAt: null,
                grantId: `founder-${resolution.principal.userId}`,
                groupId: channelId,
                issuedAt,
                participant: resolution.principal,
                revision: 1,
                revokedAt: null,
              },
              ...audienceGrants,
            ],
            enlistmentGrants,
          }),
          channelId,
          idempotencyKey,
          now: issuedAt,
          title: body.title,
        }
      )
      channel = created.channel
    }
    const payload: ApiChannelResponse = { channel }
    return workspaceJsonResponse(payload, resolution, request, { status: 201 })
  } catch (error) {
    return conversationErrorResponse(error, resolution, request)
  }
}
export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/channels')({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => get(request, { params })),
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
