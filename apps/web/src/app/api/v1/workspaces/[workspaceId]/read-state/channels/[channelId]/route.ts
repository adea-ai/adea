import type { ApiReadStateResponse } from "@adea-ai/api-client";
import { markChannelReadState } from "@adea-ai/db";

import { applicationDatabase } from "../../../../../../../../server/database";
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from "../../../../../../../../server/desktop-workspace";
import {
  parseReadStateInput,
  readStateErrorResponse,
} from "../../../../../../../../server/read-state-request";
import { isUuid } from "../../../../../../../../server/task-request";
import { authorizeWorkspace } from "../../../../../../../../server/workspace-authorization";
import { resolveWorkspacePrincipal } from "../../../../../../../../server/workspace-principal";
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from "../../../../../../../../server/workspace-response";

export const runtime = "nodejs";
export const OPTIONS = handleDesktopWorkspacePreflight;
type Context = { params: Promise<{ channelId: string; workspaceId: string }> };

export async function POST(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { channelId, workspaceId } = await params;
  if (!isUuid(channelId)) return workspaceUnavailableResponse(request);
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  if (!(await authorizeWorkspace(resolution.principal, "workspace.update", workspaceId)).allowed)
    return workspaceUnavailableResponse(request);
  let input;
  try {
    input = parseReadStateInput(await request.json());
  } catch {
    return workspaceInvalidRequestResponse(request);
  }
  if (!input) return workspaceInvalidRequestResponse(request);
  try {
    const payload: ApiReadStateResponse = {
      readState: await markChannelReadState(
        applicationDatabase(),
        workspaceId,
        channelId,
        resolution.principal,
        input.action,
        input.lastReadSequence
      ),
    };
    return workspaceJsonResponse(payload, resolution, request);
  } catch (error) {
    return readStateErrorResponse(error, resolution, request);
  }
}
