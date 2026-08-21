/**
 * Browser-light degen character metadata for selectors, route parsing, and menus.
 *
 * Keep this entrypoint free of Three.js and loader imports. Scene runtimes can
 * import the package root when they actually need to load a character.
 *
 * Legacy character IDs remain type-compatible for shared scene-shell APIs.
 * Agent HQ scene routes currently expose only the ithappy character provider.
 */
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

export const degenCharacterLabels: Record<DegenCharacterId, string> = {
  ape: "Ape",
  cat: "Cat",
  alien: "Alien",
  human: "Human",
  frog: "Frog",
  doge: "Doge",
  bull: "Bull",
  panda: "Panda",
  tiger: "Tiger",
  bear: "Bear",
  hydra: "Hydra",
  kaiju: "Kaiju",
  carp: "Carp",
  fish: "Fish",
  chicken: "Chicken",
  owl: "Owl",
  lizard: "Lizard",
  unicorn: "Unicorn",
};

/** Optional icons supplied by a deployment-specific character pack. */
export const degenCharacterIconUrls: Partial<Record<DegenCharacterId, string>> = {};

export function isDegenCharacterId(value: string | undefined): value is DegenCharacterId {
  return value !== undefined && degenCharacterIds.includes(value as DegenCharacterId);
}
