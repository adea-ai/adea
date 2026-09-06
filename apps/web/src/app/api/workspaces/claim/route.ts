import type { ApiWorkspaceClaimResponse } from "@adea-ai/api-client";
import { claimTemporaryUserSessionForUser } from "@adea-ai/db";

import { applicationDatabase } from "../../../../server/database";
import {
  desktopTrustedOrigins,
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
  trustedDesktopWorkspaceRequest,
} from "../../../../server/desktop-workspace";
import {
  parseTemporaryCredential,
  digestTemporaryCredential,
} from "../../../../server/temporary-session";
import { resolveWorkspacePrincipal } from "../../../../server/workspace-principal";
import {
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from "../../../../server/workspace-response";

export const runtime = "nodejs";

export function OPTIONS(request: Request) {
  return handleDesktopWorkspacePreflight(request);
}

export async function POST(request: Request) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  if (!trustedDesktopWorkspaceRequest(request, desktopTrustedOrigins())) {
    return workspaceUnavailableResponse(request);
  }

  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution || resolution.temporary) return workspaceUnavailableResponse(request, 401);
  const credential = parseTemporaryCredential(request.headers.get("x-agent-hq-temporary-session"));
  if (!credential) return workspaceUnavailableResponse(request);

  try {
    await claimTemporaryUserSessionForUser(applicationDatabase(), {
      credentialDigest: await digestTemporaryCredential(credential),
      target: resolution.principal,
    });
    const payload: ApiWorkspaceClaimResponse = { claimed: true };
    return workspaceJsonResponse(payload, resolution, request, {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return workspaceUnavailableResponse(request);
  }
}
