import { describe, expect, test } from 'bun:test'

import { devViewFixtureGroups, scaleDevFixtureGroups } from '../src/sidebar/fixture-scale'

describe('scaleDevFixtureGroups (#666 render-cost case)', () => {
  test('scaling grows every project to the requested session count deterministically', () => {
    const scaled = scaleDevFixtureGroups(devViewFixtureGroups, 1_000)
    for (const group of scaled) {
      for (const project of group.projects) {
        expect(project.sessions).toHaveLength(1_000)
        // The real fixture session stays first; its identity is untouched.
        expect(project.sessions[0]).toEqual(
          devViewFixtureGroups
            .find((g) => g.id === group.id)!
            .projects.find((p) => p.id === project.id)!.sessions[0]
        )
      }
    }
    // Deterministic ids and titles: the deep link and keyboard targets are
    // stable across runs.
    const first = scaled[0]!.projects[0]!
    // The named fixture sessions keep their identity; generated ones start
    // after them and number deterministically.
    expect(first.sessions[1]!.id).toBe('fixture-runtime')
    expect(first.sessions[2]!.id).toBe('fixture-adea-scale-3')
    expect(first.sessions[999]!.id).toBe('fixture-adea-scale-1000')
    expect(first.sessions[999]!.title).toBe('Session 1000')
    const ids = new Set(
      scaled.flatMap((g) => g.projects.flatMap((p) => p.sessions.map((s) => s.id)))
    )
    expect(ids.size).toBe(
      scaled.reduce((n, g) => n + g.projects.reduce((m, p) => m + p.sessions.length, 0), 0)
    )
  })

  test('a scale at or below the current count is a no-op, never a truncation', () => {
    const one = scaleDevFixtureGroups(devViewFixtureGroups, 1)
    expect(one).toEqual(devViewFixtureGroups)
    const zero = scaleDevFixtureGroups(devViewFixtureGroups, 0)
    expect(zero).toBe(devViewFixtureGroups)
    const nan = scaleDevFixtureGroups(devViewFixtureGroups, Number.NaN)
    expect(nan).toBe(devViewFixtureGroups)
  })
})
