import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";
import { interiorPropAssets } from "../src";

const interiorPlantIds = interiorPropAssets
  .filter((asset) => asset.category === "plants")
  .map((asset) => asset.id);

describe("room-designer model boundary", () => {
  test("normalizes legacy asset names and merges wall decor into wall art", () => {
    const expectedAssetUrls = {
      "models-casino-keyboard": "/assets/models/electronics/keyboard_01.glb",
      "models-casino-neon-sign": "/assets/models/wall-art/neon_sign_01.glb",
      "models-exercise-bike-01": "/assets/models/fitness/exercise_bike_01.glb",
      "models-fridge-01": "/assets/models/kitchen/fridge_01.glb",
      "models-microwave-01": "/assets/models/kitchen/microwave_01.glb",
      "models-mixer-08": "/assets/models/kitchen/mixer_08.glb",
      "models-picture-08": "/assets/models/wall-art/picture_067.glb",
      "models-picture-17": "/assets/models/wall-art/picture_068.glb",
      "models-picture-21": "/assets/models/wall-art/picture_069.glb",
    } as const;

    for (const [id, assetUrl] of Object.entries(expectedAssetUrls)) {
      expect(interiorPropAssets.find((asset) => asset.id === id)?.assetUrl).toBe(assetUrl);
    }

    expect(interiorPropAssets.find((asset) => asset.id === "models-exercise-bike-01")?.category).toBe(
      "fitness",
    );
    expect(interiorPropAssets.find((asset) => asset.id === "models-fridge-01")?.category).toBe(
      "kitchen",
    );
    expect(interiorPropAssets.find((asset) => asset.id === "models-microwave-01")?.category).toBe(
      "kitchen",
    );
    expect(interiorPropAssets.find((asset) => asset.id === "models-mixer-08")?.category).toBe(
      "kitchen",
    );

    expect(interiorPropAssets.some((asset) => asset.category === "wall-decor")).toBe(false);
    expect(interiorPropAssets.every((asset) => asset.assetUrl === asset.assetUrl.toLowerCase())).toBe(
      true,
    );
  });

  test("keeps every packaged interior asset filename lowercase", () => {
    const assetsRoot = join(import.meta.dir, "../assets");
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else expect(entry.name).toBe(entry.name.toLowerCase());
      }
    };

    visit(assetsRoot);
  });

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
    expect(interiorPlantIds).toEqual(
      expect.arrayContaining([
        "models-plants-05",
        "models-plants-15",
        "models-plants-19",
        "models-casino-flower-03",
      ]),
    );
    expect(interiorPlantIds.filter((id) => id.startsWith("expanded-")).length).toBe(37);
  });

  test("separates functional interior families into designer categories", () => {
    for (const category of [
      "bathroom",
      "kitchen",
      "entertainment",
      "recreation",
      "rugs",
      "retail",
      "fitness",
      "kids",
      "wall-art",
    ]) {
      expect(interiorPropAssets.some((asset) => asset.category === category)).toBe(true);
    }

    expect(
      interiorPropAssets.find((asset) => asset.id === "expanded-electronics-001")?.category,
    ).toBe("electronics");
    expect(
      interiorPropAssets.find((asset) => asset.id === "expanded-entertainment-001")?.category,
    ).toBe("entertainment");
    expect(interiorPropAssets.find((asset) => asset.id === "expanded-tv-wall-001")?.category).toBe(
      "electronics",
    );

    expect(interiorPropAssets.find((asset) => asset.id === "expanded-carpet-001")?.category).toBe(
      "rugs",
    );
    expect(interiorPropAssets.find((asset) => asset.id === "expanded-shop-001")?.category).toBe(
      "retail",
    );
    expect(interiorPropAssets.find((asset) => asset.id === "expanded-picture-001")?.category).toBe(
      "wall-art",
    );
    expect(
      interiorPropAssets.find((asset) => asset.id === "expanded-training-item-001")?.category,
    ).toBe("fitness");
    expect(interiorPropAssets.find((asset) => asset.id === "expanded-for-kids-001")?.category).toBe(
      "kids",
    );
  });

  test("keeps migrated source families in their dedicated categories", () => {
    const migratedFamilies = {
      carpet: "rugs",
      shop: "retail",
      picture: "wall-art",
      training_item: "fitness",
      for_kids: "kids",
    } as const;

    for (const [family, category] of Object.entries(migratedFamilies)) {
      const familyAssets = interiorPropAssets.filter((asset) =>
        asset.id.startsWith(`expanded-${family.replaceAll("_", "-")}-`),
      );
      expect(familyAssets.length).toBeGreaterThan(0);
      expect(familyAssets.every((asset) => asset.category === category)).toBe(true);
      expect(familyAssets.every((asset) => asset.assetUrl.includes(`/models/${category}/`))).toBe(
        true,
      );
    }
  });

  test("does not expose architecture or curtain assets to the room designer", () => {
    expect(interiorPropAssets.some((asset) => asset.category === "architecture")).toBe(false);
    expect(interiorPropAssets.some((asset) => asset.assetUrl.includes("/architecture/"))).toBe(false);
    expect(interiorPropAssets.some((asset) => asset.assetUrl.includes("/curtains/"))).toBe(false);
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
