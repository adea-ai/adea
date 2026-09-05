import { describe, expect, test } from "bun:test";
import {
  characterConfigurationPresets,
  createDefaultCharacterConfiguration,
  getCharacterConfiguration,
  isCharacterConfigurationId,
  parseCharacterConfiguration,
  serializeCharacterConfiguration,
  validateCharacterConfiguration,
} from "../src";

describe("configurable character configurations", () => {
  test("creates a valid deterministic default", () => {
    const configuration = createDefaultCharacterConfiguration();

    expect(configuration.version).toBe(1);
    expect(() => validateCharacterConfiguration(configuration)).not.toThrow();
    expect(serializeCharacterConfiguration(configuration)).toBe(
      "character:v1:body-body-01|ears-ears-01|face-female-emotion-usual-01|hair-hairstyle-female-01|-|top-outfit-01|bottom-pants-01|shoes-shoe-sneakers-01|-|-|-|-|-"
    );
  });

  test("round-trips URL-safe serialized configurations", () => {
    const configuration = createDefaultCharacterConfiguration();
    const serialized = serializeCharacterConfiguration({
      ...configuration,
      ears: null,
      hat: "hat-hat-01",
      glasses: "glasses-glasses-01",
      accessory: null,
    });

    expect(isCharacterConfigurationId(serialized)).toBe(true);
    expect(parseCharacterConfiguration(serialized)).toEqual({
      ...configuration,
      ears: null,
      hat: "hat-hat-01",
      glasses: "glasses-glasses-01",
      accessory: null,
    });
  });

  test("ships complete presets that validate against the catalog", () => {
    expect(characterConfigurationPresets.length).toBeGreaterThanOrEqual(3);
    for (const preset of characterConfigurationPresets) {
      expect(() => validateCharacterConfiguration(preset.configuration)).not.toThrow();
      expect(getCharacterConfiguration(preset.id)).toEqual(preset.configuration);
    }
  });

  test("rejects a part assigned to the wrong slot", () => {
    expect(() =>
      validateCharacterConfiguration({
        ...createDefaultCharacterConfiguration(),
        hat: "body-body-02",
      })
    ).toThrow("belongs to body, not hat");
  });
});
