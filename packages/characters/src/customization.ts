import { generatedCharacterParts } from "./generated-parts";

export type CharacterPartSlot =
  | "body"
  | "face"
  | "hair"
  | "hat"
  | "top"
  | "bottom"
  | "shoes"
  | "socks"
  | "glasses"
  | "gloves"
  | "accessory";

export interface CharacterPartOption {
  id: string;
  label: string;
  slot: CharacterPartSlot;
  /** Path relative to /assets/models/character-parts. */
  file: string;
}

/** Every body, face, clothing, and accessory asset from the Cute pack. */
export const characterPartCatalog: readonly CharacterPartOption[] = generatedCharacterParts;

export const characterPartSlots: readonly CharacterPartSlot[] = [
  "body",
  "face",
  "hair",
  "hat",
  "top",
  "bottom",
  "shoes",
  "socks",
  "glasses",
  "gloves",
  "accessory",
];

export function characterPartsBySlot(slot: CharacterPartSlot): readonly CharacterPartOption[] {
  return characterPartCatalog.filter((part) => part.slot === slot);
}

export const characterPartIds = characterPartCatalog.map((part) => part.id);
export type CharacterPartId = string;

export const characterPartAssets = characterPartCatalog.map((part) => ({
  id: part.id,
  label: part.label,
  assetUrl: `/assets/models/character-parts/${part.file}`,
}));
