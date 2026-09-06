import type { ApiArtifactResponse } from "@adea-ai/api-client";
import { deleteArtifact, getArtifactForUser, setArtifactAvailability } from "@adea-ai/db";

import {
  artifactErrorResponse,
  readArtifactVersion,
} from "../../../../../../../server/artifact-request";
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

const AVAILABILITY = new Set(["pending", "available", "unavailable", "quarantined", "failed"]);

export const runtime = "nodejs";
export const OPTIONS = handleDesktopWorkspacePreflight;
type Context = { params: Promise<{ artifactId: string; workspaceId: string }> };

export async function GET(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { artifactId, workspaceId } = await params;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  if (!(await authorizeWorkspace(resolution.principal, "workspace.read", workspaceId)).allowed)
    return workspaceUnavailableResponse(request);
  const includeDeleted = new URL(request.url).searchParams.get("includeDeleted") === "true";
  const artifact = await getArtifactForUser(
    applicationDatabase(),
    workspaceId,
    artifactId,
    resolution.principal,
    { includeDeleted }
  );
  if (!artifact) return workspaceUnavailableResponse(request);
  const payload: ApiArtifactResponse = { artifact };
  return workspaceJsonResponse(payload, resolution, request, {
    headers: { "cache-control": "private, no-store" },
  });
}

export async function PATCH(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { artifactId, workspaceId } = await params;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  if (!(await authorizeWorkspace(resolution.principal, "workspace.update", workspaceId)).allowed)
    return workspaceUnavailableResponse(request);
  const expectedVersion = readArtifactVersion(request);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return workspaceInvalidRequestResponse(request);
  }
  if (!expectedVersion || !AVAILABILITY.has(String(body.availability)))
    return workspaceInvalidRequestResponse(request);
  try {
    const payload: ApiArtifactResponse = {
      artifact: await setArtifactAvailability(
        applicationDatabase(),
        workspaceId,
        artifactId,
        resolution.principal,
        body.availability as "pending" | "available" | "unavailable" | "quarantined" | "failed",
        expectedVersion
      ),
    };
    return workspaceJsonResponse(payload, resolution, request);
  } catch (error) {
    return artifactErrorResponse(error, resolution, request);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { artifactId, workspaceId } = await params;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  if (!(await authorizeWorkspace(resolution.principal, "workspace.update", workspaceId)).allowed)
    return workspaceUnavailableResponse(request);
  const expectedVersion = readArtifactVersion(request);
  if (!expectedVersion) return workspaceInvalidRequestResponse(request);
  try {
    const payload: ApiArtifactResponse = {
      artifact: await deleteArtifact(
        applicationDatabase(),
        workspaceId,
        artifactId,
        resolution.principal,
        expectedVersion
      ),
    };
    return workspaceJsonResponse(payload, resolution, request);
  } catch (error) {
    return artifactErrorResponse(error, resolution, request);
  }
}
