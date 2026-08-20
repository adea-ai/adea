import { NextResponse } from "next/server";

import { agentFixtures } from "@/features/agents/agent-types";

export function GET() {
  return NextResponse.json(agentFixtures);
}
