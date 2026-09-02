// Agent HQ character catalog backed by the configurable character pack.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { retargetClip } from 'three/examples/jsm/utils/SkeletonUtils.js'
import {
  normalizeInPlaceLocomotionClip,
  registerCharacterProvider,
  type CharacterManifest,
  type CharacterProvider,
  type LoadedCharacter,
  type LoadedCharacterAnimations,
} from './provider'
import { characterPartAssets, characterPartIds } from './customization'
import { characterPartOffsets } from './generated-part-offsets'
import {
  characterConfigurationPresets,
  characterPartName,
  configurableCharacterId,
  createDefaultCharacterConfiguration,
  getCharacterConfiguration,
  getCharacterConfigurationLabel,
  isConfigurableCharacterId,
  validateCharacterConfiguration,
  type CharacterConfiguration,
} from './configuration'

const assetRoot = '/assets/models'
const characterLibraryUrl = `${assetRoot}/characters.glb`
const characterAnimationUrl = `${assetRoot}/runtime.glb`

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

const referenceCharacterLabel = (id: ReferenceCharacterId): string => {
  const [family, number] = id.split('_')
  return `Example ${family.toUpperCase()} ${number?.padStart(2, '0') ?? id}`
}

export const characterLabels = Object.fromEntries([
  [configurableCharacterId, 'Custom'],
  ...referenceCharacterIds.map((id) => [id, referenceCharacterLabel(id)]),
]) as Record<CharacterId, string>

export const characterIconUrls: Partial<Record<CharacterId, string>> = {}

export const referenceCharacterAssets = referenceCharacterIds.map((id) => ({
  id,
  label: characterLabels[id],
  assetUrl: `${assetRoot}/_complete/${id}.glb`,
}))

/** Complete skinned source library used by the configurable runtime. */
export const characterLibraryAssets = [
  {
    id: 'characters-library',
    label: 'Characters Library',
    assetUrl: characterLibraryUrl,
  },
] as const

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

export function isCharacterId(value: string | undefined): value is CharacterId {
  return value !== undefined && characterIds.includes(value as CharacterId)
}

export const customCharacterIds: readonly string[] = characterConfigurationPresets.map(
  (preset) => preset.id
)
export type CustomCharacterId = string

export function isCustomCharacterId(value: string | undefined): boolean {
  return isConfigurableCharacterId(value) && !isCharacterId(value)
}

export function getCustomCharacterLabel(id: string): string | undefined {
  return getCharacterConfigurationLabel(id)
}

export const allCharacterIds: readonly string[] = [...characterIds]

export { characterPartAssets, characterPartIds }
export type { CharacterPartId } from './customization'

function getManifest(id: string): CharacterManifest | undefined {
  if (isConfigurableCharacterId(id)) {
    return {
      id,
      label: getCharacterConfigurationLabel(id) ?? 'Character',
      assetUrl: characterLibraryUrl,
    }
  }
  if (referenceCharacterIds.includes(id as ReferenceCharacterId)) {
    return {
      id,
      label: characterLabels[id as ReferenceCharacterId],
      assetUrl: `${assetRoot}/_complete/${id}.glb`,
    }
  }
  return undefined
}

let animationAsset: {
  scene: THREE.Object3D
  clips: readonly THREE.AnimationClip[]
} | undefined

const characterPartIdsByName = new Map(characterPartIds.map((id) => [characterPartName(id), id]))

function configureCharacterLibrary(
  scene: THREE.Object3D,
  configuration: CharacterConfiguration
): THREE.Object3D {
  const selectedNames = new Set(
    Object.values(configuration)
      .filter((value): value is string => typeof value === 'string')
      .map((value) => characterPartName(value))
  )
  const discardedObjects: THREE.Object3D[] = []
  scene.traverse((object) => {
    if (!(object as THREE.SkinnedMesh).isSkinnedMesh) {
      if (object instanceof THREE.Mesh) discardedObjects.push(object)
      return
    }
    const mesh = object as THREE.SkinnedMesh
    const partId = characterPartIdsByName.get(mesh.name)
    const selected = partId !== undefined && selectedNames.has(mesh.name)
    if (!selected) {
      discardedObjects.push(mesh)
      return
    }
    if (partId) {
      const [x, y, z] = characterPartOffsets[partId] ?? [0, 0, 0]
      // The checked-in library is an authoring board: its skinned vertices
      // retain the board's per-part placement. Move each selected mesh back
      // to the shared rest-pose origin before the mixer evaluates it.
      mesh.position.set(-x, -y, -z)
    }
  })
  // Do not make SceneHost traverse or upload the unselected wearable
  // meshes. Detaching them also lets the temporary GLTF object graph reclaim
  // their geometry while the selected meshes retain shared materials/textures.
  discardedObjects.forEach((object) => object.removeFromParent())
  scene.updateMatrixWorld(true)
  return scene
}

async function loadConfigurableCharacter(
  loader: GLTFLoader,
  id: string,
  requestedConfiguration?: CharacterConfiguration
): Promise<LoadedCharacter> {
  const configuration = requestedConfiguration
    ? validateCharacterConfiguration(requestedConfiguration)
    : (getCharacterConfiguration(id) ?? createDefaultCharacterConfiguration())
  const manifest = getManifest(id)
  if (!manifest) throw new Error(`Unknown character: ${id}`)
  const gltf = await loader.loadAsync(manifest.assetUrl)
  return { scene: configureCharacterLibrary(gltf.scene, configuration), clips: [] }
}

async function loadReferenceCharacter(
  loader: GLTFLoader,
  id: string
): Promise<LoadedCharacter> {
  const manifest = getManifest(id)
  if (!manifest || !referenceCharacterIds.includes(id as ReferenceCharacterId))
    throw new Error(`Unknown reference character: ${id}`)
  const gltf = await loader.loadAsync(manifest.assetUrl)
  return { scene: gltf.scene, clips: [] }
}

async function loadCatalogCharacter(
  loader: GLTFLoader,
  id: string,
  configuration?: CharacterConfiguration
): Promise<LoadedCharacter> {
  return isConfigurableCharacterId(id)
    ? loadConfigurableCharacter(loader, id, configuration)
    : loadReferenceCharacter(loader, id)
}

async function loadCharacterAnimationsFromAsset(
  loader: GLTFLoader
): Promise<{ scene: THREE.Object3D; clips: readonly THREE.AnimationClip[] }> {
  // Do not cache an in-flight request. SceneHost aborts its LoadingManager when
  // a character is switched, so a promise created by the previous scene can
  // otherwise reject the next character load with its stale AbortError.
  if (animationAsset) return animationAsset
  const gltf = await loader.loadAsync(characterAnimationUrl)
  animationAsset = { scene: gltf.scene, clips: gltf.animations }
  return animationAsset
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
    if (!result && (object as THREE.SkinnedMesh).isSkinnedMesh)
      result = object as THREE.SkinnedMesh
  })
  return result
}

function cloneAnimationBone(
  source: THREE.Object3D,
  bones: THREE.Bone[]
): THREE.Bone {
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

function retargetReferenceAnimation(
  clip: THREE.AnimationClip,
  sourceRoot: THREE.Object3D,
  target: THREE.Object3D | undefined
): THREE.AnimationClip {
  const source = findAnimationSource(sourceRoot)
  const targetMesh = target ? findSkinnedMesh(target) : undefined
  if (!source || !targetMesh) return clip.clone()
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

async function loadCatalogCharacterAnimations(
  loader: GLTFLoader,
  id: string,
  keys: readonly string[],
  target?: THREE.Object3D
): Promise<LoadedCharacterAnimations> {
  const reference = referenceCharacterIds.includes(id as ReferenceCharacterId)
  if (!isConfigurableCharacterId(id) && !reference) return { clips: [], names: {} }
  const animationAsset = await loadCharacterAnimationsFromAsset(loader)
  const clips: THREE.AnimationClip[] = []
  const names: Record<string, string> = {}
  for (const key of keys) {
    const source = animationAsset.clips.find((clip) => clip.name === animationMap[key])
    if (!source) continue
    const normalized = ['walk', 'run', 'swim'].includes(key)
      ? normalizeInPlaceLocomotionClip(source)
      : source.clone()
    const clip = reference
      ? retargetReferenceAnimation(normalized, animationAsset.scene, target)
      : normalized
    clip.name = key
    clips.push(clip)
    names[key] = key
  }
  return { clips, names }
}

const characterProvider: CharacterProvider = {
  characterIds: allCharacterIds,
  acceptsCharacterId: isConfigurableCharacterId,
  getManifest,
  loadCharacter: loadCatalogCharacter,
  loadAnimatedCharacter: (loader, id, _animation, configuration) =>
    loadCatalogCharacter(loader, id, configuration),
  loadCharacterAnimations: loadCatalogCharacterAnimations,
}

registerCharacterProvider(characterProvider)
