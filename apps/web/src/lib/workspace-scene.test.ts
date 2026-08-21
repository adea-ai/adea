import { describe, expect, test } from "bun:test";

import { hqSceneFromSearchParams } from "./workspace-scene";

describe("hqSceneFromSearchParams", () => {
  test("defaults the unified workspace to Home", () => {
    expect(hqSceneFromSearchParams({})).toBe("home");
  });

  test("selects Work only for the explicit work query", () => {
    expect(hqSceneFromSearchParams({ scene: "work" })).toBe("work");
  });

  test("falls back to Home for unknown scene values", () => {
    expect(hqSceneFromSearchParams({ scene: "office" })).toBe("home");
  });
});
