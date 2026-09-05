import "server-only";

import type { WorkspacePrincipalResolution } from "./workspace-principal";
import { workspaceJsonResponse, workspaceUnavailableResponse } from "./workspace-response";
export {
  isContentRefUuid,
  parseContentRefCreateInput,
  parseContentRefUpdateInput,
} from "./content-ref-input";

export function contentRefErrorResponse(
  error: unknown,
  resolution: WorkspacePrincipalResolution,
  request: Request
) {
  const message = error instanceof Error ? error.message : "";
  if (message.endsWith("conflict"))
    return workspaceJsonResponse(
      { code: "content_ref_conflict", message: "Content metadata conflict" },
      resolution,
      request,
      { status: 409 }
    );
  if (message.endsWith("unavailable")) return workspaceUnavailableResponse(request);
  return workspaceJsonResponse(
    { code: "invalid_request", message: "Invalid request" },
    resolution,
    request,
    { status: 400 }
  );
}
