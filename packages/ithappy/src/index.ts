export {
  ithappyCharacterIds,
  ithappyCharacterLabels,
  ithappyCharacterIconUrls,
  isIthappyCharacterId,
  type IthappyCharacterId,
  ithappyCharacterPartIds,
  ithappyCharacterPartAssets,
  type IthappyCharacterPartId,
  ithappyCustomCharacterIds,
  allIthappyCharacterIds,
  isIthappyCustomCharacterId,
  getCustomCharacterLabel,
  getIthappyCharacterManifest,
  loadIthappyCharacter,
  loadIthappyCharacterAnimations,
  type LoadedCharacter,
  type LoadedCharacterAnimations,
} from "./characters";

export {
  createAmbientAnimals,
  type AmbientAnimalId,
  type AmbientAnimalConfig,
  type AmbientAnimals,
} from "./animals";

export { ithappyInteriorPropAssets, ithappyPropAssets } from "./props";

export {
  ithappyPartCatalog,
  ithappyPartSlots,
  ithappyPartsBySlot,
  assembleIthappyCharacter,
  assembleIthappyCharacterByPreset,
  type IthappyPartSlot,
  type IthappyPartOption,
  type AssembledCharacter,
} from "./custom-characters";

export { ithappyCustomCharacterPresets, type IthappyCustomCharacterConfig } from "./catalog";
