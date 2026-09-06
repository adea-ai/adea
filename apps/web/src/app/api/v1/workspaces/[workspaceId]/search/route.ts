import { searchWorkspaceForUser } from "@adea-ai/db";

import { applicationDatabase } from "../../../../../../server/database";
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from "../../../../../../server/desktop-workspace";
import { isUuid } from "../../../../../../server/task-request";
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
  const parameters = new URL(request.url).searchParams;
  const query = parameters.get("q") ?? "";
  const channelId = parameters.get("channelId") ?? undefined;
  const limit = parameters.has("limit") ? Number(parameters.get("limit")) : undefined;
  const offset = parameters.has("offset") ? Number(parameters.get("offset")) : undefined;
  if (
    (channelId !== undefined && !isUuid(channelId)) ||
    (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) ||
    (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > 5_000))
  )
    return workspaceInvalidRequestResponse(request);
  try {
    return workspaceJsonResponse(
      await searchWorkspaceForUser(
        applicationDatabase(),
        workspaceId,
        resolution.principal,
        query,
        {
          ...(channelId ? { channelId } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
        }
      ),
      resolution,
      request,
      { headers: { "cache-control": "private, no-store" } }
    );
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("unavailable"))
      return workspaceUnavailableResponse(request);
    return workspaceInvalidRequestResponse(request);
  }
}
