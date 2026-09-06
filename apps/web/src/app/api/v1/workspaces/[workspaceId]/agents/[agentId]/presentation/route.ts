import type { ApiAgentPresentationInput, ApiAgentResponse } from "@adea/api-client";
import { updateAgentPresentation } from "@adea/db";
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
export async function PATCH(
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
  let input: ApiAgentPresentationInput;
  try {
    input = (await request.json()) as ApiAgentPresentationInput;
  } catch {
    return workspaceInvalidRequestResponse(request);
  }
  if (!input || Object.keys(input).length === 0 || input.name === "")
    return workspaceInvalidRequestResponse(request);
  try {
    const payload: ApiAgentResponse = {
      agent: await updateAgentPresentation(
        applicationDatabase(),
        workspaceId,
        agentId,
        resolution.principal,
        input
      ),
    };
    return workspaceJsonResponse(payload, resolution, request);
  } catch {
    return workspaceUnavailableResponse(request);
  }
}
