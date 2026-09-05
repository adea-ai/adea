import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  backgroundAssets,
  fenceAssets,
  foliageAssets,
  landscapeAssets,
  landscapeHorizonBackgrounds,
} from "../src";

const packRoot =
  process.env.AGENT_HQ_ASSETS_DIR ?? resolve(import.meta.dir, "../../../vendor/assets");
const packageAssets = resolve(packRoot, "packages/landscape/assets");
const assetsPresent = existsSync(packageAssets);

describe("landscape asset catalog", () => {
  test.skipIf(!assetsPresent)("contains every exterior foliage model", () => {
    expect(foliageAssets).toHaveLength(9);

    for (const asset of foliageAssets) {
      expect(
        existsSync(resolve(packageAssets, "foliage", asset.assetUrl.split("/foliage/")[1]))
      ).toBe(true);
    }
  });

  test.skipIf(!assetsPresent)(
    "contains reusable fence models outside the room-designer package",
    () => {
      expect(fenceAssets).toHaveLength(3);

      for (const asset of fenceAssets) {
        expect(existsSync(resolve(packageAssets, "fences", basename(asset.assetUrl)))).toBe(true);
      }
    }
  );

  test("combines foliage and fences into the landscape runtime catalog", () => {
    expect(landscapeAssets).toHaveLength(foliageAssets.length + fenceAssets.length);
  });

  test.skipIf(!assetsPresent)("keeps every downloaded horizon background available", () => {
    expect(backgroundAssets).toHaveLength(8);
    for (const asset of backgroundAssets) {
      expect(existsSync(resolve(packageAssets, "backgrounds", basename(asset.assetUrl)))).toBe(
        true
      );
    }
    expect(landscapeHorizonBackgrounds).toEqual({
      home: "/assets/models/backgrounds/background_seasons_3.jpg",
      work: "/assets/models/backgrounds/background_urban_4.jpg",
    });
  });
});
