import { NextResponse } from "next/server";

import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
  withDesktopWorkspaceCors,
} from "../../../../server/desktop-workspace";
import { authorizeWorkspace } from "../../../../server/workspace-authorization";
import { resolveWorkspacePrincipal } from "../../../../server/workspace-principal";
import {
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from "../../../../server/workspace-response";
import {
  MarketplaceProxyError,
  proxyMarketplaceCatalog,
} from "../../../../server/marketplace-proxy";

export const runtime = "nodejs";

export function OPTIONS(request: Request) {
  return handleDesktopWorkspacePreflight(request);
}

export async function POST(request: Request) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest(request);
  }
  const workspaceId =
    isObject(body) && typeof body.workspaceId === "string" ? body.workspaceId : "";
  if (!workspaceId || workspaceId.length > 256) return invalidRequest(request);
  const authorization = await authorizeWorkspace(
    resolution.principal,
    "workspace.read",
    workspaceId
  );
  if (!authorization.allowed) return workspaceUnavailableResponse(request, 403);
  try {
    const response = await proxyMarketplaceCatalog({
      userId: resolution.principal.userId,
      workspaceId,
    });
    return workspaceJsonResponse(await response.json(), resolution, request, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return proxyError(request, error);
  }
}

function invalidRequest(request: Request) {
  return withDesktopWorkspaceCors(
    NextResponse.json(
      { code: "invalid_request", message: "Invalid marketplace request" },
      { status: 400 }
    ),
    request
  );
}

function proxyError(request: Request, error: unknown) {
  if (error instanceof MarketplaceProxyError)
    return withDesktopWorkspaceCors(
      NextResponse.json({ code: error.code, message: error.message }, { status: error.status }),
      request
    );
  return withDesktopWorkspaceCors(
    NextResponse.json(
      { code: "CONTROL_PLANE_UNAVAILABLE", message: "Control Plane is unavailable" },
      { status: 503 }
    ),
    request
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
