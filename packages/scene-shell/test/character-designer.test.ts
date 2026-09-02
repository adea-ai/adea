import { describe, expect, test } from 'bun:test'
import { createDefaultCharacterConfiguration } from '@agent-hq/characters'
import {
  characterDesignerSlotCategories,
  hasCharacterDesignerChanges,
} from '../src/character-designer'

describe('character designer change tracking', () => {
  test('exposes every configurable character slot as a category', () => {
    expect(characterDesignerSlotCategories.map(({ id }) => id)).toEqual([
      'body',
      'ears',
      'face',
      'hair',
      'hat',
      'top',
      'bottom',
      'shoes',
      'socks',
      'glasses',
      'gloves',
      'accessory',
      'costume',
    ])
  })

  test('does not mark an unchanged character as dirty', () => {
    const configuration = createDefaultCharacterConfiguration()

    expect(
      hasCharacterDesignerChanges(
        { character: 'configurable', configuration },
        { character: 'configurable', configuration }
      )
    ).toBe(false)
  })

  test('marks a changed part as dirty', () => {
    const saved = createDefaultCharacterConfiguration()
    const current = { ...saved, hair: 'hair-hairstyle-male-01' }

    expect(
      hasCharacterDesignerChanges(
        { character: 'configurable', configuration: current },
        { character: 'configurable', configuration: saved }
      )
    ).toBe(true)
  })

  test('marks switching between reference and custom characters as dirty', () => {
    const configuration = createDefaultCharacterConfiguration()

    expect(
      hasCharacterDesignerChanges(
        { character: 'f_1', configuration: undefined },
        { character: 'configurable', configuration }
      )
    ).toBe(true)
  })
})
