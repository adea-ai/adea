import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { petAssetCatalog } from "../src";

// Binary art lives in the private pack, not the repository. Skip the
// filesystem assertions (not the catalog contract) when it is absent.
const packRoot =
  process.env.AGENT_HQ_ASSETS_DIR ?? resolve(import.meta.dir, "../../../vendor/assets");
const petAssets = resolve(packRoot, "packages/pets/assets/animals");
const assetsPresent = existsSync(petAssets);

describe("pets package catalog", () => {
  test.skipIf(!assetsPresent)("keeps every packaged pet model with its source asset", () => {
    expect(petAssetCatalog).toHaveLength(7);

    for (const asset of petAssetCatalog) {
      expect(existsSync(resolve(petAssets, asset.file))).toBe(true);
    }
  });

  test("includes the animated pets used by the Home scene", () => {
    expect(petAssetCatalog.map((asset) => asset.id)).toEqual(
      expect.arrayContaining(["dog", "cat"])
    );
  });
});
