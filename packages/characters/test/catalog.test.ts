import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  characterIds,
  characterLibraryAssets,
  referenceCharacterAssets,
  referenceCharacterIds,
  characterPartAssets,
  characterPartName,
  characterPartsBySlot,
  configurableCharacterId,
  getCharacterManifest,
  getCharacterLibraryAssetUrl,
  updateCharacterConfiguration,
  isCharacterId,
  isCustomCharacterId,
  normalizeInPlaceLocomotionClip,
} from "../src";
import { characterPartOffsets } from "../src/generated-part-offsets";
import { createDefaultCharacterConfiguration } from "../src/configuration";
import { loadCharacter } from "../src/runtime";

const characterAssets = resolve(import.meta.dir, "../assets");

function previewPart(id: string): THREE.SkinnedMesh {
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.name = characterPartName(id);
  return mesh;
}

function createPreviewConfiguration() {
  return {
    version: 1 as const,
    body: "body-body-01",
    ears: null,
    face: null,
    hair: "hair-hairstyle-female-01",
    hat: null,
    top: null,
    bottom: null,
    shoes: null,
    socks: null,
    glasses: null,
    gloves: null,
    accessory: null,
    costume: null,
  };
}

interface GlbDocument {
  meshes: readonly {
    primitives?: readonly {
      attributes?: Record<string, number>;
    }[];
  }[];
  materials?: readonly unknown[];
  nodes: readonly {
    mesh?: number;
    name?: string;
    skin?: number;
    children?: readonly number[];
    translation?: readonly number[];
  }[];
  skins?: readonly { joints?: readonly number[] }[];
  scenes?: readonly { nodes?: readonly number[] }[];
  animations?: readonly { name?: string }[];
}

function readGlbJson(path: string): GlbDocument {
  const bytes = readFileSync(path);
  expect(bytes.toString("ascii", 0, 4)).toBe("glTF");
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength).trim()) as GlbDocument;
}

describe("character package catalog", () => {
  test("registers the configurable character with a packaged model", () => {
    expect(characterIds[0]).toBe(configurableCharacterId);
    expect(referenceCharacterIds).toHaveLength(25);
    expect(characterIds).toHaveLength(26);
    const manifest = getCharacterManifest(configurableCharacterId);
    const referenceManifest = getCharacterManifest("f_1");

    expect(isCharacterId(configurableCharacterId)).toBe(true);
    expect(isCharacterId("f_1")).toBe(true);
    expect(manifest?.assetUrl).toBe("/assets/models/characters.glb");
    expect(referenceManifest?.assetUrl).toBe("/assets/models/_complete/f_1.glb");
    expect(existsSync(resolve(characterAssets, "characters.glb"))).toBe(true);
    expect(referenceCharacterAssets).toHaveLength(referenceCharacterIds.length);
  });

  test("uses compact runtime variants for the built-in character configurations", () => {
    expect(getCharacterLibraryAssetUrl("default")).toBe("/assets/models/characters-default.glb");
    expect(getCharacterLibraryAssetUrl("researcher")).toBe(
      "/assets/models/characters-researcher.glb"
    );
    expect(getCharacterLibraryAssetUrl("builder")).toBe("/assets/models/characters-builder.glb");
    expect(getCharacterLibraryAssetUrl("character:v1:unknown")).toBe(
      "/assets/models/characters.glb"
    );
    expect(existsSync(resolve(characterAssets, "characters-default.glb"))).toBe(true);
    expect(existsSync(resolve(characterAssets, "characters-researcher.glb"))).toBe(true);
    expect(existsSync(resolve(characterAssets, "characters-builder.glb"))).toBe(true);

    for (const [file, partCount] of [
      ["characters-default.glb", 7],
      ["characters-researcher.glb", 11],
      ["characters-builder.glb", 9],
    ] as const) {
      const variant = readGlbJson(resolve(characterAssets, file));
      expect(variant.meshes).toHaveLength(partCount);
      expect(variant.skins).toHaveLength(partCount);
      expect(variant.nodes.filter((node) => node.skin != null)).toHaveLength(partCount);
    }
  });

  test("loads arbitrary saved configurations from the full character library", async () => {
    const requestedUrls: string[] = [];
    const loader = {
      loadAsync: async (url: string) => {
        requestedUrls.push(url);
        return { scene: new THREE.Group(), animations: [] };
      },
    } as unknown as GLTFLoader;
    const configuration = {
      ...createDefaultCharacterConfiguration(),
      body: "body-body-09" as const,
    };

    await loadCharacter(loader, configurableCharacterId, configuration);

    expect(requestedUrls).toEqual(["/assets/models/characters.glb"]);
  });

  test("updates a preview in place without removing alternate wearable meshes", () => {
    const configuration = createPreviewConfiguration();
    const root = new THREE.Group();
    const body = previewPart(configuration.body);
    const firstHair = previewPart("hair-hairstyle-female-01");
    const secondHair = previewPart("hair-hairstyle-male-01");
    const unknownHelper = previewPart("body-body-01");
    unknownHelper.name = "body_1305";
    root.add(body, firstHair, secondHair, unknownHelper);

    updateCharacterConfiguration(root, configuration);
    expect(body.visible).toBe(true);
    expect(firstHair.visible).toBe(true);
    expect(secondHair.visible).toBe(false);
    expect(unknownHelper.parent).toBeNull();

    updateCharacterConfiguration(root, {
      ...configuration,
      hair: "hair-hairstyle-male-01",
    });
    expect(firstHair.visible).toBe(false);
    expect(secondHair.visible).toBe(true);
  });

  test("catalogues every wearable and character part", () => {
    expect(characterPartAssets).toHaveLength(378);
    expect(new Set(characterPartAssets.map((asset) => asset.id)).size).toBe(378);
    expect(Object.keys(characterPartOffsets)).toHaveLength(characterPartAssets.length);
    expect(characterPartAssets.every((asset) => characterPartOffsets[asset.id])).toBe(true);
    expect(characterPartsBySlot("ears")).toHaveLength(16);
    expect(characterPartsBySlot("ears").every((part) => part.file.startsWith("ears/"))).toBe(true);
    expect(characterPartsBySlot("costume")).toHaveLength(51);
    expect(characterPartsBySlot("costume").every((part) => part.file.startsWith("costume/"))).toBe(
      true
    );
    expect(characterPartsBySlot("accessory").every((part) => !part.file.includes("/Ears_"))).toBe(
      true
    );

    for (const asset of characterPartAssets) {
      expect(existsSync(resolve(characterAssets, asset.assetUrl.split("/models/")[1]))).toBe(true);
    }
  });

  test("exposes presets while keeping reference characters out of the runtime catalog", () => {
    expect(isCustomCharacterId("default")).toBe(true);
    expect(getCharacterManifest("default")?.assetUrl).toBe("/assets/models/characters.glb");
    expect(isCustomCharacterId("custom-casual")).toBe(false);
    expect(getCharacterManifest("cashier")).toBeUndefined();
    expect(
      referenceCharacterAssets.every((asset) =>
        existsSync(resolve(characterAssets, asset.assetUrl.split("/models/")[1]))
      )
    ).toBe(true);

    const referenceDirectory = resolve(characterAssets, "_complete");
    expect(existsSync(resolve(referenceDirectory, "f_1.glb"))).toBe(true);
    expect(existsSync(resolve(referenceDirectory, "m_13.glb"))).toBe(true);
  });

  test("retains the character and animation libraries", () => {
    expect(characterLibraryAssets).toEqual([
      {
        id: "characters-library",
        label: "Characters Library",
        assetUrl: "/assets/models/characters.glb",
      },
    ]);

    const animationDocument = readGlbJson(resolve(characterAssets, "runtime.glb"));
    expect(animationDocument.animations).toHaveLength(29);
    const animationNames = new Set(
      animationDocument.animations?.map((animation) => animation.name)
    );
    expect(
      ["Idle_Relaxed", "Walk_Forward", "Run_Forward", "Jump_Start", "Jump_Loop", "Jump_End"].every(
        (name) => animationNames.has(name)
      )
    ).toBe(true);
    expect(animationDocument.meshes?.length ?? 0).toBeGreaterThan(0);
    expect(animationDocument.skins?.length ?? 0).toBeGreaterThan(0);
    expect(animationDocument.skins?.every((skin) => skin.joints?.length === 44)).toBe(true);
  });

  test("removes horizontal root motion from locomotion clips", () => {
    const clip = new THREE.AnimationClip("Run_Forward", 1, [
      new THREE.VectorKeyframeTrack(
        "Hips.position",
        [0, 0.5, 1],
        [0, 0.3, 0, 0, 0.4, 0.6, 0, 0.3, 1.2]
      ),
      new THREE.VectorKeyframeTrack("Spine.position", [0, 1], [0, 0, 0, 0, 0.1, 0]),
    ]);

    const normalized = normalizeInPlaceLocomotionClip(clip);
    const hipsTrack = normalized.tracks.find((track) => track.name === "Hips.position");
    const spineTrack = normalized.tracks.find((track) => track.name === "Spine.position");

    expect(Array.from(hipsTrack!.values)).toEqual(
      Array.from(new Float32Array([0, 0.3, 0, 0, 0.4, 0, 0, 0.3, 0]))
    );
    expect(Array.from(spineTrack!.values)).toEqual(
      Array.from(new Float32Array([0, 0, 0, 0, 0.1, 0]))
    );
    expect(Array.from(clip.tracks[0]!.values)).toEqual(
      Array.from(new Float32Array([0, 0.3, 0, 0, 0.4, 0.6, 0, 0.3, 1.2]))
    );
  });

  test("keeps the runtime library skinned to the shared 44-bone rig", () => {
    const library = readGlbJson(resolve(characterAssets, "characters.glb"));
    expect(library.scenes?.[0]?.nodes?.map((nodeId) => library.nodes[nodeId]?.name)).toEqual([
      "Skeleton_01",
    ]);
    const skeletonNodeId = library.nodes.findIndex((node) => node.name === "Skeleton_01");
    expect(
      library.nodes[skeletonNodeId]?.children?.map((nodeId) => library.nodes[nodeId]?.name)
    ).toContain("Root");
    expect(library.skins?.length ?? 0).toBeGreaterThan(0);
    expect(library.skins?.every((skin) => skin.joints?.length === 44)).toBe(true);
    const visibleNodeIds = new Set<number>();
    const visit = (nodeId: number) => {
      if (visibleNodeIds.has(nodeId)) return;
      visibleNodeIds.add(nodeId);
      library.nodes[nodeId]?.children?.forEach(visit);
    };
    library.scenes?.[0]?.nodes?.forEach(visit);
    expect(
      [...visibleNodeIds].filter((nodeId) => library.nodes[nodeId]?.skin != null)
    ).toHaveLength(378);
  });
});
