import { describe, expect, test } from 'bun:test'
import { Briefcase, Folder, Utensils } from 'lucide-solid'

import { DEFAULT_PROJECT_ICON_KEY } from '../../src/project-identity-fields'
import { projectIconFor } from '../../src/project-icon'

describe('projectIconFor', () => {
  test('a project without an icon key wears the default folder', () => {
    expect(DEFAULT_PROJECT_ICON_KEY).toBe('folder')
    expect(projectIconFor(undefined)).toBe(Folder)
    expect(projectIconFor('')).toBe(Folder)
    // The default key is in the curated set, so it resolves through the picker's own table.
    expect(typeof projectIconFor(DEFAULT_PROJECT_ICON_KEY)).toBe('function')
  })

  test('older free-text keys keep their themed glyph', () => {
    expect(projectIconFor('kitchen')).toBe(Utensils)
    expect(projectIconFor('office-work')).toBe(Briefcase)
  })

  test('an unknown key falls back to the folder rather than an empty tile', () => {
    expect(projectIconFor('zzz-unknown')).toBe(Folder)
  })
})
