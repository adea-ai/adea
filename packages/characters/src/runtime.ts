import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  createCharacterAnimationController,
  loadCharacter as loadProviderCharacter,
  normalizeInPlaceLocomotionClip,
  type CharacterAnimationController,
  type CharacterManifest,
  type LoadedCharacter,
  type LoadedCharacterAnimations,
} from './provider'
import type { CharacterConfiguration } from './configuration'

export const configurableCharacterId = 'configurable' as const
export const CHARACTER_CONFIGURATION_VERSION = 1 as const

type CharacterConfigurationSlot = Exclude<keyof CharacterConfiguration, 'version'>
const configurationSlots: readonly CharacterConfigurationSlot[] = [
  'body',
  'ears',
  'face',
  'hair',
  'hat',
  'top',
  'bottom',
  'shoes',
  'socks',
  'glasses',
  'gloves',
  'accessory',
  'costume',
]

const defaultCharacterConfiguration: CharacterConfiguration = {
  version: CHARACTER_CONFIGURATION_VERSION,
  body: 'body-body-01',
  ears: 'ears-ears-01',
  face: 'face-female-emotion-usual-01',
  hair: 'hair-hairstyle-female-01',
  hat: null,
  top: 'top-outfit-01',
  bottom: 'bottom-pants-01',
  shoes: 'shoes-shoe-sneakers-01',
  socks: null,
  glasses: null,
  gloves: null,
  accessory: null,
  costume: null,
}

const characterConfigurationPresets: Readonly<Record<string, CharacterConfiguration>> = {
  default: defaultCharacterConfiguration,
  researcher: {
    ...defaultCharacterConfiguration,
    body: 'body-body-05',
    face: 'face-male-emotion-usual-01',
    hair: 'hair-hairstyle-male-03',
    hat: 'hat-hat-01',
    top: 'top-outwear-01',
    bottom: 'bottom-pants-03',
    shoes: 'shoes-shoe-sneakers-03',
    glasses: 'glasses-glasses-01',
    gloves: 'gloves-gloves-01',
    accessory: 'accessory-beard-01',
  },
  builder: {
    ...defaultCharacterConfiguration,
    body: 'body-body-12',
    face: 'face-male-emotion-happy-01',
    hair: 'hair-hairstyle-female-07',
    top: null,
    bottom: 'bottom-shorts-01',
    shoes: 'shoes-shoe-slippers-01',
    gloves: 'gloves-gloves-05',
    accessory: 'accessory-bandage-01',
    costume: 'costume-10-01',
  },
}

export const referenceCharacterIds = [
  'f_1',
  'f_2',
  'f_3',
  'f_4',
  'f_5',
  'f_6',
  'f_7',
  'f_8',
  'f_9',
  'f_10',
  'f_11',
  'f_12',
  'm_1',
  'm_2',
  'm_3',
  'm_4',
  'm_5',
  'm_6',
  'm_7',
  'm_8',
  'm_9',
  'm_10',
  'm_11',
  'm_12',
  'm_13',
] as const

type ReferenceCharacterId = (typeof referenceCharacterIds)[number]
export const characterIds = [configurableCharacterId, ...referenceCharacterIds] as const
export type CharacterId = (typeof characterIds)[number]

export const characterLabels = Object.fromEntries([
  [configurableCharacterId, 'Custom'],
  ...referenceCharacterIds.map((id) => {
    const [family, number] = id.split('_')
    return [id, `Example ${family.toUpperCase()} ${number?.padStart(2, '0') ?? id}`]
  }),
]) as Record<CharacterId, string>

export const characterIconUrls: Partial<Record<CharacterId, string>> = {}
export const customCharacterIds = Object.keys(characterConfigurationPresets)
export const allCharacterIds: readonly string[] = [...characterIds]
export const characterLibraryAssets = [
  {
    id: 'characters-library',
    label: 'Characters Library',
    assetUrl: '/assets/models/characters.glb',
  },
] as const

const characterAssetRoot = '/assets/models'
const characterLibraryUrl = `${characterAssetRoot}/characters.glb`
const characterLibraryVariantUrls = {
  default: `${characterAssetRoot}/characters-default.glb`,
  researcher: `${characterAssetRoot}/characters-researcher.glb`,
  builder: `${characterAssetRoot}/characters-builder.glb`,
} as const
const characterAnimationUrl = `${characterAssetRoot}/runtime.glb`
// Top-down sessions only ever play idle and the locomotion clip, so they can
// load this reduced library instead of the full animation set.
const characterLocomotionAnimationUrl = `${characterAssetRoot}/runtime-locomotion.glb`
const locomotionAnimationKeys = new Set(['idle', 'run', 'walk'])

const animationMap: Record<string, string> = {
  idle: 'Idle_Relaxed',
  walk: 'Walk_Forward',
  run: 'Run_Forward',
  jump: 'Jump_Start',
  jumpStart: 'Jump_Start',
  jumpLoop: 'Jump_Loop',
  jumpEnd: 'Jump_End',
  doubleJump: 'Jump_Loop',
  swim: 'Walk_Forward',
}

function sameConfiguration(left: CharacterConfiguration, right: CharacterConfiguration): boolean {
  return (
    left.version === right.version && configurationSlots.every((slot) => left[slot] === right[slot])
  )
}

function parseRuntimeConfiguration(value: string | undefined): CharacterConfiguration | undefined {
  if (!value?.startsWith('character:v1:')) return undefined
  const values = value.slice('character:v1:'.length).split('|')
  if (values.length !== configurationSlots.length) return undefined
  const result = { version: CHARACTER_CONFIGURATION_VERSION } as CharacterConfiguration
  configurationSlots.forEach((slot, index) => {
    const part = values[index]
    ;(result as unknown as Record<CharacterConfigurationSlot, string | null>)[slot] =
      part && part !== '-' ? part : null
  })
  return result
}

export function createDefaultCharacterConfiguration(): CharacterConfiguration {
  return { ...defaultCharacterConfiguration }
}

export function getCharacterConfiguration(
  id: string | undefined
): CharacterConfiguration | undefined {
  if (id === configurableCharacterId) return createDefaultCharacterConfiguration()
  const serialized = parseRuntimeConfiguration(id)
  if (serialized) return serialized
  const preset = id ? characterConfigurationPresets[id] : undefined
  return preset ? { ...preset } : undefined
}

export function isCharacterConfigurationId(value: string | undefined): boolean {
  return parseRuntimeConfiguration(value) !== undefined
}

export function isConfigurableCharacterId(value: string | undefined): boolean {
  return (
    value === configurableCharacterId ||
    Boolean(value && characterConfigurationPresets[value]) ||
    isCharacterConfigurationId(value)
  )
}

export function isCharacterId(value: string | undefined): value is CharacterId {
  return value !== undefined && characterIds.includes(value as CharacterId)
}

export function isCustomCharacterId(value: string | undefined): boolean {
  return isConfigurableCharacterId(value) && !isCharacterId(value)
}

const customCharacterLabels = {
  default: 'Default',
  researcher: 'Researcher',
  builder: 'Builder',
} as const

export function getCustomCharacterLabel(id: string): string | undefined {
  if (id === configurableCharacterId) return 'Custom'
  return customCharacterLabels[id as keyof typeof customCharacterLabels]
}

export function serializeCharacterConfiguration(configuration: CharacterConfiguration): string {
  const values = configurationSlots.map((slot) => configuration[slot] ?? '-')
  return `character:v${configuration.version}:${values.join('|')}`
}

export function getCharacterLibraryAssetUrl(id: string): string {
  const configuration = getCharacterConfiguration(id)
  if (!configuration) return characterLibraryUrl
  if (sameConfiguration(configuration, defaultCharacterConfiguration)) {
    return characterLibraryVariantUrls.default
  }
  for (const [presetId, preset] of Object.entries(characterConfigurationPresets)) {
    if (presetId !== 'default' && sameConfiguration(configuration, preset)) {
      return characterLibraryVariantUrls[presetId as keyof typeof characterLibraryVariantUrls]
    }
  }
  return characterLibraryUrl
}

function referenceCharacterManifest(id: string): CharacterManifest | undefined {
  if (!referenceCharacterIds.includes(id as ReferenceCharacterId)) return undefined
  return {
    id,
    label: characterLabels[id as ReferenceCharacterId],
    assetUrl: `${characterAssetRoot}/_complete/${id}.glb`,
  }
}

/**
 * Loads the normal workspace character path without importing the wearable
 * catalog. Arbitrary custom configurations fall back to the authoring module
 * only when they cannot use one of the packaged runtime variants.
 */
export async function loadCharacter(
  loader: GLTFLoader,
  id: string,
  configuration?: CharacterConfiguration
): Promise<LoadedCharacter> {
  const reference = referenceCharacterManifest(id)
  if (reference) {
    const gltf = await loader.loadAsync(reference.assetUrl)
    return { scene: gltf.scene, clips: [] }
  }
  if (!isConfigurableCharacterId(id)) throw new Error(`Unknown character model: ${id}`)
  const selected = configuration ?? getCharacterConfiguration(id) ?? defaultCharacterConfiguration
  const isPackagedVariant = Object.values(characterConfigurationPresets).some((preset) =>
    sameConfiguration(selected, preset)
  )
  if (!isPackagedVariant) {
    await import('./catalog')
    return loadProviderCharacter(loader, id, configuration)
  }
  const gltf = await loader.loadAsync(
    getCharacterLibraryAssetUrl(serializeCharacterConfiguration(selected))
  )
  return { scene: gltf.scene, clips: [] }
}

export function loadAnimatedCharacter(
  loader: GLTFLoader,
  id: string,
  _animation = 'run',
  configuration?: CharacterConfiguration
): Promise<LoadedCharacter> {
  return loadCharacter(loader, id, configuration)
}

const animationAssets = new Map<
  string,
  { scene: THREE.Object3D; clips: readonly THREE.AnimationClip[] }
>()

function selectAnimationAssetUrl(keys: readonly string[]): string {
  return keys.length > 0 && keys.every((key) => locomotionAnimationKeys.has(key))
    ? characterLocomotionAnimationUrl
    : characterAnimationUrl
}

async function loadCharacterAnimationsFromAsset(
  loader: GLTFLoader,
  assetUrl: string
): Promise<{ scene: THREE.Object3D; clips: readonly THREE.AnimationClip[] }> {
  // Do not cache an in-flight request. SceneHost aborts its LoadingManager when
  // a character is switched, so a promise created by the previous scene can
  // otherwise reject the next character load with its stale AbortError.
  const cached = animationAssets.get(assetUrl)
  if (cached) return cached
  const gltf = await loader.loadAsync(assetUrl)
  const asset = { scene: gltf.scene, clips: gltf.animations }
  animationAssets.set(assetUrl, asset)
  return asset
}

// GLTFLoader sanitizes Cartoon node names, so `DEF-spine.001` becomes
// `DEF-spine001` and side suffixes such as `.R` become `R`.
const referenceAnimationBoneMap: Record<string, string> = {
  'DEF-spine': 'Hips',
  'DEF-spine001': 'Spine',
  'DEF-spine003': 'Spine1',
  'DEF-spine005': 'Neck',
  'DEF-spine006': 'Head',
  'DEF-shoulderR': 'RightShoulder',
  'DEF-upper_armR': 'RightArm',
  'DEF-forearmR': 'RightForeArm',
  'DEF-handR': 'RightHand',
  'DEF-f_index01R': 'RightHandIndex1',
  'DEF-f_index02R': 'RightHandIndex2',
  'DEF-f_middle01R': 'RightHandMiddle1',
  'DEF-f_middle02R': 'RightHandMiddle2',
  'DEF-f_ring01R': 'RightHandRing1',
  'DEF-f_ring02R': 'RightHandRing2',
  'DEF-f_pinky01R': 'RightHandPinky1',
  'DEF-f_pinky02R': 'RightHandPinky2',
  'DEF-thumb01R': 'RightHandThumb1',
  'DEF-thumb02R': 'RightHandThumb2',
  'DEF-shoulderL': 'LeftShoulder',
  'DEF-upper_armL': 'LeftArm',
  'DEF-forearmL': 'LeftForeArm',
  'DEF-handL': 'LeftHand',
  'DEF-f_index01L': 'LeftHandIndex1',
  'DEF-f_index02L': 'LeftHandIndex2',
  'DEF-f_middle01L': 'LeftHandMiddle1',
  'DEF-f_middle02L': 'LeftHandMiddle2',
  'DEF-f_ring01L': 'LeftHandRing1',
  'DEF-f_ring02L': 'LeftHandRing2',
  'DEF-f_pinky01L': 'LeftHandPinky1',
  'DEF-f_pinky02L': 'LeftHandPinky2',
  'DEF-thumb01L': 'LeftHandThumb1',
  'DEF-thumb02L': 'LeftHandThumb2',
  'DEF-thighR': 'RightUpLeg',
  'DEF-shinR': 'RightLeg',
  'DEF-footR': 'RightFoot',
  'DEF-toeR': 'RightToeBase',
  'DEF-thighL': 'LeftUpLeg',
  'DEF-shinL': 'LeftLeg',
  'DEF-footL': 'LeftFoot',
  'DEF-toeL': 'LeftToeBase',
}

function findSkinnedMesh(root: THREE.Object3D): THREE.SkinnedMesh | undefined {
  let result: THREE.SkinnedMesh | undefined
  root.traverse((object) => {
    if (!result && (object as THREE.SkinnedMesh).isSkinnedMesh) {
      result = object as THREE.SkinnedMesh
    }
  })
  return result
}

function cloneAnimationBone(source: THREE.Object3D, bones: THREE.Bone[]): THREE.Bone {
  const bone = new THREE.Bone()
  bone.name = source.name
  bone.position.copy(source.position)
  bone.quaternion.copy(source.quaternion)
  bone.scale.copy(source.scale)
  bones.push(bone)
  source.children.forEach((child) => bone.add(cloneAnimationBone(child, bones)))
  return bone
}

function findAnimationSource(root: THREE.Object3D): THREE.Object3D | THREE.Skeleton | undefined {
  const sourceRoot = root.getObjectByName('Root')
  if (sourceRoot) {
    const bones: THREE.Bone[] = []
    cloneAnimationBone(sourceRoot, bones)
    return new THREE.Skeleton(bones)
  }
  return findSkinnedMesh(root)
}

async function retargetReferenceAnimation(
  clip: THREE.AnimationClip,
  sourceRoot: THREE.Object3D,
  target: THREE.Object3D | undefined
): Promise<THREE.AnimationClip> {
  const source = findAnimationSource(sourceRoot)
  const targetMesh = target ? findSkinnedMesh(target) : undefined
  if (!source || !targetMesh) return clip.clone()
  const { retargetClip } = await import('three/examples/jsm/utils/SkeletonUtils.js')
  const retargeted = retargetClip(targetMesh, source, clip, {
    names: referenceAnimationBoneMap,
    hip: 'DEF-spine',
    scale: 1,
  })
  // SkeletonUtils emits `.bones[BoneName]` bindings for a SkinnedMesh root,
  // while SceneHost mixes clips against the loaded GLTF scene root. Rewrite
  // the paths to the named-bone form used by the shared character clips.
  for (const track of retargeted.tracks) {
    const match = /^\.bones\[([^\]]+)\]\.(.+)$/.exec(track.name)
    if (match) track.name = `${match[1]}.${match[2]}`
  }
  return retargeted
}

/** Loads shared animations without importing the editor catalog. */
export async function loadCharacterAnimations(
  loader: GLTFLoader,
  id: string,
  keys: readonly string[],
  target?: THREE.Object3D
): Promise<LoadedCharacterAnimations> {
  const reference = referenceCharacterIds.includes(id as ReferenceCharacterId)
  if (!isConfigurableCharacterId(id) && !reference) return { clips: [], names: {} }
  const loaded = await loadCharacterAnimationsFromAsset(loader, selectAnimationAssetUrl(keys))
  const clips: THREE.AnimationClip[] = []
  const names: Record<string, string> = {}
  for (const key of keys) {
    const source = loaded.clips.find((clip) => clip.name === animationMap[key])
    if (!source) continue
    const normalized = ['walk', 'run', 'swim'].includes(key)
      ? normalizeInPlaceLocomotionClip(source)
      : source.clone()
    const clip = reference
      ? await retargetReferenceAnimation(normalized, loaded.scene, target)
      : normalized
    clip.name = key
    clips.push(clip)
    names[key] = key
  }
  return { clips, names }
}

export {
  createCharacterAnimationController,
  type CharacterAnimationController,
  type LoadedCharacter,
  type LoadedCharacterAnimations,
  type CharacterManifest,
  type CharacterConfiguration,
}
