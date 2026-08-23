import { describe, expect, test } from "bun:test";
import { checkRuntimeReports, checkStaticBudgets } from "./performance-budgets.mjs";

const budgets = {
  routeFirstLoadJsBytes: { "/": 700_000 },
  publicAssetBytes: 160_000_000,
  sceneLoadMs: 10_000,
  sceneTransferBytes: 35_000_000,
  runtimeP95FrameMs: 30,
};

describe("performance budgets", () => {
  test("accepts the current static build measurements", () => {
    expect(
      checkStaticBudgets(
        {
          routes: [{ route: "/", firstLoadUncompressedJsBytes: 571_063 }],
          publicAssetBytes: 153_091_489,
        },
        budgets,
      ),
    ).toEqual([]);
  });

  test("reports route and asset regressions with actionable messages", () => {
    expect(
      checkStaticBudgets(
        {
          routes: [{ route: "/", firstLoadUncompressedJsBytes: 700_001 }],
          publicAssetBytes: 160_000_001,
        },
        budgets,
      ),
    ).toEqual([
      "route / first-load JavaScript is 700001 bytes (budget 700000)",
      "public assets are 160000001 bytes (budget 160000000)",
    ]);
  });

  test("rejects runtime errors, slow loads, large transfers, and long frames", () => {
    expect(
      checkRuntimeReports(
        [
          {
            event: "load",
            scene: "Home",
            milestones: { playableCharacterMs: 10_001 },
            network: { transferBytes: 35_000_001 },
            runtime: { p95FrameMs: 30.1 },
          },
          {
            event: "runtime",
            scene: "Home",
            network: { transferBytes: 35_000_001 },
            runtime: { p95FrameMs: 30.1 },
          },
          { event: "error", scene: "Home", error: "webgl_context_lost" },
        ],
        budgets,
      ),
    ).toEqual([
      "Home playable scene time is 10001ms (budget 10000)",
      "Home p95 frame time is 30.1ms (budget 30)",
      "Home p95 frame time is 30.1ms (budget 30)",
      "Home emitted error: webgl_context_lost",
      "Home asset transfer is 35000001 bytes (budget 35000000)",
    ]);
  });

  test("requires both load and runtime reports for each scene", () => {
    expect(checkRuntimeReports([{ event: "load", scene: "Home" }], budgets)).toEqual([
      "Home is missing a runtime performance report",
    ]);
  });
});
