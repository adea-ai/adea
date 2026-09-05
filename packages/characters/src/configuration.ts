import { z } from "zod";
import {
  characterPartCatalog,
  characterPartSlots,
  type CharacterPartId,
  type CharacterPartOption,
  type CharacterPartSlot,
} from "./customization";

export const CHARACTER_CONFIGURATION_VERSION = 1 as const;
export const configurableCharacterId = "configurable" as const;

export type CharacterConfiguration = {
  version: typeof CHARACTER_CONFIGURATION_VERSION;
  body: CharacterPartId;
  ears: CharacterPartId | null;
  face: CharacterPartId | null;
  hair: CharacterPartId | null;
  hat: CharacterPartId | null;
  top: CharacterPartId | null;
  bottom: CharacterPartId | null;
  shoes: CharacterPartId | null;
  socks: CharacterPartId | null;
  glasses: CharacterPartId | null;
  gloves: CharacterPartId | null;
  accessory: CharacterPartId | null;
  costume: CharacterPartId | null;
};

export type CharacterConfigurationSlot = keyof Omit<CharacterConfiguration, "version">;

const nullablePartId = z.string().min(1).nullable();
export const characterConfigurationSchema = z
  .object({
    version: z.literal(CHARACTER_CONFIGURATION_VERSION),
    body: z.string().min(1),
    ears: nullablePartId,
    face: nullablePartId,
    hair: nullablePartId,
    hat: nullablePartId,
    top: nullablePartId,
    bottom: nullablePartId,
    shoes: nullablePartId,
    socks: nullablePartId,
    glasses: nullablePartId,
    gloves: nullablePartId,
    accessory: nullablePartId,
    costume: nullablePartId,
  })
  .strict();

const catalogById = new Map(characterPartCatalog.map((part) => [part.id, part]));

function partIdFor(slot: CharacterPartSlot, fileName: string): CharacterPartId {
  const part = characterPartCatalog.find(
    (candidate) => candidate.slot === slot && candidate.file.endsWith(`/${fileName}.glb`)
  );
  if (!part) throw new Error(`Missing default ${slot} character part: ${fileName}`);
  return part.id;
}

function makeConfiguration(
  values: Partial<Omit<CharacterConfiguration, "version" | "body">> & {
    body?: CharacterPartId;
  } = {}
): CharacterConfiguration {
  return {
    version: CHARACTER_CONFIGURATION_VERSION,
    body: values.body ?? partIdFor("body", "Body_01"),
    ears: values.ears ?? partIdFor("ears", "Ears_01"),
    face: values.face ?? partIdFor("face", "Female_Emotion_Usual_01"),
    hair: values.hair ?? partIdFor("hair", "Hairstyle_Female_01"),
    hat: values.hat ?? null,
    top: values.top ?? partIdFor("top", "Outfit_01"),
    bottom: values.bottom ?? partIdFor("bottom", "Pants_01"),
    shoes: values.shoes ?? partIdFor("shoes", "Shoe_Sneakers_01"),
    socks: values.socks ?? null,
    glasses: values.glasses ?? null,
    gloves: values.gloves ?? null,
    accessory: values.accessory ?? null,
    costume: values.costume ?? null,
  };
}

export function createDefaultCharacterConfiguration(): CharacterConfiguration {
  return makeConfiguration();
}

export const defaultCharacterConfiguration = Object.freeze(
  createDefaultCharacterConfiguration()
) as CharacterConfiguration;

function validatePart(slot: CharacterConfigurationSlot, value: string | null): void {
  if (value === null) {
    if (slot === "body") throw new Error("body character part is required");
    return;
  }
  const part = catalogById.get(value);
  if (!part) throw new Error(`Unknown character part: ${value}`);
  if (part.slot !== slot) {
    throw new Error(`Character part ${value} belongs to ${part.slot}, not ${slot}`);
  }
}

export function validateCharacterConfiguration(input: unknown): CharacterConfiguration {
  const configuration = characterConfigurationSchema.parse(input);
  for (const slot of characterPartSlots as readonly CharacterConfigurationSlot[]) {
    validatePart(slot, configuration[slot]);
  }
  return configuration;
}

const serializedSlots = characterPartSlots as readonly CharacterConfigurationSlot[];
const emptyPartToken = "-";

/**
 * Serialize a configuration without base64 or JSON so the result is stable,
 * readable in shared links, and safe to pass through URLSearchParams.
 */
export function serializeCharacterConfiguration(configuration: CharacterConfiguration): string {
  const validated = validateCharacterConfiguration(configuration);
  const values = serializedSlots.map((slot) => validated[slot] ?? emptyPartToken);
  return `character:v${validated.version}:${values.join("|")}`;
}

export function parseCharacterConfiguration(
  value: string | undefined
): CharacterConfiguration | undefined {
  if (!value?.startsWith("character:v1:")) return undefined;
  const values = value.slice("character:v1:".length).split("|");
  if (values.length !== serializedSlots.length) return undefined;
  const raw = {
    version: CHARACTER_CONFIGURATION_VERSION,
    ...Object.fromEntries(
      serializedSlots.map((slot, index) => [
        slot,
        values[index] === emptyPartToken ? null : values[index],
      ])
    ),
  };
  try {
    return validateCharacterConfiguration(raw);
  } catch {
    return undefined;
  }
}

export function isCharacterConfigurationId(value: string | undefined): boolean {
  return parseCharacterConfiguration(value) !== undefined;
}

export type CharacterConfigurationPreset = {
  id: string;
  label: string;
  configuration: CharacterConfiguration;
};

const preset = (
  id: string,
  label: string,
  values: Parameters<typeof makeConfiguration>[0]
): CharacterConfigurationPreset => ({
  id,
  label,
  configuration: makeConfiguration(values),
});

export const characterConfigurationPresets: readonly CharacterConfigurationPreset[] = [
  preset("default", "Default", {}),
  preset("researcher", "Researcher", {
    body: partIdFor("body", "Body_05"),
    face: partIdFor("face", "Male_Emotion_Usual_01"),
    hair: partIdFor("hair", "Hairstyle_Male_03"),
    hat: partIdFor("hat", "Hat_01"),
    top: partIdFor("top", "Outwear_01"),
    bottom: partIdFor("bottom", "Pants_03"),
    shoes: partIdFor("shoes", "Shoe_Sneakers_03"),
    glasses: partIdFor("glasses", "Glasses_01"),
    gloves: partIdFor("gloves", "Gloves_01"),
    accessory: partIdFor("accessory", "Beard_01"),
  }),
  preset("builder", "Builder", {
    body: partIdFor("body", "Body_12"),
    face: partIdFor("face", "Male_Emotion_Happy_01"),
    hair: partIdFor("hair", "Hairstyle_Female_07"),
    top: null,
    bottom: partIdFor("bottom", "Shorts_01"),
    costume: partIdFor("costume", "Costume_10_01"),
    shoes: partIdFor("shoes", "Shoe_Slippers_01"),
    gloves: partIdFor("gloves", "Gloves_05"),
    accessory: partIdFor("accessory", "Bandage_01"),
  }),
] as const;

const presetsById = new Map(characterConfigurationPresets.map((item) => [item.id, item]));

export function getCharacterConfiguration(
  id: string | undefined
): CharacterConfiguration | undefined {
  if (id === configurableCharacterId || id === "default") {
    return createDefaultCharacterConfiguration();
  }
  const serialized = parseCharacterConfiguration(id);
  if (serialized) return serialized;
  const selectedPreset = id ? presetsById.get(id) : undefined;
  return selectedPreset ? { ...selectedPreset.configuration } : undefined;
}

export function isConfigurableCharacterId(value: string | undefined): boolean {
  return (
    value === configurableCharacterId ||
    Boolean(value && presetsById.has(value)) ||
    isCharacterConfigurationId(value)
  );
}

export function getCharacterConfigurationLabel(id: string): string | undefined {
  if (id === configurableCharacterId) return "Custom";
  if (isCharacterConfigurationId(id)) return "Character";
  return presetsById.get(id)?.label;
}

export function characterPartName(partId: CharacterPartId): string {
  const part = catalogById.get(partId);
  if (!part) throw new Error(`Unknown character part: ${partId}`);
  return part.file
    .split("/")
    .pop()!
    .replace(/\.glb$/i, "");
}

export function characterPartForId(partId: CharacterPartId): CharacterPartOption {
  const part = catalogById.get(partId);
  if (!part) throw new Error(`Unknown character part: ${partId}`);
  return part;
}
