import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

// Binary art lives in the private pack, not the repository. Skip the
// filesystem assertions (not the catalog contract) when it is absent.
const packRoot =
  process.env.AGENT_HQ_ASSETS_DIR ?? resolve(import.meta.dir, "../../../vendor/assets");
const assetsDirectory = resolve(packRoot, "packages/architecture/assets");
const assetsPresent = existsSync(assetsDirectory);
const categoryFileCounts = {
  columns: 1,
  curtains: 29,
  doors: 26,
  floors: 19,
  partitions: 117,
  stairs: 105,
  walls: 161,
  windows: 37,
} as const;

describe("architecture asset package", () => {
  test.skipIf(!assetsPresent)("keeps each architecture family in its own category folder", () => {
    expect(readdirSync(assetsDirectory).sort()).toEqual(Object.keys(categoryFileCounts).sort());

    for (const [category, expectedCount] of Object.entries(categoryFileCounts)) {
      const files = readdirSync(join(assetsDirectory, category));
      expect(files.every((file) => file.endsWith(".glb"))).toBe(true);
      expect(files).toHaveLength(expectedCount);
    }
  });
});
