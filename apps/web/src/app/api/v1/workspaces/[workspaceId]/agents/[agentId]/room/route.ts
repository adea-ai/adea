import type { ApiAgentResponse } from "@adea-ai/api-client";
import { assignAgentToRoom } from "@adea-ai/db";
import { applicationDatabase } from "../../../../../../../../server/database";
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from "../../../../../../../../server/desktop-workspace";
import { authorizeWorkspace } from "../../../../../../../../server/workspace-authorization";
import { resolveWorkspacePrincipal } from "../../../../../../../../server/workspace-principal";
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from "../../../../../../../../server/workspace-response";

export const runtime = "nodejs";
export const OPTIONS = handleDesktopWorkspacePreflight;
export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentId: string; workspaceId: string }> }
) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { agentId, workspaceId } = await params;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  if (!(await authorizeWorkspace(resolution.principal, "workspace.update", workspaceId)).allowed)
    return workspaceUnavailableResponse(request);
  let roomId: unknown;
  try {
    roomId = ((await request.json()) as Record<string, unknown>).roomId;
  } catch {
    return workspaceInvalidRequestResponse(request);
  }
  if (roomId !== null && (typeof roomId !== "string" || !roomId.trim()))
    return workspaceInvalidRequestResponse(request);
  try {
    const payload: ApiAgentResponse = {
      agent: await assignAgentToRoom(
        applicationDatabase(),
        workspaceId,
        agentId,
        resolution.principal,
        roomId
      ),
    };
    return workspaceJsonResponse(payload, resolution, request);
  } catch {
    return workspaceUnavailableResponse(request);
  }
}
