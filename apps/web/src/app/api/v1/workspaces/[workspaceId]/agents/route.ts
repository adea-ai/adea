import type { ApiAgentCreateInput, ApiAgentResponse } from "@agent-hq/api-client";
import { createAgent, listAgentsForUser } from "@agent-hq/db";
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
  return workspaceJsonResponse(
    await listAgentsForUser(applicationDatabase(), workspaceId, resolution.principal),
    resolution,
    request,
    { headers: { "cache-control": "private, no-store" } }
  );
}

export async function POST(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { workspaceId } = await params;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  if (!(await authorizeWorkspace(resolution.principal, "workspace.update", workspaceId)).allowed)
    return workspaceUnavailableResponse(request);
  let input: ApiAgentCreateInput;
  try {
    input = (await request.json()) as ApiAgentCreateInput;
  } catch {
    return workspaceInvalidRequestResponse(request);
  }
  if (
    !input ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    typeof input.profileId !== "string" ||
    !input.profileId.trim() ||
    typeof input.profileVersion !== "string" ||
    !input.profileVersion.trim()
  )
    return workspaceInvalidRequestResponse(request);
  const payload: ApiAgentResponse = {
    agent: await createAgent(applicationDatabase(), workspaceId, resolution.principal, input),
  };
  return workspaceJsonResponse(payload, resolution, request, { status: 201 });
}
