import type { DevGroupFixture } from './types'

/** Development/E2E-only projection fixture; it never stands in for production authority. */
export const devViewFixtureGroups: readonly DevGroupFixture[] = [
  {
    id: 'fixture-product',
    name: 'Product',
    projects: [
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
            badges: {
              harness: 'working',
              dirty: true,
              checks: 'running',
              ports: [3000],
            },
          },
          { id: 'fixture-runtime', title: 'Runtime contracts', state: 'ready' },
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
            badges: { checks: 'failed', harness: 'awaiting_input' },
          },
          {
            id: 'fixture-archived',
            title: 'Archived discovery',
            state: 'archived',
          },
        ],
      },
    ],
  },
]
