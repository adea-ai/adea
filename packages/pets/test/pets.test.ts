import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { petAssetCatalog } from "../src";

const petAssets = resolve(import.meta.dir, "../assets/animals");

describe("pets package catalog", () => {
  test("keeps every packaged pet model with its source asset", () => {
    expect(petAssetCatalog).toHaveLength(7);

    for (const asset of petAssetCatalog) {
      expect(existsSync(resolve(petAssets, asset.file))).toBe(true);
    }
  });

  test("includes the animated pets used by the Home scene", () => {
    expect(petAssetCatalog.map((asset) => asset.id)).toEqual(
      expect.arrayContaining(["dog", "cat"]),
    );
  });
});
