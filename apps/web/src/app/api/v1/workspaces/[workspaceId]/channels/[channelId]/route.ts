import type { ApiChannelResponse } from "@adea-ai/api-client";
import { archiveChannel, getChannelForUser, updateChannel } from "@adea-ai/db";

import {
  conversationErrorResponse,
  isConversationUuid,
  readConversationVersion,
} from "../../../../../../../server/conversation-request";
import { applicationDatabase } from "../../../../../../../server/database";
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from "../../../../../../../server/desktop-workspace";
import { authorizeWorkspace } from "../../../../../../../server/workspace-authorization";
import { resolveWorkspacePrincipal } from "../../../../../../../server/workspace-principal";
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from "../../../../../../../server/workspace-response";

export const runtime = "nodejs";
export const OPTIONS = handleDesktopWorkspacePreflight;
type Context = { params: Promise<{ channelId: string; workspaceId: string }> };

async function resolutionFor(
  request: Request,
  workspaceId: string,
  permission: "workspace.read" | "workspace.update"
) {
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return null;
  if (!(await authorizeWorkspace(resolution.principal, permission, workspaceId)).allowed)
    return null;
  return resolution;
}

export async function GET(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { channelId, workspaceId } = await params;
  const resolution = await resolutionFor(request, workspaceId, "workspace.read");
  if (!resolution) return workspaceUnavailableResponse(request);
  try {
    const payload: ApiChannelResponse = {
      channel: await getChannelForUser(
        applicationDatabase(),
        workspaceId,
        channelId,
        resolution.principal
      ),
    };
    return workspaceJsonResponse(payload, resolution, request, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return conversationErrorResponse(error, resolution, request);
  }
}

export async function PATCH(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { channelId, workspaceId } = await params;
  const resolution = await resolutionFor(request, workspaceId, "workspace.update");
  if (!resolution) return workspaceUnavailableResponse(request);
  const expectedVersion = readConversationVersion(request);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return workspaceInvalidRequestResponse(request);
  }
  if (
    !expectedVersion ||
    !body ||
    !Object.keys(body).length ||
    (body.title !== undefined &&
      (typeof body.title !== "string" || !body.title.trim() || body.title.length > 120)) ||
    (body.visibility !== undefined &&
      !["workspace", "participants"].includes(String(body.visibility))) ||
    (body.taskId !== undefined && body.taskId !== null && !isConversationUuid(body.taskId))
  )
    return workspaceInvalidRequestResponse(request);
  try {
    const payload: ApiChannelResponse = {
      channel: await updateChannel(
        applicationDatabase(),
        workspaceId,
        channelId,
        resolution.principal,
        body as never,
        expectedVersion
      ),
    };
    return workspaceJsonResponse(payload, resolution, request);
  } catch (error) {
    return conversationErrorResponse(error, resolution, request);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { channelId, workspaceId } = await params;
  const resolution = await resolutionFor(request, workspaceId, "workspace.update");
  if (!resolution) return workspaceUnavailableResponse(request);
  const expectedVersion = readConversationVersion(request);
  if (!expectedVersion) return workspaceInvalidRequestResponse(request);
  try {
    const payload: ApiChannelResponse = {
      channel: await archiveChannel(
        applicationDatabase(),
        workspaceId,
        channelId,
        resolution.principal,
        expectedVersion
      ),
    };
    return workspaceJsonResponse(payload, resolution, request);
  } catch (error) {
    return conversationErrorResponse(error, resolution, request);
  }
}
