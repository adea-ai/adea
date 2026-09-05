import type { ApiMessageResponse } from "@agent-hq/api-client";
import { deleteMessage, editMessage, getMessageForUser } from "@agent-hq/db";

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
type Context = { params: Promise<{ messageId: string; workspaceId: string }> };

export async function GET(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { messageId, workspaceId } = await params;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  if (!(await authorizeWorkspace(resolution.principal, "workspace.read", workspaceId)).allowed)
    return workspaceUnavailableResponse(request);
  try {
    const payload: ApiMessageResponse = {
      message: await getMessageForUser(
        applicationDatabase(),
        workspaceId,
        messageId,
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
  const { messageId, workspaceId } = await params;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  if (!(await authorizeWorkspace(resolution.principal, "workspace.update", workspaceId)).allowed)
    return workspaceUnavailableResponse(request);
  const expectedVersion = readConversationVersion(request);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return workspaceInvalidRequestResponse(request);
  }
  const hasBodyText = typeof body?.bodyText === "string" && Boolean(body.bodyText.trim());
  const hasBodyRef = isConversationUuid(body?.bodyContentRefId);
  if (
    !expectedVersion ||
    hasBodyText === hasBodyRef ||
    (hasBodyText && (body.bodyText as string).length > 100_000)
  )
    return workspaceInvalidRequestResponse(request);
  try {
    const payload: ApiMessageResponse = {
      message: await editMessage(
        applicationDatabase(),
        workspaceId,
        messageId,
        resolution.principal,
        {
          ...(hasBodyRef ? { bodyContentRefId: body.bodyContentRefId as string } : {}),
          ...(hasBodyText ? { bodyText: body.bodyText as string } : {}),
        },
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
  const { messageId, workspaceId } = await params;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  if (!(await authorizeWorkspace(resolution.principal, "workspace.update", workspaceId)).allowed)
    return workspaceUnavailableResponse(request);
  const expectedVersion = readConversationVersion(request);
  if (!expectedVersion) return workspaceInvalidRequestResponse(request);
  try {
    const payload: ApiMessageResponse = {
      message: await deleteMessage(
        applicationDatabase(),
        workspaceId,
        messageId,
        resolution.principal,
        expectedVersion
      ),
    };
    return workspaceJsonResponse(payload, resolution, request);
  } catch (error) {
    return conversationErrorResponse(error, resolution, request);
  }
}
