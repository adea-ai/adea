import { describe, expect, test } from "bun:test";

import { artifactQueryKeys } from "../../src";

describe("Artifact query contracts", () => {
  test("keeps metadata caches workspace scoped", () => {
    expect(artifactQueryKeys.list("workspace-a")).not.toEqual(
      artifactQueryKeys.list("workspace-b")
    );
    expect(artifactQueryKeys.detail("workspace-a", "artifact-1")).toEqual([
      "workspaces",
      "workspace-a",
      "artifacts",
      "detail",
      "artifact-1",
    ]);
  });
});
