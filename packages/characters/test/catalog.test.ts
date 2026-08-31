import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  characterIds,
  characterLibraryAssets,
  characterPartAssets,
  getCharacterManifest,
  isCharacterId,
  isCustomCharacterId,
} from "../src";

const characterAssets = resolve(import.meta.dir, "../assets/characters");
const characterPartAssetsDirectory = resolve(import.meta.dir, "../assets/character-parts");

describe("character package catalog", () => {
  test("registers every built-in character with a packaged model", () => {
    expect(characterIds).toHaveLength(2);

    for (const id of characterIds) {
      const manifest = getCharacterManifest(id);
      expect(isCharacterId(id)).toBe(true);
      expect(manifest?.assetUrl).toBeTruthy();
      expect(existsSync(resolve(characterAssets, manifest!.assetUrl.split("/").pop()!))).toBe(true);
    }
  });

  test("catalogues every wearable and character part from the package", () => {
    expect(characterPartAssets).toHaveLength(381);

    for (const asset of characterPartAssets) {
      expect(
        existsSync(
          resolve(characterPartAssetsDirectory, asset.assetUrl.split("character-parts/")[1]),
        ),
      ).toBe(true);
    }
  });

  test("does not expose the removed legacy character set", () => {
    expect(isCustomCharacterId("custom-casual")).toBe(false);
    expect(getCharacterManifest("cashier")).toBeUndefined();
    expect(existsSync(resolve(characterAssets, "1_Cashier.glb"))).toBe(false);
  });

  test("retains complete Cute and Cartoon source-library exports", () => {
    expect(characterLibraryAssets).toHaveLength(3);
    for (const asset of characterLibraryAssets) {
      expect(existsSync(resolve(characterAssets, asset.assetUrl.split("/").pop()!))).toBe(true);
    }
  });
});
