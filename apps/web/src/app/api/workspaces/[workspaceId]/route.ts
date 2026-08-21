import type { ApiWorkspaceResponse } from "@agent-hq/api-client";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const SAFE_WORKSPACE_ID = /^[a-z0-9][a-z0-9_-]*$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params;
  if (!SAFE_WORKSPACE_ID.test(workspaceId)) {
    return NextResponse.json({ error: "Invalid workspace id." }, { status: 400 });
  }

  const response: ApiWorkspaceResponse = {
    workspace: {
      id: workspaceId,
      name: "Agent HQ",
      scene: "home",
      updatedAt: new Date().toISOString(),
    },
    agents: [],
    tasks: [],
  };

  return NextResponse.json(response, {
    headers: { "cache-control": "private, max-age=30" },
  });
}
