import { describe, expect, test } from "bun:test";
import type { AgentSummary } from "@agent-hq/types";

import { agentStatusModel } from "../../src/agent-status";

const agent: AgentSummary = {
  createdAt: "2026-08-30T00:00:00.000Z",
  id: "agent-1",
  lifecycleState: "active",
  name: "Planner",
  presentationMetadata: {},
  profile: { id: "general", state: "available", version: "1" },
  updatedAt: "2026-08-30T00:00:00.000Z",
  workspaceId: "workspace-1",
};

describe("truthful Agent status model", () => {
  test("never infers runtime or working state from persisted existence", () => {
    const status = agentStatusModel(agent);
    expect(status.configuration.label).toBe("Configured");
    expect(status.runtime.label).toBe("Runtime unknown");
    expect(status.execution.label).toBe("Activity unknown");
    expect(JSON.stringify(status)).not.toMatch(/online|working/i);
  });

  test("keeps profile problems on the configuration axis", () => {
    expect(
      agentStatusModel({ ...agent, profile: { ...agent.profile, state: "missing" } }).configuration
        .label
    ).toBe("Needs configuration");
  });
});
