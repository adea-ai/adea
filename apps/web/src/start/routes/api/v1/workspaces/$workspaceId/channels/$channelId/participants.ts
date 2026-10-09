import { createFileRoute } from '@tanstack/solid-router'
import { withRequestScope } from '../../../../../../../../server/request-scope'
import type { ApiChannelResponse } from '@adea-ai/api-client'
import type {
  ConversationParticipantRef,
  GroupAgentEnlistmentGrant,
  GroupAudienceGrant,
} from '@adea-ai/types'
import {
  getChannelForUser,
  groupCreationCandidatesFromGrants,
  setChannelParticipants,
  setGroupChannelParticipantsWithGrants,
} from '@adea-ai/db'

import {
  conversationErrorResponse,
  parseConversationParticipant,
  parseGroupAudienceGrant,
  parseGroupEnlistmentGrant,
  readConversationVersion,
} from '../../../../../../../../server/conversation-request'
import { applicationDatabase } from '../../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../../server/workspace-response'
async function post(
  request: Request,
  { params }: { params: { channelId: string; workspaceId: string } }
) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { channelId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.update', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  const expectedVersion = readConversationVersion(request)
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (!expectedVersion || !Array.isArray(body?.participants) || body.participants.length > 100)
    return workspaceInvalidRequestResponse(request)
  const participants = body.participants.map(parseConversationParticipant)
  if (participants.some((participant) => !participant))
    return workspaceInvalidRequestResponse(request)
  try {
    const existing = await getChannelForUser(
      applicationDatabase(),
      workspaceId,
      channelId,
      resolution.principal
    )
    if (existing.kind === 'group') {
      // Grant-gated roster replacement: every listed participant must present
      // an explicit grant bound to this group; management authority and grant
      // windows are enforced inside the transaction.
      const audienceInputs = Array.isArray(body.audienceGrants) ? body.audienceGrants : []
      const enlistmentInputs = Array.isArray(body.enlistmentGrants) ? body.enlistmentGrants : []
      if (
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
      const candidates = groupCreationCandidatesFromGrants(workspaceId, {
        audienceGrants,
        enlistmentGrants,
      })
      const granted = new Map(
        candidates.map((candidate) => [
          candidate.kind === 'human'
            ? `user:${candidate.participant.userId}`
            : `agent:${candidate.workspaceId}:${candidate.agentId}`,
          candidate,
        ])
      )
      const roster: typeof candidates = []
      for (const participant of participants as ConversationParticipantRef[]) {
        const key =
          participant.kind === 'user'
            ? `user:${participant.userId}`
            : `agent:${workspaceId}:${participant.agentId}`
        const candidate = granted.get(key)
        if (!candidate) return workspaceInvalidRequestResponse(request)
        roster.push(candidate)
      }
      const replaced = await setGroupChannelParticipantsWithGrants(
        applicationDatabase(),
        workspaceId,
        channelId,
        resolution.principal,
        { candidates: roster, expectedVersion, now: new Date().toISOString() }
      )
      const payload: ApiChannelResponse = { channel: replaced.channel }
      return workspaceJsonResponse(payload, resolution, request)
    }
    const payload: ApiChannelResponse = {
      channel: await setChannelParticipants(
        applicationDatabase(),
        workspaceId,
        channelId,
        resolution.principal,
        participants as never,
        expectedVersion
      ),
    }
    return workspaceJsonResponse(payload, resolution, request)
  } catch (error) {
    return conversationErrorResponse(error, resolution, request)
  }
}
export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/channels/$channelId/participants'
)({
  server: {
    handlers: {
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
