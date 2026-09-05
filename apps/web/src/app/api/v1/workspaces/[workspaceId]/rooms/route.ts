import type { ApiRoomCreateInput, ApiRoomResponse } from "@agent-hq/api-client";
import { createRoom, listRoomsForUser } from "@agent-hq/db";

import { applicationDatabase } from "../../../../../../server/database";
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from "../../../../../../server/desktop-workspace";
import { authorizeWorkspace } from "../../../../../../server/workspace-authorization";
import { resolveWorkspacePrincipal } from "../../../../../../server/workspace-principal";
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from "../../../../../../server/workspace-response";

export const runtime = "nodejs";

export function OPTIONS(request: Request) {
  return handleDesktopWorkspacePreflight(request);
}

export async function GET(
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
    "workspace.read",
    workspaceId
  );
  if (!authorization.allowed) return workspaceUnavailableResponse(request);
  const result = await listRoomsForUser(applicationDatabase(), workspaceId, resolution.principal);
  return workspaceJsonResponse(result, resolution, request, {
    headers: { "cache-control": "private, no-store" },
  });
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
  const candidate = body as Record<string, unknown>;
  const input: ApiRoomCreateInput = {
    functionKey: typeof candidate.functionKey === "string" ? candidate.functionKey.trim() : "",
    name: typeof candidate.name === "string" ? candidate.name.trim() : "",
    ...(typeof candidate.layoutRef === "string" ? { layoutRef: candidate.layoutRef.trim() } : {}),
    ...(typeof candidate.spatialRef === "string"
      ? { spatialRef: candidate.spatialRef.trim() }
      : {}),
    ...(typeof candidate.templateKey === "string"
      ? { templateKey: candidate.templateKey.trim() }
      : {}),
  };
  if (
    !input.name ||
    input.name.length > 80 ||
    !input.functionKey ||
    input.functionKey.length > 80
  ) {
    return workspaceInvalidRequestResponse(request);
  }
  const payload: ApiRoomResponse = {
    room: await createRoom(applicationDatabase(), workspaceId, resolution.principal, input),
  };
  return workspaceJsonResponse(payload, resolution, request, { status: 201 });
}
