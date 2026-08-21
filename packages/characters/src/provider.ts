import { AnimationMixer, type AnimationAction, type AnimationClip, type Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export type CharacterManifest = {
  id: string;
  label: string;
  assetUrl: string;
  modelScaleMultiplier?: number;
};

export type LoadedCharacter = {
  scene: Object3D;
  clips: AnimationClip[];
};

export type LoadedCharacterAnimations = {
  clips: AnimationClip[];
  names: Record<string, string>;
};

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
};

const characterProviders: CharacterProvider[] = [];

export function registerCharacterProvider(provider: CharacterProvider): void {
  if (!characterProviders.includes(provider)) characterProviders.push(provider);
}

function findCharacterProvider(id: string): CharacterProvider | undefined {
  return characterProviders.find((provider) => provider.characterIds.includes(id));
}

export function getCharacterManifest(id: string): CharacterManifest | undefined {
  return findCharacterProvider(id)?.getManifest(id);
}

export async function loadCharacter(loader: GLTFLoader, id: string): Promise<LoadedCharacter> {
  const provider = findCharacterProvider(id);
  if (!provider) throw new Error(`Unknown character model: ${id}`);
  return provider.loadCharacter(loader, id);
}

export async function loadAnimatedCharacter(
  loader: GLTFLoader,
  id: string,
  animation = "run",
): Promise<LoadedCharacter> {
  const provider = findCharacterProvider(id);
  if (!provider?.loadAnimatedCharacter)
    throw new Error(`No animated character loader is registered for ${id} (${animation})`);
  return provider.loadAnimatedCharacter(loader, id, animation);
}

export async function loadCharacterAnimations(
  loader: GLTFLoader,
  id: string,
  keys: readonly string[],
): Promise<LoadedCharacterAnimations> {
  const provider = findCharacterProvider(id);
  if (!provider?.loadCharacterAnimations)
    throw new Error(`No character animation loader is registered for ${id}`);
  return provider.loadCharacterAnimations(loader, id, keys);
}

export type CharacterAnimationController = {
  mixer: AnimationMixer;
  actions: ReadonlyMap<string, AnimationAction>;
  play: (name: string, fadeSeconds?: number) => AnimationAction | undefined;
  update: (deltaSeconds: number) => void;
  dispose: () => void;
  addClips: (clips: readonly AnimationClip[]) => void;
};

export function createCharacterAnimationController(
  root: Object3D,
  clips: readonly AnimationClip[],
): CharacterAnimationController {
  const mixer = new AnimationMixer(root);
  const actions = new Map<string, AnimationAction>();

  const addClips = (newClips: readonly AnimationClip[]) => {
    for (const clip of newClips) {
      if (actions.has(clip.name)) continue;
      actions.set(clip.name, mixer.clipAction(clip));
    }
  };
  addClips(clips);

  return {
    mixer,
    actions,
    play(name, fadeSeconds = 0.15) {
      const next = actions.get(name);
      if (!next) return undefined;
      actions.forEach((action) => {
        if (action === next || !action.enabled || action.getEffectiveWeight() <= 0) return;
        if (fadeSeconds <= 0) action.stop();
        else action.fadeOut(fadeSeconds);
      });
      next.reset().fadeIn(fadeSeconds).play();
      return next;
    },
    update(deltaSeconds) {
      mixer.update(deltaSeconds);
    },
    addClips,
    dispose() {
      mixer.stopAllAction();
      clips.forEach((clip) => mixer.uncacheClip(clip));
      mixer.uncacheRoot(root);
    },
  };
}
