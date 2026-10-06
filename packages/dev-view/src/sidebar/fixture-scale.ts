/*
 * The fixture-workspace scale seam (#666): a component-free module so model
 * tests can exercise the render-cost case without pulling the entry's
 * component graph into a server-side Solid runtime.
 */
import type { DevProjectFixture } from '../dev-workspace-entry'

export const devViewFixtureProjects: readonly DevProjectFixture[] = [
  {
    id: 'fixture-adea',
    name: 'Example project',
    repository: 'example/repository',
    branch: 'feature/example',
    sessions: [
      {
        id: 'fixture-shell',
        title: 'Dev View foundation',
        state: 'active',
        generation: 1,
        badges: {
          harness: 'working',
          dirty: true,
          checks: 'running',
          ports: [3000],
        },
      },
      { id: 'fixture-runtime', title: 'Runtime contracts', state: 'ready', generation: 1 },
    ],
  },
  {
    id: 'fixture-tools',
    name: 'Runtime tools',
    repository: 'example/tools',
    branch: 'feature/runtime',
    sessions: [
      {
        id: 'fixture-tools-session',
        title: 'Other project session',
        state: 'ready',
        generation: 1,
        badges: { checks: 'failed', harness: 'awaiting_input' },
      },
      {
        id: 'fixture-archived',
        title: 'Archived discovery',
        state: 'archived',
        generation: 1,
      },
    ],
  },
]

/**
 * Scale a fixture workspace up for render-cost cases (#666): each project's
 * session list grows to `scale` entries (the real fixture session stays
 * first), with deterministic ids and titles so deep links and keyboard walks
 * stay stable across runs. A project already at or above `scale` is
 * untouched — never a truncation of named fixtures.
 */
export function scaleDevFixtureProjects(
  base: readonly DevProjectFixture[],
  scale: number
): readonly DevProjectFixture[] {
  if (!Number.isFinite(scale) || scale < 1) return base
  return base.map((project) => {
    const existing = project.sessions
    if (existing.length >= scale) return project
    const generated = Array.from({ length: scale - existing.length }, (_, index) => ({
      id: `${project.id}-scale-${existing.length + index + 1}`,
      title: `Session ${existing.length + index + 1}`,
      state: 'ready' as const,
      generation: 1,
    }))
    return { ...project, sessions: [...existing, ...generated] }
  })
}
