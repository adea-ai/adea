import { describe, expect, test } from "bun:test";
import { ROOM_GALLERY_BOUNDS } from "@agent-hq/interior";
import { hqBoundaryColliders } from "../src/components/hq-room-scene";

describe("HQ perimeter collision", () => {
  test("blocks the full front fence, including the gate opening", () => {
    const frontSpans = hqBoundaryColliders
      .filter((collider) => Math.abs(collider.z - ROOM_GALLERY_BOUNDS.zMax) < 0.001)
      .map(({ x, halfExtents: [halfWidth] }) => [x - halfWidth, x + halfWidth] as const)
      .sort(([left], [right]) => left - right);

    let coveredThrough = ROOM_GALLERY_BOUNDS.xMin;
    for (const [start, end] of frontSpans) {
      if (start > coveredThrough) break;
      coveredThrough = Math.max(coveredThrough, end);
    }

    expect(coveredThrough).toBeGreaterThanOrEqual(ROOM_GALLERY_BOUNDS.xMax);
  });
});
