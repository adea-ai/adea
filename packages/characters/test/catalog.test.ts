import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  characterIds,
  characterPartAssets,
  getCharacterManifest,
  isCharacterId,
  isCustomCharacterId,
} from "../src";

const characterAssets = resolve(import.meta.dir, "../assets/characters");
const characterPartAssetsDirectory = resolve(import.meta.dir, "../assets/character-parts");

describe("character package catalog", () => {
  test("registers every built-in character with a packaged model", () => {
    expect(characterIds).toHaveLength(5);

    for (const id of characterIds) {
      const manifest = getCharacterManifest(id);
      expect(isCharacterId(id)).toBe(true);
      expect(manifest?.assetUrl).toBeTruthy();
      expect(existsSync(resolve(characterAssets, basename(manifest!.assetUrl)))).toBe(true);
    }
  });

  test("catalogues every wearable and character part from the package", () => {
    expect(characterPartAssets).toHaveLength(30);

    for (const asset of characterPartAssets) {
      expect(existsSync(resolve(characterPartAssetsDirectory, basename(asset.assetUrl)))).toBe(
        true,
      );
    }
  });

  test("accepts custom character presets through the character package", () => {
    expect(isCustomCharacterId("custom-casual")).toBe(true);
    expect(getCharacterManifest("custom-casual")?.assetUrl).toBe("");
  });
});
