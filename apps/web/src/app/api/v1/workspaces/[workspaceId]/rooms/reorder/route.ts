import { reorderRooms } from "@adea-ai/db";

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

export function OPTIONS(request: Request) {
  return handleDesktopWorkspacePreflight(request);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { workspaceId } = await params;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  const authorization = await authorizeWorkspace(
    resolution.principal,
    "workspace.update",
    workspaceId
  );
  if (!authorization.allowed) return workspaceUnavailableResponse(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return workspaceInvalidRequestResponse(request);
  }
  const roomIds = (body as Record<string, unknown>).roomIds;
  if (!Array.isArray(roomIds) || roomIds.some((id) => typeof id !== "string" || !id.trim())) {
    return workspaceInvalidRequestResponse(request);
  }
  try {
    const rooms = await reorderRooms(
      applicationDatabase(),
      workspaceId,
      resolution.principal,
      roomIds
    );
    return workspaceJsonResponse(rooms, resolution, request);
  } catch (error) {
    if (error instanceof Error && error.message === "Room order conflict") {
      return workspaceInvalidRequestResponse(request);
    }
    throw error;
  }
}
