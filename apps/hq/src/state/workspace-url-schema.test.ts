import { describe, expect, it } from "vitest";

import { workspaceUrlParsers } from "./workspace-url-schema";

describe("workspace URL state", () => {
  it("accepts supported scene and camera values", () => {
    expect(workspaceUrlParsers.scene.parse("hq-work")).toBe("hq-work");
    expect(workspaceUrlParsers.camera.parse("perspective")).toBe("perspective");
  });

  it("rejects unsupported values and keeps stable defaults", () => {
    expect(workspaceUrlParsers.scene.parse("not-a-scene")).toBeNull();
    expect(workspaceUrlParsers.camera.parse("top-down")).toBeNull();
    expect(workspaceUrlParsers.scene.defaultValue).toBe("hq-home");
    expect(workspaceUrlParsers.camera.defaultValue).toBe("orthographic");
  });
});
