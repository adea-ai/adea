import {
  AnimationMixer,
  LoadingManager,
  type AnimationAction,
  type AnimationClip,
  type Object3D,
} from "three";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import {
  importedCharacterAnimationSlices,
  type ImportedAnimationSlice,
} from "./imported-animation-catalog";

export {
  importedCharacterAnimationSlices,
  importedCharacterAnimationUrls,
} from "./imported-animation-catalog";

export const degenCharacterIds = [
  "ape",
  "cat",
  "alien",
  "human",
  "frog",
  "doge",
  "bull",
  "panda",
  "tiger",
  "bear",
  "hydra",
  "kaiju",
  "carp",
  "fish",
  "chicken",
  "owl",
  "lizard",
  "unicorn",
] as const;
export type DegenCharacterId = (typeof degenCharacterIds)[number];

export function isDegenCharacterId(value: string | undefined): value is DegenCharacterId {
  return value !== undefined && degenCharacterIds.includes(value as DegenCharacterId);
}

// Animation clips are plain keyframe arrays (no GPU resources), and their URLs
// are shared across characters and scenes, so the parsed result can be cached
// for the lifetime of the page. Without this every scene route change re-fetches
// and re-parses the same ~18 FBX files even though nothing changed. Callers
// receive clones so per-use mutations (clip name, track filtering) never leak
// into the shared cache.
const animationClipCache = new Map<string, Promise<readonly AnimationClip[]>>();

function cachedAnimationClips(
  url: string,
  load: () => Promise<readonly AnimationClip[]>,
): Promise<readonly AnimationClip[]> {
  let cached = animationClipCache.get(url);
  if (!cached) {
    cached = load().catch((cause) => {
      animationClipCache.delete(url);
      throw cause;
    });
    animationClipCache.set(url, cached);
  }
  return cached;
}

export type CharacterManifest = {
  id: string;
  label: string;
  assetUrl: string;
  bodyAnimationUrls: Record<string, string>;
  facialTextureUrls: {
    eye: string;
    mouth: string;
  };
  facialAnimationUrls: Record<string, string>;
  /**
   * Optional multiplier applied on top of the scene's `characterScale.modelScale`.
   * Use this when a provider's GLBs are authored at a different unit scale than
   * the default degen characters (e.g. ithappy characters are ~1.73m in GLB
   * space while degen characters are ~8m). The product
   * `modelScale * modelScaleMultiplier` determines the final visual height.
   */
  modelScaleMultiplier?: number;
};

// --- External character provider system -------------------------------------
// Packages such as @agent-hq/ithappy can register a provider to plug their own
// rigged characters into the existing SceneHost pipeline without mixing their
// asset IDs into the World character selector (which reads `degenCharacterIds`).
export type CharacterProvider = {
  readonly characterIds: readonly string[];
  getManifest(id: string): CharacterManifest | undefined;
  loadCharacter(loader: GLTFLoader, id: string): Promise<LoadedCharacter>;
  loadAnimatedCharacter?(
    loader: GLTFLoader,
    id: string,
    animation: string,
  ): Promise<LoadedCharacter>;
  loadCharacterAnimations?(
    loader: GLTFLoader,
    id: string,
    keys: readonly string[],
  ): Promise<LoadedCharacterAnimations>;
  loadFacialTextures?(loader: THREE.TextureLoader, id: string): Promise<FacialTextures | null>;
  loadFacialAnimation?(id: string, state: string): Promise<FacialAnimationClip>;
};

const characterProviders: CharacterProvider[] = [];

export function registerCharacterProvider(provider: CharacterProvider): void {
  characterProviders.push(provider);
}

function findCharacterProvider(id: string): CharacterProvider | undefined {
  return characterProviders.find((provider) => provider.characterIds.includes(id));
}

export function getCharacterManifest(id: string): CharacterManifest | undefined {
  const provider = findCharacterProvider(id);
  if (provider) return provider.getManifest(id);
  return degenCharacterManifests[id as DegenCharacterId];
}

export const characterAnimationAssets: Record<string, string> = {};

const facialAnimationUrls: Record<string, string> = {};

function degenCharacterManifest(id: DegenCharacterId, label: string): CharacterManifest {
  return {
    id,
    label,
    assetUrl: "",
    bodyAnimationUrls: Object.fromEntries(
      Object.entries(characterAnimationAssets).map(([key, url]) => [key, url.replace("{id}", id)]),
    ),
    facialTextureUrls: { eye: "", mouth: "" },
    facialAnimationUrls,
  };
}

export const degenCharacterManifests: Record<DegenCharacterId, CharacterManifest> = {
  ape: degenCharacterManifest("ape", "Ape"),
  cat: degenCharacterManifest("cat", "Cat"),
  alien: degenCharacterManifest("alien", "Alien"),
  human: degenCharacterManifest("human", "Human"),
  frog: degenCharacterManifest("frog", "Frog"),
  doge: degenCharacterManifest("doge", "Doge"),
  bull: degenCharacterManifest("bull", "Bull"),
  panda: degenCharacterManifest("panda", "Panda"),
  tiger: degenCharacterManifest("tiger", "Tiger"),
  bear: degenCharacterManifest("bear", "Bear"),
  hydra: degenCharacterManifest("hydra", "Hydra"),
  kaiju: degenCharacterManifest("kaiju", "Kaiju"),
  carp: degenCharacterManifest("carp", "Carp"),
  fish: degenCharacterManifest("fish", "Fish"),
  chicken: degenCharacterManifest("chicken", "Chicken"),
  owl: degenCharacterManifest("owl", "Owl"),
  lizard: degenCharacterManifest("lizard", "Lizard"),
  unicorn: degenCharacterManifest("unicorn", "Unicorn"),
};

export type LoadedCharacter = {
  scene: Object3D;
  clips: AnimationClip[];
};

export type LoadedCharacterAnimations = {
  clips: AnimationClip[];
  names: Record<string, string>;
};

export type FacialAnimationTrack = {
  times: number[];
  values: number[];
};

export type FacialAnimationClip = {
  name: string;
  duration: number;
  eye: FacialAnimationTrack;
  mouth: FacialAnimationTrack;
};

export type FacialExpressionState = {
  eye: [number, number];
  mouth: [number, number];
  normalizedTime: number;
};

export type FacialTextures = {
  eye: THREE.Texture;
  mouth: THREE.Texture;
};

const FBX_MULTI_LAYER_WARNING =
  "THREE.FBXLoader: Encountered an animation stack with multiple layers, this is currently not supported. Ignoring subsequent layers.";
const FBX_TGA_WARNING_PREFIX = "FBXLoader: TGA loader not found, skipping";
const UNITY_AUTHORING_ROOT_TRACK = /^Root_M\.(position|quaternion|scale)$/i;
const UNITY_AUTHORING_SCALE_TRACK = /^DeformationSystem\.scale$/i;
const FACIAL_OFFSET_EPSILON = 0.00001;
// Facial FBX exports embed the Unity authoring texture used to paint their
// UV-offset curves (e.g. Alien_expressions_mouth_instructions_01.png). The
// file only exists on the authoring machine, so FBXLoader would 404 it on
// every facial load. These clips are used purely for their animation tracks,
// so swap the reference for a transparent pixel instead of fetching it.
const AUTHORING_TEXTURE_PATTERN = /expressions_mouth_instructions|\.tga$/i;
const TRANSPARENT_PIXEL_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const fbxManager = new LoadingManager();
fbxManager.setURLModifier((url) =>
  AUTHORING_TEXTURE_PATTERN.test(url) ? TRANSPARENT_PIXEL_DATA_URI : url,
);
// The animation FBX files reference authoring-only textures (facial
// expression instructions, UVunwraps\JetpackColoured1.tga) that do not ship.
// The URL modifier routes them to a transparent pixel (never rendered — the
// scene is disposed right after clip extraction), and registering a texture
// handler here stops FBXLoader from warning on every load.
fbxManager.addHandler(/\.tga$/i, new THREE.TextureLoader(fbxManager));

export async function loadCharacter(
  loader: GLTFLoader,
  id: DegenCharacterId | string,
): Promise<LoadedCharacter> {
  const provider = findCharacterProvider(id);
  if (provider) return provider.loadCharacter(loader, id);
  const gltf = await loader.loadAsync(degenCharacterManifests[id as DegenCharacterId].assetUrl);
  return { scene: gltf.scene, clips: gltf.animations };
}

/** Load the skinned run GLB. All additional body states are loaded on demand. */
export async function loadAnimatedCharacter(
  loader: GLTFLoader,
  id: DegenCharacterId | string,
  animation = "run",
): Promise<LoadedCharacter> {
  const provider = findCharacterProvider(id);
  if (provider?.loadAnimatedCharacter) return provider.loadAnimatedCharacter(loader, id, animation);
  const url = degenCharacterManifests[id as DegenCharacterId].bodyAnimationUrls[animation];
  if (!url) throw new Error(`No ${animation} animation is registered for ${id}`);
  const gltf = await loader.loadAsync(url);
  const clips = gltf.animations;
  if (clips[0]) clips[0].name = animation;
  return { scene: gltf.scene, clips };
}

/** Load one or more body clips without putting the whole catalog in startup. */
export async function loadCharacterAnimations(
  loader: GLTFLoader,
  id: DegenCharacterId | string,
  keys: readonly string[],
): Promise<LoadedCharacterAnimations> {
  const provider = findCharacterProvider(id);
  if (provider?.loadCharacterAnimations) return provider.loadCharacterAnimations(loader, id, keys);
  const importedSlices: Record<string, ImportedAnimationSlice | undefined> =
    importedCharacterAnimationSlices;
  const entries = keys
    .map(
      (key) =>
        [key, degenCharacterManifests[id as DegenCharacterId].bodyAnimationUrls[key]] as const,
    )
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
  const results = await Promise.allSettled(
    entries.map(async ([key, url]) => ({
      key,
      clips: await loadAnimationAsset(loader, url, importedSlices[key]),
    })),
  );
  const clips: AnimationClip[] = [];
  const names: Record<string, string> = {};
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const [key, url] = entries[index];
      console.warn(
        `[Agent HQ] character animation unavailable key=${key} url=${url}`,
        result.reason,
      );
      return;
    }
    const { key, clips: loadedClips } = result.value;
    const clip = loadedClips[0];
    if (!clip) return;
    // Source FBX names collide for variants such as Dive_01/Dive_02. The
    // catalog key is the stable action name used by the runtime.
    clip.name = key;
    clips.push(clip);
    names[key] = key;
  });
  return { clips, names };
}

/** Port Unity's facial-expression stabilizer for action fallbacks. */
export function buildFacialExpressionStates(
  animation: FacialAnimationClip,
  minimumStableFrames = 4,
): FacialExpressionState[] {
  const count = Math.min(
    animation.eye.times.length,
    animation.mouth.times.length,
    Math.floor(animation.eye.values.length / 2),
    Math.floor(animation.mouth.values.length / 2),
  );
  const states: FacialExpressionState[] = [];
  let index = 0;
  const sameOffset = (left: number, right: number) =>
    Math.abs(left - right) <= FACIAL_OFFSET_EPSILON;
  while (index < count) {
    const eye: [number, number] = [
      animation.eye.values[index * 2] ?? 0,
      animation.eye.values[index * 2 + 1] ?? 0,
    ];
    const mouth: [number, number] = [
      animation.mouth.values[index * 2] ?? 0,
      animation.mouth.values[index * 2 + 1] ?? 0,
    ];
    let runLength = 1;
    while (index + runLength < count) {
      const nextEyeX = animation.eye.values[(index + runLength) * 2] ?? 0;
      const nextEyeY = animation.eye.values[(index + runLength) * 2 + 1] ?? 0;
      const nextMouthX = animation.mouth.values[(index + runLength) * 2] ?? 0;
      const nextMouthY = animation.mouth.values[(index + runLength) * 2 + 1] ?? 0;
      if (
        !sameOffset(nextEyeX, eye[0]) ||
        !sameOffset(nextEyeY, eye[1]) ||
        !sameOffset(nextMouthX, mouth[0]) ||
        !sameOffset(nextMouthY, mouth[1])
      )
        break;
      runLength += 1;
    }
    if (runLength >= minimumStableFrames) {
      states.push({
        eye,
        mouth,
        normalizedTime:
          animation.duration > 0 ? animation.eye.times[index] / animation.duration : 0,
      });
    }
    index += runLength;
  }
  return states;
}

/** Backwards-compatible single-clip helper for scene or game code. */
export async function loadCharacterAnimation(
  loader: GLTFLoader,
  id: DegenCharacterId,
  animation: string,
): Promise<AnimationClip[]> {
  return (await loadCharacterAnimations(loader, id, [animation])).clips;
}

/** The shared swimming clip is kept as a focused helper for existing callers. */
export async function loadSwimmingAnimation(id: DegenCharacterId): Promise<AnimationClip[]> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const result = await loadCharacterAnimations(loader, id, ["swim"]);
  return result.clips;
}

/** Load the Unity UV-offset expression atlas pair used by a character. */
export async function loadFacialTextures(
  loader: THREE.TextureLoader,
  id: DegenCharacterId | string,
): Promise<FacialTextures | null> {
  const provider = findCharacterProvider(id);
  if (provider?.loadFacialTextures) return provider.loadFacialTextures(loader, id);
  const manifest = degenCharacterManifests[id as DegenCharacterId];
  if (!manifest) return null;
  const urls = manifest.facialTextureUrls;
  let eye: THREE.Texture | undefined;
  let mouth: THREE.Texture | undefined;
  try {
    [eye, mouth] = await Promise.all([loader.loadAsync(urls.eye), loader.loadAsync(urls.mouth)]);
  } catch (cause) {
    eye?.dispose();
    mouth?.dispose();
    throw cause;
  }

  [eye, mouth].forEach((texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    // These atlases are extracted Unity PNGs rather than glTF images. Their
    // pixels share the character GLB's top-left UV convention, so upload the
    // image unflipped; the runtime Y-negates the Unity-authored offsets
    // (bottom-up) when it applies them.
    texture.flipY = false;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
  });
  return { eye, mouth };
}

/** Load one facial UV-offset clip by its matching body/catalog key. */
export async function loadFacialAnimation(
  id: DegenCharacterId | string,
  state: string,
): Promise<FacialAnimationClip> {
  const provider = findCharacterProvider(id);
  if (provider?.loadFacialAnimation) return provider.loadFacialAnimation(id, state);
  const manifest = degenCharacterManifests[id as DegenCharacterId];
  if (!manifest) throw new Error(`No facial animation is registered for ${id}`);
  const url = manifest.facialAnimationUrls[state];
  if (!url) throw new Error(`No ${state} facial animation is registered for ${id}`);
  const clips = await cachedAnimationClips(url, async () => {
    const fbx = await loadFbxQuietly(url);
    const parsed = fbx.animations;
    disposeCharacterScene(fbx);
    return parsed;
  });
  const animation = clips[0];
  if (!animation) throw new Error(`No facial animation clip found in ${url}`);

  return {
    name: state,
    duration: animation.duration,
    eye: reduceFacialTrack(
      animation.tracks.find((track) => /UV_Offset_Eye\.position$/i.test(track.name)),
    ),
    mouth: reduceFacialTrack(
      animation.tracks.find((track) => /UV_Offset_Mouth\.position$/i.test(track.name)),
    ),
  };
}

/**
 * Extract an inclusive Unity frame range from an imported clip.
 *
 * FBXLoader preserves the source timestamps as floats. Values such as frame
 * 62 can arrive as 61.999998, which makes AnimationUtils.subclip's strict
 * bounds drop the first frame (and can leave a one-frame slice with duration
 * zero). Resolve keys by their nearest integer source frame instead, then add
 * a terminal copy of the final pose so frame-based Unity playback holds each
 * authored frame for one complete frame interval.
 */
export function sliceAnimationClip(
  source: AnimationClip,
  name: string,
  slice: ImportedAnimationSlice,
): AnimationClip {
  const fps = slice.fps > 0 ? slice.fps : 30;
  const frameCount = slice.lastFrame - slice.firstFrame + 1;
  const duration = frameCount / fps;
  const clip = source.clone();
  clip.name = name;
  clip.duration = duration;
  clip.tracks = source.tracks.map((sourceTrack) => {
    const valueSize = sourceTrack.getValueSize();
    const values: number[] = [];
    const times: number[] = [];

    for (let frame = slice.firstFrame; frame <= slice.lastFrame; frame++) {
      let keyIndex = -1;
      let nearestDistance = Infinity;
      for (let index = 0; index < sourceTrack.times.length; index++) {
        const sourceFrame = sourceTrack.times[index] * fps;
        const roundedFrame = Math.round(sourceFrame);
        const distance = Math.abs(sourceFrame - frame);
        if (roundedFrame === frame && distance < nearestDistance) {
          keyIndex = index;
          nearestDistance = distance;
        }
      }

      // Sparse FBX tracks are valid. Sample their nearest key rather than
      // dropping the track and leaving the target skeleton at bind pose.
      if (keyIndex < 0) {
        nearestDistance = Infinity;
        for (let index = 0; index < sourceTrack.times.length; index++) {
          const distance = Math.abs(sourceTrack.times[index] * fps - frame);
          if (distance < nearestDistance) {
            keyIndex = index;
            nearestDistance = distance;
          }
        }
      }
      if (keyIndex < 0) continue;

      times.push((frame - slice.firstFrame) / fps);
      const start = keyIndex * valueSize;
      values.push(...Array.from(sourceTrack.values.slice(start, start + valueSize)));
    }

    // Hold the final authored pose through the end of the last frame. This
    // matches Unity's frame-stepped animator and gives one-frame clips a
    // usable non-zero duration.
    if (times.length > 0) {
      const lastStart = values.length - valueSize;
      times.push(duration);
      values.push(...values.slice(lastStart));
    }

    return new (
      sourceTrack.constructor as new (
        name: string,
        times: number[],
        values: number[],
        interpolation?: number,
      ) => THREE.KeyframeTrack
    )(sourceTrack.name, times, values, sourceTrack.getInterpolation());
  });
  return clip;
}

async function loadAnimationAsset(
  loader: GLTFLoader,
  url: string,
  slice?: ImportedAnimationSlice,
): Promise<AnimationClip[]> {
  if (/\.fbx$/i.test(url)) {
    const clips = await cachedAnimationClips(url, async () => {
      const fbx = await loadFbxQuietly(url);
      const parsed = fbx.animations.map((clip) => {
        // Unity's source-space Root_M transform would overwrite the target GLB
        // bind pose and fight the physics-driven character root in SceneHost.
        clip.tracks = clip.tracks.filter(
          (track) =>
            !UNITY_AUTHORING_ROOT_TRACK.test(track.name) &&
            !UNITY_AUTHORING_SCALE_TRACK.test(track.name),
        );
        return clip;
      });
      disposeCharacterScene(fbx);
      return parsed;
    });
    const clones = clips.map((clip) => clip.clone());
    return slice && clones[0] ? [sliceAnimationClip(clones[0], "slice", slice)] : clones;
  }
  const gltf = await loader.loadAsync(url);
  const clips = gltf.animations;
  disposeCharacterScene(gltf.scene);
  return clips;
}

function reduceFacialTrack(track: THREE.KeyframeTrack | undefined): FacialAnimationTrack {
  if (!track) return { times: [0], values: [0, 0] };
  const valueSize = track.getValueSize();
  const values: number[] = [];
  for (let index = 0; index < track.values.length; index += valueSize) {
    values.push(track.values[index] ?? 0, track.values[index + 1] ?? 0);
  }
  return { times: Array.from(track.times), values };
}

async function loadFbxQuietly(url: string): Promise<Awaited<ReturnType<FBXLoader["loadAsync"]>>> {
  const originalWarn = console.warn;
  console.warn = (...args) => {
    // Authoring-only textures (TGA/expression instructions) and multi-layer
    // stacks are expected: the clips are used purely for their animation
    // tracks and the scene is disposed right after extraction.
    if (
      typeof args[0] === "string" &&
      (args[0] === FBX_MULTI_LAYER_WARNING || args[0].startsWith(FBX_TGA_WARNING_PREFIX))
    )
      return;
    originalWarn(...args);
  };
  try {
    return await new FBXLoader(fbxManager).loadAsync(url);
  } finally {
    console.warn = originalWarn;
  }
}

export type CharacterAnimationController = {
  mixer: AnimationMixer;
  actions: ReadonlyMap<string, AnimationAction>;
  play: (name: string, fadeSeconds?: number) => AnimationAction | undefined;
  update: (deltaSeconds: number) => void;
  dispose: () => void;
  /** Register additional clips (e.g. vehicle animations loaded on demand). */
  addClips: (clips: readonly AnimationClip[]) => void;
};

export function createCharacterAnimationController(
  root: Object3D,
  clips: readonly AnimationClip[],
): CharacterAnimationController {
  const mixer = new AnimationMixer(root);
  const actions = new Map(
    clips.map((clip) => {
      const action = mixer.clipAction(clip);
      const slice = (
        importedCharacterAnimationSlices as Record<string, ImportedAnimationSlice | undefined>
      )[clip.name];
      if (slice && !slice.loop) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      return [clip.name, action] as const;
    }),
  );

  return {
    mixer,
    actions,
    play(name, fadeSeconds = 0.15) {
      const next = actions.get(name);
      if (!next) return undefined;
      actions.forEach((action) => {
        if (action === next || !action.enabled || action.getEffectiveWeight() <= 0) return;
        // A clampWhenFinished action becomes paused and isRunning() returns
        // false, but it still contributes at full weight. Stop it immediately
        // when no cross-fade was requested; otherwise unpause it so fadeOut can
        // actually advance and release the clamped pose.
        if (fadeSeconds <= 0) {
          action.stop();
        } else {
          action.paused = false;
          action.fadeOut(fadeSeconds);
        }
      });
      next.reset().fadeIn(fadeSeconds).play();
      return next;
    },
    update(deltaSeconds) {
      mixer.update(deltaSeconds);
    },
    addClips(newClips) {
      for (const clip of newClips) {
        if (actions.has(clip.name)) continue;
        const action = mixer.clipAction(clip);
        const slice = (
          importedCharacterAnimationSlices as Record<string, ImportedAnimationSlice | undefined>
        )[clip.name];
        if (slice && !slice.loop) {
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
        } else {
          action.setLoop(THREE.LoopRepeat, Infinity);
        }
        actions.set(clip.name, action);
      }
    },
    dispose() {
      mixer.stopAllAction();
      clips.forEach((clip) => mixer.uncacheClip(clip));
      mixer.uncacheRoot(root);
    },
  };
}

function disposeCharacterScene(root: Object3D): void {
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
      material.dispose();
    });
  });
  textures.forEach((texture) => texture.dispose());
}
