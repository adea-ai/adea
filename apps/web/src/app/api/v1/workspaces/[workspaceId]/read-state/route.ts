import type { ApiReadStateResponse } from "@agent-hq/api-client";
import { listReadStateForUser, markAllChannelsRead } from "@agent-hq/db";

import { applicationDatabase } from "../../../../../../server/database";
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from "../../../../../../server/desktop-workspace";
import { readStateErrorResponse } from "../../../../../../server/read-state-request";
import { authorizeWorkspace } from "../../../../../../server/workspace-authorization";
import { resolveWorkspacePrincipal } from "../../../../../../server/workspace-principal";
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from "../../../../../../server/workspace-response";

export const runtime = "nodejs";
export const OPTIONS = handleDesktopWorkspacePreflight;
type Context = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { workspaceId } = await params;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  if (!(await authorizeWorkspace(resolution.principal, "workspace.read", workspaceId)).allowed)
    return workspaceUnavailableResponse(request);
  try {
    const payload: ApiReadStateResponse = {
      readState: await listReadStateForUser(
        applicationDatabase(),
        workspaceId,
        resolution.principal
      ),
    };
    return workspaceJsonResponse(payload, resolution, request, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return readStateErrorResponse(error, resolution, request);
  }
}

export async function POST(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { workspaceId } = await params;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  if (!(await authorizeWorkspace(resolution.principal, "workspace.update", workspaceId)).allowed)
    return workspaceUnavailableResponse(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return workspaceInvalidRequestResponse(request);
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    (body as Record<string, unknown>).action !== "read_all"
  )
    return workspaceInvalidRequestResponse(request);
  try {
    const payload: ApiReadStateResponse = {
      readState: await markAllChannelsRead(
        applicationDatabase(),
        workspaceId,
        resolution.principal
      ),
    };
    return workspaceJsonResponse(payload, resolution, request);
  } catch (error) {
    return readStateErrorResponse(error, resolution, request);
  }
}
