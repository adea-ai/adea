import { describe, expect, test } from 'bun:test'
import {
  configurableCharacterId,
  getCharacterConfiguration,
  getCharacterLibraryAssetUrl,
  isCharacterConfigurationId,
  serializeCharacterConfiguration,
} from '../src/runtime'

describe('character runtime entrypoint', () => {
  test('keeps built-in character variants on the compact asset path', () => {
    expect(getCharacterConfiguration(configurableCharacterId)).toBeDefined()
    expect(getCharacterLibraryAssetUrl(configurableCharacterId)).toBe(
      '/assets/models/characters-default.glb'
    )
    expect(getCharacterLibraryAssetUrl('researcher')).toBe(
      '/assets/models/characters-researcher.glb'
    )
    expect(getCharacterLibraryAssetUrl('builder')).toBe('/assets/models/characters-builder.glb')
  })

  test('round-trips a runtime configuration without loading the wearable catalog', () => {
    const configuration = getCharacterConfiguration('researcher')
    expect(configuration).toBeDefined()
    const serialized = serializeCharacterConfiguration(configuration!)

    expect(isCharacterConfigurationId(serialized)).toBe(true)
    expect(getCharacterLibraryAssetUrl(serialized)).toBe('/assets/models/characters-researcher.glb')
  })
})
