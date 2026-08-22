// customizable character system.
//
// The Creative Character pack ships individual body/clothing parts (bodies,
// hairstyles, hats, glasses, shoes, etc.) that all share the same 44-joint
// skeleton as the Casino characters. This module provides a system to:
//
// 1. Define a character as a set of part slots (body, face, hair, top,
//    bottom, shoes, accessories)
// 2. Load each part GLB and extract its skinned mesh
// 3. Merge them into a single character with a shared skeleton
// 4. Use animations from any Casino character (they share the same rig)
//
// The result is a LoadedCharacter-compatible object that plugs into the
// existing CharacterProvider pipeline.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

const partsRoot = "/assets/models/character-parts";
const charactersRoot = "/assets/models/characters";

// --- Part catalog -----------------------------------------------------------
// Each part is categorized by slot. A character definition picks one part
// per slot (some slots are optional).

export type CharacterPartSlot =
  | "body"
  | "face"
  | "hair"
  | "hat"
  | "top"
  | "bottom"
  | "shoes"
  | "glasses"
  | "gloves"
  | "accessory";

export interface CharacterPartOption {
  id: string;
  label: string;
  slot: CharacterPartSlot;
  file: string;
}

export const characterPartCatalog: readonly CharacterPartOption[] = [
  // Body
  { id: "body-010", label: "Body 010", slot: "body", file: "Body_010.glb" },

  // Face (emotions)
  { id: "face-usual", label: "Usual", slot: "face", file: "Male_emotion_usual_001.glb" },
  { id: "face-happy", label: "Happy", slot: "face", file: "Male_emotion_happy_002.glb" },
  { id: "face-angry", label: "Angry", slot: "face", file: "Male_emotion_angry_003.glb" },

  // Hair
  { id: "hair-010", label: "Hairstyle 010", slot: "hair", file: "Hairstyle_male_010.glb" },
  { id: "hair-012", label: "Hairstyle 012", slot: "hair", file: "Hairstyle_male_012.glb" },

  // Hat
  { id: "hat-010", label: "Hat 010", slot: "hat", file: "Hat_010.glb" },
  { id: "hat-049", label: "Hat 049", slot: "hat", file: "Hat_049.glb" },
  { id: "hat-057", label: "Hat 057", slot: "hat", file: "Hat_057.glb" },

  // Top (shirts, jackets, costumes, outwear)
  { id: "tshirt-009", label: "T-Shirt 009", slot: "top", file: "T-Shirt_009.glb" },
  { id: "outwear-029", label: "Outwear 029", slot: "top", file: "Outwear_029.glb" },
  { id: "outwear-036", label: "Outwear 036", slot: "top", file: "Outwear_036.glb" },
  { id: "costume-6", label: "Costume 6", slot: "top", file: "Costume_6_001.glb" },
  { id: "costume-10", label: "Costume 10", slot: "top", file: "Costume_10_001.glb" },

  // Bottom (pants, shorts)
  { id: "pants-010", label: "Pants 010", slot: "bottom", file: "Pants_010.glb" },
  { id: "pants-014", label: "Pants 014", slot: "bottom", file: "Pants_014.glb" },
  { id: "shorts-003", label: "Shorts 003", slot: "bottom", file: "Shorts_003.glb" },

  // Shoes
  { id: "shoes-sneakers-009", label: "Sneakers 009", slot: "shoes", file: "Shoe_Sneakers_009.glb" },
  { id: "shoes-slippers-002", label: "Slippers 002", slot: "shoes", file: "Shoe_Slippers_002.glb" },
  { id: "shoes-slippers-005", label: "Slippers 005", slot: "shoes", file: "Shoe_Slippers_005.glb" },

  // Socks
  { id: "socks-008", label: "Socks 008", slot: "accessory", file: "Socks_008.glb" },

  // Glasses
  { id: "glasses-004", label: "Glasses 004", slot: "glasses", file: "Glasses_004.glb" },
  { id: "glasses-006", label: "Glasses 006", slot: "glasses", file: "Glasses_006.glb" },

  // Gloves
  { id: "gloves-006", label: "Gloves 006", slot: "gloves", file: "Gloves_006.glb" },
  { id: "gloves-014", label: "Gloves 014", slot: "gloves", file: "Gloves_014.glb" },

  // Accessories
  { id: "headphones-002", label: "Headphones", slot: "accessory", file: "Headphones_002.glb" },
  { id: "moustache-001", label: "Moustache 001", slot: "accessory", file: "Moustache_001.glb" },
  { id: "moustache-002", label: "Moustache 002", slot: "accessory", file: "Moustache_002.glb" },
  { id: "clown-nose", label: "Clown Nose", slot: "accessory", file: "Clown_nose_001.glb" },
  { id: "pacifier", label: "Pacifier", slot: "accessory", file: "Pacifier_001.glb" },
];

export const characterPartSlots: readonly CharacterPartSlot[] = [
  "body",
  "face",
  "hair",
  "hat",
  "top",
  "bottom",
  "shoes",
  "glasses",
  "gloves",
  "accessory",
];

export function characterPartsBySlot(slot: CharacterPartSlot): readonly CharacterPartOption[] {
  return characterPartCatalog.filter((p) => p.slot === slot);
}

// --- Character definition ---------------------------------------------------
// A character is defined by selecting one part per slot. Only "body" is
// required; other slots are optional and can be left empty.

export type CustomCharacterConfig = {
  body: string;
  face?: string;
  hair?: string;
  hat?: string;
  top?: string;
  bottom?: string;
  shoes?: string;
  glasses?: string;
  gloves?: string;
  accessory?: string;
};

// Predefined character presets using the Creative Character parts.
export const customCharacterPresets: Record<
  string,
  { label: string; config: CustomCharacterConfig }
> = {
  "custom-casual": {
    label: "Casual",
    config: {
      body: "body-010",
      face: "face-usual",
      hair: "hair-010",
      top: "tshirt-009",
      bottom: "pants-010",
      shoes: "shoes-sneakers-009",
    },
  },
  "custom-streetwear": {
    label: "Streetwear",
    config: {
      body: "body-010",
      face: "face-happy",
      hair: "hair-012",
      hat: "hat-010",
      top: "outwear-029",
      bottom: "pants-014",
      shoes: "shoes-sneakers-009",
      accessory: "headphones-002",
    },
  },
  "custom-formal": {
    label: "Formal",
    config: {
      body: "body-010",
      face: "face-usual",
      hair: "hair-010",
      top: "outwear-036",
      bottom: "pants-010",
      shoes: "shoes-slippers-005",
      glasses: "glasses-004",
    },
  },
  "custom-costume": {
    label: "Costume",
    config: {
      body: "body-010",
      face: "face-angry",
      hat: "hat-057",
      top: "costume-10",
      bottom: "shorts-003",
      shoes: "shoes-slippers-002",
      accessory: "clown-nose",
    },
  },
  "custom-chill": {
    label: "Chill",
    config: {
      body: "body-010",
      face: "face-happy",
      hair: "hair-012",
      top: "costume-6",
      bottom: "shorts-003",
      shoes: "shoes-slippers-002",
      glasses: "glasses-006",
      accessory: "pacifier",
    },
  },
};

// --- Character assembly -----------------------------------------------------
// The Casino characters share the same skeleton as the Creative Character
// parts. We use the Adult-rig Casino characters' animations for all custom
// characters since the Creative parts have no animations of their own.
const ANIMATION_SOURCE = `${charactersRoot}/1_Cashier.glb`;

// Cache the animation clips from the Casino rig so we only load them once.
let cachedAnimationClips: THREE.AnimationClip[] | null = null;
let pendingAnimationClips: Promise<THREE.AnimationClip[]> | null = null;

export async function loadCharacterAnimationClips(
  loader?: GLTFLoader,
): Promise<THREE.AnimationClip[]> {
  if (cachedAnimationClips) return cachedAnimationClips;
  if (pendingAnimationClips) return pendingAnimationClips;
  const animLoader = loader ?? new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  pendingAnimationClips = (async () => {
    const gltf = await animLoader.loadAsync(ANIMATION_SOURCE);
    cachedAnimationClips = gltf.animations;
    return cachedAnimationClips;
  })();
  try {
    return await pendingAnimationClips;
  } finally {
    pendingAnimationClips = null;
  }
}

export type AssembledCharacter = {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
};

/**
 * Assemble a custom character from Creative Character parts.
 *
 * Loads each selected part GLB, extracts its skinned mesh, and parents them
 * all under a shared skeleton root. The animations from the Casino rig are
 * attached since the Creative parts have none.
 */
export async function assembleCharacter(
  loader: GLTFLoader,
  config: CustomCharacterConfig,
): Promise<AssembledCharacter> {
  // Collect all part IDs to load.
  const partIds = Object.values(config).filter(Boolean) as string[];
  const partOptions = characterPartCatalog.filter((p) => partIds.includes(p.id));

  // Use a fresh loader for parts so concurrent skinned assemblies do not share
  // parser state, but keep Meshopt enabled because the packaged part GLBs are
  // compressed just like the main character assets.
  const partsLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

  // Load all parts fresh — don't cache, since SkinnedMesh skeletons don't
  // clone properly and concurrent assembly calls would conflict.
  const partResults = await Promise.all(
    partOptions.map(async (option) => {
      const url = `${partsRoot}/${option.file}`;
      const gltf = await partsLoader.loadAsync(url);
      if (!gltf || !gltf.scene) {
        throw new Error(`Part GLB has no scene: ${url}`);
      }
      return { option, scene: gltf.scene };
    }),
  );

  // Build a single group. Each part's skinned mesh is added as a child.
  // Since all parts share the same skeleton, their bones will animate
  // together when we apply clips from the Casino rig.
  const group = new THREE.Group();

  // We need a skeleton root. Use the first part's skeleton as the canonical
  // one; all other parts' skinned meshes will be bound to it.
  let skeletonRoot: THREE.Bone | null = null;
  let skeleton: THREE.Skeleton | null = null;

  for (const { scene, option } of partResults) {
    if (!scene) {
      console.error(`[characters] scene is undefined for part ${option.file}`);
      continue;
    }
    // Manually walk the tree instead of using traverse, since the GLTFLoader
    // may produce nodes with undefined children that cause traverse to crash.
    const stack: THREE.Object3D[] = [scene];
    while (stack.length > 0) {
      const obj = stack.pop()!;
      if (!obj) continue;
      // Process this object
      if (obj instanceof THREE.SkinnedMesh) {
        if (!skeleton) {
          // First skinned mesh — use its skeleton as the canonical one.
          skeleton = obj.skeleton;
          // Find the bone root (the Skeleton's root bone).
          skeletonRoot = obj.skeleton.bones[0]?.parent as THREE.Bone;
          if (skeletonRoot) {
            group.add(skeletonRoot);
          }
        }
        if (skeleton && skeletonRoot) {
          // Rebind this mesh to the canonical skeleton.
          obj.bind(skeleton);
        }
        obj.castShadow = true;
        obj.receiveShadow = true;
        group.add(obj);
      }
      // Add valid children to the stack
      if (obj.children) {
        for (const child of obj.children) {
          if (child && typeof child === "object") {
            stack.push(child);
          }
        }
      }
    }
  }

  // Load animations from the Casino rig.
  const clips = await loadCharacterAnimationClips(loader);

  return { scene: group, clips };
}

/**
 * Assemble a custom character by preset ID.
 */
export async function assembleCharacterByPreset(
  loader: GLTFLoader,
  presetId: string,
): Promise<AssembledCharacter | null> {
  const preset = customCharacterPresets[presetId];
  if (!preset) return null;
  return assembleCharacter(loader, preset.config);
}
