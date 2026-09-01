// Agent HQ character catalog backed by the converted Cartoon Characters packs.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  registerCharacterProvider,
  type CharacterManifest,
  type CharacterProvider,
  type LoadedCharacter,
  type LoadedCharacterAnimations,
} from "./provider";
import { characterPartAssets, characterPartIds } from "./customization";

const assetRoot = "/assets/models";

export const characterIds = ["cartoon-humanoid"] as const;
export type CharacterId = (typeof characterIds)[number];

export const characterLabels: Record<CharacterId, string> = {
  "cartoon-humanoid": "Cartoon",
};

export const characterIconUrls: Partial<Record<CharacterId, string>> = {};

/** Complete Cute source-library export kept for future character customization work. */
export const characterLibraryAssets = [
  {
    id: "cute-characters-library",
    label: "Cute Characters Library",
    assetUrl: `${assetRoot}/Cute_Characters.glb`,
  },
] as const;

export const cartoonCharacterNames = [
  "f_1",
  "f_10",
  "f_11",
  "f_12",
  "f_2",
  "f_3",
  "f_4",
  "f_5",
  "f_6",
  "f_7",
  "f_8",
  "f_9",
  "m_10",
  "m_1",
  "m_11",
  "m_12",
  "m_13",
  "m_2",
  "m_3",
  "m_4",
  "m_5",
  "m_6",
  "m_7",
  "m_8",
  "m_9",
] as const;

export const cartoonCharacterAssets = (["humanoid"] as const).flatMap((variant) =>
  cartoonCharacterNames.map((name) => ({
    id: `cartoon-${variant}-${name}`,
    label: `Cartoon ${variant} ${name}`,
    variant,
    name,
    assetUrl: `${assetRoot}/_complete/${name}.glb`,
  }))
);

const characterFiles: Record<CharacterId, string> = {
  "cartoon-humanoid": "runtime.glb",
};

const animationMap: Record<string, string> = {
  idle: "Idle",
  walk: "Walk",
  run: "Run",
  jump: "Song Jump",
  doubleJump: "Song Jump",
  swim: "Walk",
};

export function isCharacterId(value: string | undefined): value is CharacterId {
  return value !== undefined && characterIds.includes(value as CharacterId);
}

export const customCharacterIds: readonly string[] = [];
export type CustomCharacterId = string;

export function isCustomCharacterId(_value: string | undefined): boolean {
  return false;
}

export function getCustomCharacterLabel(_id: string): string | undefined {
  return undefined;
}

export const allCharacterIds: readonly string[] = [...characterIds];

export { characterPartAssets, characterPartIds };
export type { CharacterPartId } from "./customization";

function getManifest(id: string): CharacterManifest | undefined {
  if (!isCharacterId(id)) return undefined;
  return {
    id,
    label: characterLabels[id],
    assetUrl: `${assetRoot}/${characterFiles[id]}`,
  };
}

const embeddedClipsCache = new Map<string, readonly THREE.AnimationClip[]>();

async function loadCatalogCharacter(loader: GLTFLoader, id: string): Promise<LoadedCharacter> {
  const manifest = getManifest(id);
  if (!manifest) throw new Error(`Unknown character: ${id}`);
  const gltf = await loader.loadAsync(manifest.assetUrl);
  embeddedClipsCache.set(id, gltf.animations);
  return { scene: gltf.scene, clips: gltf.animations };
}

async function loadCatalogCharacterAnimations(
  loader: GLTFLoader,
  id: string,
  keys: readonly string[],
): Promise<LoadedCharacterAnimations> {
  const manifest = getManifest(id);
  if (!manifest) return { clips: [], names: {} };
  const embedded =
    embeddedClipsCache.get(id) ?? (await loader.loadAsync(manifest.assetUrl)).animations;
  embeddedClipsCache.set(id, embedded);
  const clips: THREE.AnimationClip[] = [];
  const names: Record<string, string> = {};
  for (const key of keys) {
    const source = embedded.find((clip) => clip.name === animationMap[key]);
    if (!source) continue;
    const clip = source.clone();
    clip.name = key;
    clips.push(clip);
    names[key] = key;
  }
  return { clips, names };
}

const characterProvider: CharacterProvider = {
  characterIds: allCharacterIds,
  getManifest,
  loadCharacter: loadCatalogCharacter,
  loadAnimatedCharacter: loadCatalogCharacter,
  loadCharacterAnimations: loadCatalogCharacterAnimations,
};

registerCharacterProvider(characterProvider);
