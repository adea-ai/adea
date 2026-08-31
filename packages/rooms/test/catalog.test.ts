import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { roomAssets } from "../src";

const assetsDirectory = resolve(import.meta.dir, "../assets");

describe("room package catalog", () => {
  test("registers the combined asset library and every standalone room model", () => {
    expect(roomAssets).toHaveLength(189);
    expect(roomAssets[0]).toMatchObject({
      id: "one-file-assets",
      assetUrl: "/assets/models/One_file_assets.glb",
    });

    const standaloneRooms = roomAssets.slice(1);
    expect(standaloneRooms).toHaveLength(188);
    expect(new Set(standaloneRooms.map((asset) => asset.id)).size).toBe(188);

    for (const asset of roomAssets) {
      const relativeAssetPath = asset.assetUrl.replace("/assets/models/", "");
      expect(existsSync(resolve(assetsDirectory, relativeAssetPath))).toBe(true);
    }
  });
});
