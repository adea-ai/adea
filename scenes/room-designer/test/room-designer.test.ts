import { describe, expect, test } from "bun:test";
import { hasPlacementResetTarget, type RoomDesignerPlacement } from "../src/room-designer";

const placement = (overrides: Partial<RoomDesignerPlacement> = {}): RoomDesignerPlacement => ({
  id: "desk-1",
  modelId: "desk",
  p: [1, 2, 3],
  q: [0, 0, 0, 1],
  s: [1, 1, 1],
  ...overrides,
});

describe("room designer reset targets", () => {
  test("does not offer reset for an unchanged saved item", () => {
    const current = placement();

    expect(hasPlacementResetTarget(current, [placement()])).toBe(false);
  });

  test("offers reset when a saved item was moved or rotated", () => {
    const saved = placement();

    expect(hasPlacementResetTarget(placement({ p: [2, 2, 3] }), [saved])).toBe(true);
    expect(hasPlacementResetTarget(placement({ q: [0, 0.7, 0, 0.7] }), [saved])).toBe(true);
  });

  test("does not offer reset for a newly added item", () => {
    expect(hasPlacementResetTarget(placement(), [])).toBe(false);
  });
});
