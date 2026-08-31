import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { roomAssets } from "../src";

const assetsDirectory = resolve(import.meta.dir, "../assets/rooms");

describe("room package catalog", () => {
  test("registers every converted and standalone room model", () => {
    expect(roomAssets).toHaveLength(36);
    for (const asset of roomAssets) {
      expect(existsSync(resolve(assetsDirectory, asset.assetUrl.split("/").pop()!))).toBe(true);
    }
  });
});
