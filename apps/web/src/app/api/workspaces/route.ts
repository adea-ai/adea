import type { ApiWorkspaceCreateResponse } from "@agent-hq/api-client";
import { createWorkspaceWithOwner, listWorkspacesForUser } from "@agent-hq/db";
import type { WorkspaceSceneId } from "@agent-hq/types";

import { applicationDatabase } from "../../../server/database";
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from "../../../server/desktop-workspace";
import { authorizeWorkspace } from "../../../server/workspace-authorization";
import { resolveWorkspacePrincipal } from "../../../server/workspace-principal";
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from "../../../server/workspace-response";

export const runtime = "nodejs";

export function OPTIONS(request: Request) {
  return handleDesktopWorkspacePreflight(request);
}

export async function GET(request: Request) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  const workspaces = await listWorkspacesForUser(applicationDatabase(), resolution.principal);
  return workspaceJsonResponse(workspaces, resolution, request, {
    headers: { "cache-control": "private, no-store" },
  });
}

export async function POST(request: Request) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  const authorization = await authorizeWorkspace(resolution.principal, "workspace.create", null);
  if (!authorization.allowed) return workspaceUnavailableResponse(request);

  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return workspaceInvalidRequestResponse(request);
  }
  const candidate = body as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const scene = candidate.scene === undefined ? "home" : candidate.scene;
  if (
    !idempotencyKey ||
    idempotencyKey.length > 128 ||
    !name ||
    name.length > 80 ||
    (scene !== "home" && scene !== "work")
  ) {
    return workspaceInvalidRequestResponse(request);
  }

  const created = await createWorkspaceWithOwner(applicationDatabase(), {
    idempotencyKey,
    name,
    owner: resolution.principal,
    scene: scene as WorkspaceSceneId,
  });
  const payload: ApiWorkspaceCreateResponse = created;
  return workspaceJsonResponse(payload, resolution, request, {
    status: created.created ? 201 : 200,
  });
}
