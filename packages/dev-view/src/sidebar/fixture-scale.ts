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
    branch: 'main',
    worktrees: [
      {
        id: 'fixture-adea-checkout',
        projectId: 'fixture-adea',
        kind: 'primary',
        headRef: 'main',
        // The source control pane's remote section reads the checked-out
        // worktree's repository; the fixture worktrees carry one so the pane
        // renders its rows in the shell harness.
        repoId: 'fixture-repo-adea',
      },
      {
        id: 'fixture-adea-example',
        projectId: 'fixture-adea',
        kind: 'managed',
        branchRef: 'feature/example',
        title: 'Dev View foundation',
        repoId: 'fixture-repo-adea',
      },
    ],
    sessions: [
      {
        id: 'fixture-shell',
        title: 'Dev View foundation',
        worktreeId: 'fixture-adea-example',
        state: 'active',
        generation: 1,
        badges: {
          harness: 'working',
          dirty: true,
          checks: 'running',
          ports: [3000],
        },
      },
      {
        id: 'fixture-runtime',
        title: 'Runtime contracts',
        worktreeId: 'fixture-adea-checkout',
        state: 'ready',
        generation: 1,
      },
    ],
  },
  {
    id: 'fixture-tools',
    name: 'Runtime tools',
    repository: 'example/tools',
    branch: 'feature/runtime',
    worktrees: [
      {
        id: 'fixture-tools-checkout',
        projectId: 'fixture-tools',
        kind: 'primary',
        headRef: 'feature/runtime',
      },
      {
        id: 'fixture-tools-docs',
        projectId: 'fixture-tools',
        kind: 'managed',
        branchRef: 'docs/runtime-notes',
      },
    ],
    sessions: [
      {
        id: 'fixture-tools-session',
        title: 'Other project session',
        worktreeId: 'fixture-tools-checkout',
        state: 'ready',
        generation: 1,
        badges: { checks: 'failed', harness: 'awaiting_input' },
      },
      {
        id: 'fixture-archived',
        title: 'Archived discovery',
        worktreeId: 'fixture-tools-checkout',
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
 * stay stable across runs. Each generated session runs in its own generated
 * worktree, so the shared sidebar (ADR 0011) renders one worktree row per
 * generated session. A project already at or above `scale` is untouched —
 * never a truncation of named fixtures.
 */
export function scaleDevFixtureProjects(
  base: readonly DevProjectFixture[],
  scale: number
): readonly DevProjectFixture[] {
  if (!Number.isFinite(scale) || scale < 1) return base
  return base.map((project) => {
    const existing = project.sessions
    if (existing.length >= scale) return project
    const generated = Array.from({ length: scale - existing.length }, (_, index) => {
      const ordinal = existing.length + index + 1
      const id = `${project.id}-scale-${ordinal}`
      return {
        session: {
          id,
          title: `Session ${ordinal}`,
          worktreeId: `${id}-worktree`,
          state: 'ready' as const,
          generation: 1,
        },
        worktree: {
          id: `${id}-worktree`,
          projectId: project.id,
          kind: 'managed' as const,
          title: `Session ${ordinal}`,
        },
      }
    })
    return {
      ...project,
      sessions: [...existing, ...generated.map((entry) => entry.session)],
      worktrees: [...(project.worktrees ?? []), ...generated.map((entry) => entry.worktree)],
    }
  })
}
