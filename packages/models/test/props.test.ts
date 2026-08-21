import { describe, expect, test } from "bun:test";
import { modelsInteriorPropAssets } from "../src";

const interiorPlantIds = modelsInteriorPropAssets
  .filter((asset) => asset.category === "plants")
  .map((asset) => asset.id);

describe("room-designer model boundary", () => {
  test("keeps only interior pots and plants in the plants category", () => {
    expect(interiorPlantIds).toEqual([
      "models-plants-05",
      "models-plants-15",
      "models-plants-19",
      "models-casino-flower-03",
    ]);
  });

  test("does not expose exterior foliage or fence models", () => {
    const exteriorIds = new Set([
      "models-bush-06",
      "models-bush-07",
      "models-bush-10",
      "models-palm-03",
      "models-casino-fence-07",
      "models-casino-fence-08",
      "models-casino-fence-09",
    ]);

    expect(modelsInteriorPropAssets.some((asset) => exteriorIds.has(asset.id))).toBe(false);
  });
});
