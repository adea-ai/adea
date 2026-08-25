import type { ApiWorkspaceResponse } from "@agent-hq/api-client";
import { getWorkspaceForUser } from "@agent-hq/db";

import { applicationDatabase } from "../../../../server/database";
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from "../../../../server/desktop-workspace";
import { authorizeWorkspace } from "../../../../server/workspace-authorization";
import { resolveWorkspacePrincipal } from "../../../../server/workspace-principal";
import {
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from "../../../../server/workspace-response";

export const runtime = "nodejs";

export function OPTIONS(request: Request) {
  return handleDesktopWorkspacePreflight(request);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { workspaceId } = await params;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  const authorization = await authorizeWorkspace(
    resolution.principal,
    "workspace.read",
    workspaceId,
  );
  if (!authorization.allowed) return workspaceUnavailableResponse(request);

  const workspace = await getWorkspaceForUser(
    applicationDatabase(),
    workspaceId,
    resolution.principal,
  );
  if (!workspace) return workspaceUnavailableResponse(request);

  const response: ApiWorkspaceResponse = {
    workspace,
    agents: [],
    tasks: [],
  };

  return workspaceJsonResponse(response, resolution, request, {
    headers: { "cache-control": "private, no-store" },
  });
}
