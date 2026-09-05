import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { roomAssets } from "../src";

// Binary art lives in the private pack, not the repository. Skip the
// filesystem assertions (not the catalog contract) when it is absent.
const packRoot =
  process.env.AGENT_HQ_ASSETS_DIR ?? resolve(import.meta.dir, "../../../vendor/assets");
const assetsDirectory = resolve(packRoot, "packages/rooms/assets");
const assetsPresent = existsSync(assetsDirectory);

describe("room package catalog", () => {
  test("registers the combined asset library and every standalone room model", () => {
    expect(roomAssets).toHaveLength(189);
    expect(roomAssets[0]).toMatchObject({
      id: "global-assets",
      assetUrl: "/assets/models/global_assets.glb",
    });

    const standaloneRooms = roomAssets.slice(1);
    expect(standaloneRooms).toHaveLength(188);
    expect(new Set(standaloneRooms.map((asset) => asset.id)).size).toBe(188);
  });

  test.skipIf(!assetsPresent)("every catalog asset exists in the pack", () => {
    for (const asset of roomAssets) {
      const relativeAssetPath = asset.assetUrl.replace("/assets/models/", "");
      expect(existsSync(resolve(assetsDirectory, relativeAssetPath))).toBe(true);
    }
  });
});
