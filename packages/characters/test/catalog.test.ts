import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  characterIds,
  characterLibraryAssets,
  cartoonCharacterAssets,
  characterPartAssets,
  getCharacterManifest,
  isCharacterId,
  isCustomCharacterId,
} from "../src";

const characterAssets = resolve(import.meta.dir, "../assets");
const characterPartAssetsDirectory = characterAssets;

interface GlbDocument {
  meshes: readonly unknown[];
  nodes: readonly { mesh?: number; name?: string }[];
  skins: readonly unknown[];
}

function readGlbJson(path: string): GlbDocument {
  const bytes = readFileSync(path);
  expect(bytes.toString("ascii", 0, 4)).toBe("glTF");
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength).trim()) as GlbDocument;
}

describe("character package catalog", () => {
  test("registers every built-in character with a packaged model", () => {
    expect(characterIds).toHaveLength(1);

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
          resolve(characterPartAssetsDirectory, asset.assetUrl.split("/models/")[1]),
        ),
      ).toBe(true);
    }
  });

  test("does not expose the removed legacy character set", () => {
    expect(isCustomCharacterId("custom-casual")).toBe(false);
    expect(getCharacterManifest("cashier")).toBeUndefined();
    expect(existsSync(resolve(characterAssets, "1_Cashier.glb"))).toBe(false);
  });

  test("retains the complete Cute source-library export", () => {
    expect(characterLibraryAssets).toHaveLength(1);
    for (const asset of characterLibraryAssets) {
      expect(existsSync(resolve(characterAssets, asset.assetUrl.split("/").pop()!))).toBe(true);
    }
  });

  test("catalogues every split Cartoon assembled character", () => {
    expect(cartoonCharacterAssets).toHaveLength(25);
    expect(new Set(cartoonCharacterAssets.map((asset) => asset.name)).size).toBe(25);
    expect(new Set(cartoonCharacterAssets.map((asset) => asset.variant))).toEqual(
      new Set(["humanoid"]),
    );

    for (const asset of cartoonCharacterAssets) {
      const path = resolve(characterAssets, asset.assetUrl.split("/models/")[1]);
      expect(existsSync(path)).toBe(
        true,
      );
      const document = readGlbJson(path);
      expect(document.meshes).toHaveLength(1);
      expect(document.skins).toHaveLength(1);
      expect(
        document.nodes.filter((node) => Number.isInteger(node.mesh)).map((node) => node.name),
      ).toEqual([asset.name]);
    }
  });

  test("does not ship the removed Cartoon Standard or all-library assets", () => {
    expect(existsSync(resolve(characterAssets, "cartoon-3-standard-runtime.glb"))).toBe(false);
    expect(existsSync(resolve(characterAssets, "cartoon-3-standard-all.glb"))).toBe(false);
    expect(existsSync(resolve(characterAssets, "cartoon-3-humanoid-all.glb"))).toBe(false);
  });
});
