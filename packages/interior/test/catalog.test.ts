import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";
import { interiorPropAssets } from "../src";

const interiorPlantIds = interiorPropAssets
  .filter((asset) => asset.category === "plants")
  .map((asset) => asset.id);

describe("room-designer model boundary", () => {
  test("stores every catalog asset in its configured room-designer folder", () => {
    const assetsRoot = join(import.meta.dir, "../assets");
    const files: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.name.endsWith(".glb")) files.push(relative(assetsRoot, path));
      }
    };
    visit(assetsRoot);

    const catalogFiles = interiorPropAssets.map((asset) =>
      asset.assetUrl.replace("/assets/models/", ""),
    );

    expect(files.sort()).toEqual([...catalogFiles].sort());
    expect(
      interiorPropAssets.every((asset) => {
        const folder = asset.assetUrl.split("/").at(-2);
        if (asset.category === "food-and-drinks") {
          return folder === "food" || folder === "drinks";
        }
        return folder === asset.category;
      }),
    ).toBe(true);

    expect(
      new Set(
        interiorPropAssets
          .filter((asset) => asset.category === "food-and-drinks")
          .map((asset) => asset.assetUrl.split("/").at(-2)),
      ),
    ).toEqual(new Set(["food", "drinks"]));
  });

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

    expect(interiorPropAssets.some((asset) => exteriorIds.has(asset.id))).toBe(false);
  });
});
