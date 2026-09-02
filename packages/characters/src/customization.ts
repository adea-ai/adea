import { generatedCharacterParts } from "./generated-parts";

export type CharacterPartSlot =
  | "body"
  | "ears"
  | "face"
  | "hair"
  | "hat"
  | "top"
  | "bottom"
  | "shoes"
  | "socks"
  | "glasses"
  | "gloves"
  | "accessory"
  | "costume";

export interface CharacterPartOption {
  id: string;
  label: string;
  slot: CharacterPartSlot;
  /** Path relative to /assets/models. */
  file: string;
}

/** Every body, ears, face, clothing, and accessory asset in the character pack. */
export const characterPartCatalog: readonly CharacterPartOption[] = generatedCharacterParts;

export const characterPartSlots: readonly CharacterPartSlot[] = [
  "body",
  "ears",
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
  "costume",
];

export function characterPartsBySlot(slot: CharacterPartSlot): readonly CharacterPartOption[] {
  return characterPartCatalog.filter((part) => part.slot === slot);
}

export const characterPartIds = characterPartCatalog.map((part) => part.id);
export type CharacterPartId = string;

export const characterPartAssets = characterPartCatalog.map((part) => ({
  id: part.id,
  label: part.label,
  assetUrl: `/assets/models/${part.file}`,
}));
