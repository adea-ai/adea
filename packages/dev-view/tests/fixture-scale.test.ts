import { describe, expect, test } from 'bun:test'

import { devViewFixtureProjects, scaleDevFixtureProjects } from '../src/sidebar/fixture-scale'

describe('scaleDevFixtureProjects (#666 render-cost case)', () => {
  test('scaling grows every project to the requested session count deterministically', () => {
    const scaled = scaleDevFixtureProjects(devViewFixtureProjects, 1_000)
    for (const project of scaled) {
      expect(project.sessions).toHaveLength(1_000)
      // The real fixture session stays first; its identity is untouched.
      expect(project.sessions[0]).toEqual(
        devViewFixtureProjects.find((p) => p.id === project.id)!.sessions[0]
      )
    }
    // Deterministic ids and titles: the deep link and keyboard targets are
    // stable across runs. The named fixture sessions keep their identity;
    // generated ones start after them and number deterministically.
    const first = scaled[0]!
    expect(first.sessions[1]!.id).toBe('fixture-runtime')
    expect(first.sessions[2]!.id).toBe('fixture-adea-scale-3')
    expect(first.sessions[999]!.id).toBe('fixture-adea-scale-1000')
    expect(first.sessions[999]!.title).toBe('Session 1000')
    // Each generated session runs in its own worktree, one sidebar row each.
    expect(first.sessions[999]!.worktreeId).toBe('fixture-adea-scale-1000-worktree')
    expect(first.worktrees?.filter((worktree) => worktree.id.includes('-scale-'))).toHaveLength(998)
    const ids = new Set(scaled.flatMap((p) => p.sessions.map((s) => s.id)))
    expect(ids.size).toBe(scaled.reduce((n, p) => n + p.sessions.length, 0))
  })

  test('a scale at or below the current count is a no-op, never a truncation', () => {
    const one = scaleDevFixtureProjects(devViewFixtureProjects, 1)
    expect(one).toEqual(devViewFixtureProjects)
    const zero = scaleDevFixtureProjects(devViewFixtureProjects, 0)
    expect(zero).toBe(devViewFixtureProjects)
    const nan = scaleDevFixtureProjects(devViewFixtureProjects, Number.NaN)
    expect(nan).toBe(devViewFixtureProjects)
  })
})
