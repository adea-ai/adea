// models character system for HQ.
//
// The Casino pack ships rigged characters with all animations embedded in a
// single GLB (22 clips for Adult-rig characters, 14 for the Plus-size rig).
// The Creative Character pack ships individual body/clothing parts that share
// the same 44-joint skeleton. This module registers a CharacterProvider that
// handles both:
//
// 1. Pre-built Casino characters (cashier, security, showgirl, gambler,
//    high-roller) — loaded directly from their GLB with embedded animations.
// 2. Custom assembled characters (custom-casual, custom-streetwear, etc.) —
//    built from Creative Character parts and animated with Casino rig clips.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  registerCharacterProvider,
  type CharacterManifest,
  type CharacterProvider,
  type LoadedCharacter,
  type LoadedCharacterAnimations,
} from "@agent-hq/characters";
import {
  assembleModelsCharacter,
  loadModelsAnimationClips,
  modelsCustomCharacterPresets,
} from "./custom-characters";

const assetRoot = "/assets/models/characters";

// --- Casino characters (pre-built) ------------------------------------------
export const modelsCharacterIds = [
  "cashier",
  "security",
  "showgirl",
  "gambler",
  "high-roller",
] as const;
export type ModelsCharacterId = (typeof modelsCharacterIds)[number];

export const modelsCharacterLabels: Record<ModelsCharacterId, string> = {
  cashier: "Cashier",
  security: "Security",
  showgirl: "Showgirl",
  gambler: "Gambler",
  "high-roller": "High Roller",
};

// No SVG icons yet; the character selector shows labels without icons when
// iconUrl is undefined.
export const modelsCharacterIconUrls: Partial<Record<ModelsCharacterId, string>> = {};

export function isModelsCharacterId(value: string | undefined): value is ModelsCharacterId {
  return value !== undefined && modelsCharacterIds.includes(value as ModelsCharacterId);
}

// --- Custom characters (assembled from parts) -------------------------------
export const modelsCustomCharacterIds = Object.keys(modelsCustomCharacterPresets);
export type ModelsCustomCharacterId = string;

export function isModelsCustomCharacterId(value: string | undefined): boolean {
  return value !== undefined && value in modelsCustomCharacterPresets;
}

export function getCustomCharacterLabel(id: string): string | undefined {
  return modelsCustomCharacterPresets[id]?.label;
}

// All models character IDs (Casino + custom).
export const allModelsCharacterIds: readonly string[] = [
  ...modelsCharacterIds,
  ...modelsCustomCharacterIds,
];

// Map standard animation keys (used by SceneHost) to the embedded animation
// names in the models GLBs. Adult-rig characters share the same animation
// names; the Plus-size rig uses a "Plus-size" prefix and a smaller clip set.
// The Casino pack has no jump/doubleJump/swim clips, so those map to the
// closest available movement animation to avoid a frozen character when the
// player jumps or enters water.
const ADULT_ANIMATION_MAP: Record<string, string> = {
  idle: "Adult_Security_Idle_1",
  walk: "Adult_Walk",
  run: "Adult_WalkFast",
  jump: "Adult_WalkFast",
  doubleJump: "Adult_WalkFast",
  swim: "Adult_Walk",
};

const PLUS_SIZE_ANIMATION_MAP: Record<string, string> = {
  idle: "Plus-sizeAdult_TalkGestureListen",
  walk: "Plus-sizeAdult_Walk",
  run: "Plus-sizeAdult_WalkFast",
  jump: "Plus-sizeAdult_WalkFast",
  doubleJump: "Plus-sizeAdult_WalkFast",
  swim: "Plus-sizeAdult_Walk",
};

const characterAnimationMaps: Record<ModelsCharacterId, Record<string, string>> = {
  cashier: ADULT_ANIMATION_MAP,
  security: ADULT_ANIMATION_MAP,
  showgirl: ADULT_ANIMATION_MAP,
  gambler: ADULT_ANIMATION_MAP,
  "high-roller": PLUS_SIZE_ANIMATION_MAP,
};

const characterFiles: Record<ModelsCharacterId, string> = {
  cashier: "1_Cashier.glb",
  security: "18_Security.glb",
  showgirl: "20_Showgirl.glb",
  gambler: "36.glb",
  "high-roller": "75.glb",
};

// Cache embedded clips per character ID so loadCharacterAnimations can return
// them without re-loading the GLB. Populated by the first loadCharacter call.
const embeddedClipsCache = new Map<string, readonly THREE.AnimationClip[]>();

// models characters are authored at real-world scale (~1.73m tall in GLB
// units). The HQ scene uses modelScale: 1.0 so the models render at their
// natural size with no multipliers needed.

function getManifest(id: string): CharacterManifest | undefined {
  if (isModelsCharacterId(id)) {
    return {
      id,
      label: modelsCharacterLabels[id],
      assetUrl: `${assetRoot}/${characterFiles[id]}`,
    };
  }
  if (isModelsCustomCharacterId(id)) {
    const preset = modelsCustomCharacterPresets[id];
    return {
      id,
      label: preset.label,
      // Custom characters are assembled from parts at runtime; there is no
      // single GLB URL. We use a placeholder that loadCharacter ignores.
      assetUrl: "",
    };
  }
  return undefined;
}

async function loadModelsCharacter(loader: GLTFLoader, id: string): Promise<LoadedCharacter> {
  // Custom assembled character from Creative Character parts.
  if (isModelsCustomCharacterId(id)) {
    const preset = modelsCustomCharacterPresets[id];
    const assembled = await assembleModelsCharacter(loader, preset.config);
    // Cache the clips so loadCharacterAnimations can find them.
    embeddedClipsCache.set(id, assembled.clips);
    return { scene: assembled.scene, clips: assembled.clips };
  }
  // Pre-built Casino character.
  const manifest = getManifest(id);
  if (!manifest) throw new Error(`Unknown models character: ${id}`);
  const gltf = await loader.loadAsync(manifest.assetUrl);
  embeddedClipsCache.set(id, gltf.animations);
  return { scene: gltf.scene, clips: gltf.animations };
}

// The GLTFLoader caches parsed GLBs internally, so re-loading the same URL
// returns instantly. This ensures loadCharacterAnimations can extract clips
// even if it races ahead of loadCharacter (SceneHost fires both in parallel).
async function ensureEmbeddedClips(
  loader: GLTFLoader,
  id: string,
): Promise<readonly THREE.AnimationClip[]> {
  const cached = embeddedClipsCache.get(id);
  if (cached) return cached;
  // Custom characters: load clips directly from the Casino rig GLB.
  // Don't call assembleModelsCharacter here — that would conflict with
  // the concurrent loadCharacter call that also assembles the character.
  if (isModelsCustomCharacterId(id)) {
    const clips = await loadModelsAnimationClips(loader);
    embeddedClipsCache.set(id, clips);
    return clips;
  }
  // Casino characters: load from the character's own GLB.
  const manifest = getManifest(id);
  if (!manifest) return [];
  const gltf = await loader.loadAsync(manifest.assetUrl);
  embeddedClipsCache.set(id, gltf.animations);
  return gltf.animations;
}

async function loadModelsCharacterAnimations(
  loader: GLTFLoader,
  id: string,
  keys: readonly string[],
): Promise<LoadedCharacterAnimations> {
  // Custom characters use the Adult-rig animation map (same skeleton).
  const animMap = isModelsCustomCharacterId(id)
    ? ADULT_ANIMATION_MAP
    : isModelsCharacterId(id)
      ? characterAnimationMaps[id]
      : null;
  if (!animMap) return { clips: [], names: {} };
  const embedded = await ensureEmbeddedClips(loader, id);
  if (!embedded.length) return { clips: [], names: {} };
  const clips: THREE.AnimationClip[] = [];
  const names: Record<string, string> = {};
  for (const key of keys) {
    const sourceName = animMap[key];
    if (!sourceName) continue;
    const clip = embedded.find((c) => c.name === sourceName);
    if (!clip) continue;
    const cloned = clip.clone();
    cloned.name = key;
    clips.push(cloned);
    names[key] = key;
  }
  return { clips, names };
}

const modelsProvider: CharacterProvider = {
  characterIds: allModelsCharacterIds,
  getManifest,
  loadCharacter: loadModelsCharacter,
  loadAnimatedCharacter: loadModelsCharacter,
  loadCharacterAnimations: loadModelsCharacterAnimations,
};

// Register on module import so any scene that imports @agent-hq/models/characters
// automatically plugs into the shared character pipeline.
registerCharacterProvider(modelsProvider);

// --- Creative Characters parts catalog --------------------------------------
// The Creative Characters pack is a customization kit (body parts, clothing,
// accessories, emotions). The assets are catalogued here for a future character
// customization UI; the runtime loader above uses the assembled Casino GLBs.
export const modelsCharacterPartIds = [
  "body-010",
  "clown-nose-001",
  "costume-10-001",
  "costume-6-001",
  "glasses-004",
  "glasses-006",
  "gloves-006",
  "gloves-014",
  "hairstyle-male-010",
  "hairstyle-male-012",
  "hat-010",
  "hat-049",
  "hat-057",
  "headphones-002",
  "emotion-angry-003",
  "emotion-happy-002",
  "emotion-usual-001",
  "moustache-001",
  "moustache-002",
  "outwear-029",
  "outwear-036",
  "pacifier-001",
  "pants-010",
  "pants-014",
  "shoe-slippers-002",
  "shoe-slippers-005",
  "shoe-sneakers-009",
  "shorts-003",
  "socks-008",
  "t-shirt-009",
] as const;
export type ModelsCharacterPartId = (typeof modelsCharacterPartIds)[number];

const characterPartFiles: Record<ModelsCharacterPartId, string> = {
  "body-010": "Body_010.glb",
  "clown-nose-001": "Clown_nose_001.glb",
  "costume-10-001": "Costume_10_001.glb",
  "costume-6-001": "Costume_6_001.glb",
  "glasses-004": "Glasses_004.glb",
  "glasses-006": "Glasses_006.glb",
  "gloves-006": "Gloves_006.glb",
  "gloves-014": "Gloves_014.glb",
  "hairstyle-male-010": "Hairstyle_male_010.glb",
  "hairstyle-male-012": "Hairstyle_male_012.glb",
  "hat-010": "Hat_010.glb",
  "hat-049": "Hat_049.glb",
  "hat-057": "Hat_057.glb",
  "headphones-002": "Headphones_002.glb",
  "emotion-angry-003": "Male_emotion_angry_003.glb",
  "emotion-happy-002": "Male_emotion_happy_002.glb",
  "emotion-usual-001": "Male_emotion_usual_001.glb",
  "moustache-001": "Moustache_001.glb",
  "moustache-002": "Moustache_002.glb",
  "outwear-029": "Outwear_029.glb",
  "outwear-036": "Outwear_036.glb",
  "pacifier-001": "Pacifier_001.glb",
  "pants-010": "Pants_010.glb",
  "pants-014": "Pants_014.glb",
  "shoe-slippers-002": "Shoe_Slippers_002.glb",
  "shoe-slippers-005": "Shoe_Slippers_005.glb",
  "shoe-sneakers-009": "Shoe_Sneakers_009.glb",
  "shorts-003": "Shorts_003.glb",
  "socks-008": "Socks_008.glb",
  "t-shirt-009": "T-Shirt_009.glb",
};

const characterPartRoot = "/assets/models/character-parts";

export const modelsCharacterPartAssets = modelsCharacterPartIds.map((id) => ({
  id,
  label: id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
  assetUrl: `${characterPartRoot}/${characterPartFiles[id]}`,
}));
