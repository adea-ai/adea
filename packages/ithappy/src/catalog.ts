export type IthappyCustomCharacterConfig = {
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

export const ithappyCharacterIds = [
  "cashier",
  "security",
  "showgirl",
  "gambler",
  "high-roller",
] as const;
export type IthappyCharacterId = (typeof ithappyCharacterIds)[number];

export const ithappyCharacterLabels: Record<IthappyCharacterId, string> = {
  cashier: "Cashier",
  security: "Security",
  showgirl: "Showgirl",
  gambler: "Gambler",
  "high-roller": "High Roller",
};

export const ithappyCharacterIconUrls: Partial<Record<IthappyCharacterId, string>> = {};

export const ithappyCustomCharacterPresets = {
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
} as const satisfies Record<string, { label: string; config: IthappyCustomCharacterConfig }>;

export const ithappyCustomCharacterIds = Object.keys(ithappyCustomCharacterPresets) as Array<
  keyof typeof ithappyCustomCharacterPresets
>;
export type IthappyCustomCharacterId = (typeof ithappyCustomCharacterIds)[number];

export const allIthappyCharacterIds: readonly string[] = [
  ...ithappyCharacterIds,
  ...ithappyCustomCharacterIds,
];

export function getCustomCharacterLabel(id: string): string | undefined {
  return id in ithappyCustomCharacterPresets
    ? ithappyCustomCharacterPresets[id as keyof typeof ithappyCustomCharacterPresets].label
    : undefined;
}
