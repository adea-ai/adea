import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const assetsDirectory = join(import.meta.dir, '../assets')
const categoryFileCounts = {
  columns: 1,
  curtains: 29,
  doors: 26,
  floors: 19,
  partitions: 117,
  stairs: 105,
  walls: 161,
  windows: 37,
} as const

describe('architecture asset package', () => {
  test('keeps each architecture family in its own category folder', () => {
    expect(readdirSync(assetsDirectory).sort()).toEqual(Object.keys(categoryFileCounts).sort())

    for (const [category, expectedCount] of Object.entries(categoryFileCounts)) {
      const files = readdirSync(join(assetsDirectory, category))
      expect(files.every((file) => file.endsWith('.glb'))).toBe(true)
      expect(files).toHaveLength(expectedCount)
    }
  })
})
