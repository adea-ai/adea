// Agent HQ character catalog backed by the configurable character pack.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  registerCharacterProvider,
  type CharacterManifest,
  type CharacterProvider,
  type LoadedCharacter,
  type LoadedCharacterAnimations,
} from './provider'
import { characterPartAssets, characterPartIds, characterPartSlots } from './customization'
import { characterPartOffsets } from './generated-part-offsets'
import { loadCharacterAnimations as loadRuntimeCharacterAnimations } from './runtime'
import {
  characterConfigurationPresets,
  characterPartName,
  configurableCharacterId,
  createDefaultCharacterConfiguration,
  defaultCharacterConfiguration,
  getCharacterConfiguration,
  getCharacterConfigurationLabel,
  isConfigurableCharacterId,
  serializeCharacterConfiguration,
  validateCharacterConfiguration,
  type CharacterConfiguration,
} from './configuration'

const assetRoot = '/assets/models'
const characterLibraryUrl = `${assetRoot}/characters.glb`

/**
 * The authoring library contains every wearable (and hundreds of duplicate
 * skins). Keep it available for arbitrary custom combinations, but use the
 * compact, generated variants for the configurations shipped in the picker.
 * Loading the full authoring board during the first scene render otherwise
 * spends tens of seconds constructing unused skeletons.
 */
const characterLibraryVariantUrls = {
  default: `${assetRoot}/characters-default.glb`,
  researcher: `${assetRoot}/characters-researcher.glb`,
  builder: `${assetRoot}/characters-builder.glb`,
} as const

type CharacterLibraryVariant = keyof typeof characterLibraryVariantUrls

function sameCharacterConfiguration(
  left: CharacterConfiguration,
  right: CharacterConfiguration
): boolean {
  return (
    left.version === right.version && characterPartSlots.every((slot) => left[slot] === right[slot])
  )
}

/** Resolve the smallest packaged library for a character configuration. */
export function getCharacterLibraryAssetUrl(id: string): string {
  const configuration = getCharacterConfiguration(id)
  if (!configuration) return characterLibraryUrl
  if (sameCharacterConfiguration(configuration, defaultCharacterConfiguration)) {
    return characterLibraryVariantUrls.default
  }
  const preset = characterConfigurationPresets.find(({ configuration: presetConfiguration }) =>
    sameCharacterConfiguration(configuration, presetConfiguration)
  )
  if (preset && preset.id in characterLibraryVariantUrls) {
    return characterLibraryVariantUrls[preset.id as CharacterLibraryVariant]
  }
  return characterLibraryUrl
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

const characterPartIdsByName = new Map(characterPartIds.map((id) => [characterPartName(id), id]))

function configureCharacterLibrary(
  scene: THREE.Object3D,
  configuration: CharacterConfiguration,
  preserveUnselected = false
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
      if (preserveUnselected && partId !== undefined) {
        // Designer previews keep every wearable in the one loaded library so
        // changing a slot only flips visibility instead of rebuilding the
        // scene or fetching another model.
        mesh.visible = false
      } else {
        discardedObjects.push(mesh)
      }
      return
    }
    mesh.visible = true
    if (partId) {
      const [x, y, z] = characterPartOffsets[partId] ?? [0, 0, 0]
      // The checked-in library is an authoring board: its skinned vertices
      // retain the board's per-part placement. Move each selected mesh back
      // to the shared rest-pose origin before the mixer evaluates it.
      mesh.position.set(-x, -y, -z)
    }
  })
  if (!preserveUnselected) {
    // Do not make SceneHost traverse or upload the unselected wearable
    // meshes. Detaching them also lets the temporary GLTF object graph reclaim
    // their geometry while the selected meshes retain shared materials/textures.
    discardedObjects.forEach((object) => object.removeFromParent())
  } else {
    // Unknown helper meshes are never part of a wearable preview or runtime
    // character and should not add draw calls to the designer. This includes
    // skinned helper meshes, so remove every discarded object here.
    discardedObjects.forEach((object) => object.removeFromParent())
  }
  scene.updateMatrixWorld(true)
  return scene
}

/** Apply a new configuration to a full preview library without reloading it. */
export function updateCharacterConfiguration(
  scene: THREE.Object3D,
  configuration: CharacterConfiguration
): THREE.Object3D {
  return configureCharacterLibrary(scene, validateCharacterConfiguration(configuration), true)
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
  const assetId = requestedConfiguration ? serializeCharacterConfiguration(configuration) : id
  const gltf = await loader.loadAsync(getCharacterLibraryAssetUrl(assetId))
  return { scene: configureCharacterLibrary(gltf.scene, configuration), clips: [] }
}

async function loadReferenceCharacter(loader: GLTFLoader, id: string): Promise<LoadedCharacter> {
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

/**
 * Load the full configurable library for the character studio. Unlike the
 * workspace loader, the preview intentionally retains unselected wearables
 * so slot changes can be applied in place.
 */
export async function loadCharacterPreview(
  loader: GLTFLoader,
  id: string,
  requestedConfiguration?: CharacterConfiguration
): Promise<LoadedCharacter> {
  if (!isConfigurableCharacterId(id)) return loadReferenceCharacter(loader, id)
  const configuration = requestedConfiguration
    ? validateCharacterConfiguration(requestedConfiguration)
    : (getCharacterConfiguration(id) ?? createDefaultCharacterConfiguration())
  const gltf = await loader.loadAsync(characterLibraryUrl)
  return { scene: configureCharacterLibrary(gltf.scene, configuration, true), clips: [] }
}

async function loadCatalogCharacterAnimations(
  loader: GLTFLoader,
  id: string,
  keys: readonly string[],
  target?: THREE.Object3D
): Promise<LoadedCharacterAnimations> {
  return loadRuntimeCharacterAnimations(loader, id, keys, target)
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
