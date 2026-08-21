import { describe, expect, test } from "bun:test";
import { getOrthographicGroundHalfExtents } from "../src/camera-controller";

describe("orthographic ground framing", () => {
  test("accounts for the top-down pitch when fitting a map inside the viewport", () => {
    const extents = getOrthographicGroundHalfExtents({
      halfHeight: 10.5,
      aspect: 1280 / 720,
      zoom: 1,
      viewDirectionY: Math.sin(-0.9),
    });

    expect(extents.halfWidth).toBeCloseTo(18.667, 2);
    expect(extents.halfDepth).toBeCloseTo(13.404, 2);
  });
});
