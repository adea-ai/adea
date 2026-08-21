import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fenceAssets, foliageAssets, landscapeAssets } from "../src";

const packageAssets = resolve(import.meta.dir, "../assets");

describe("landscape asset catalog", () => {
  test("contains every exterior foliage model", () => {
    expect(foliageAssets).toHaveLength(9);

    for (const asset of foliageAssets) {
      expect(
        existsSync(resolve(packageAssets, "foliage", asset.assetUrl.split("/foliage/")[1])),
      ).toBe(true);
    }
  });

  test("contains reusable fence models outside the room-designer package", () => {
    expect(fenceAssets).toHaveLength(3);

    for (const asset of fenceAssets) {
      expect(existsSync(resolve(packageAssets, "fences", basename(asset.assetUrl)))).toBe(true);
    }
  });

  test("combines foliage and fences into the landscape runtime catalog", () => {
    expect(landscapeAssets).toHaveLength(foliageAssets.length + fenceAssets.length);
  });
});
