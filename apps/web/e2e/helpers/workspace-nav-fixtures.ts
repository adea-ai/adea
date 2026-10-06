import type {
  NavLeaf,
  NavProject,
  NavWorkspace,
} from '../../../../packages/workspace-nav/src/model'

/** Synthetic sidebar fixtures; names mirror the owner-approved mock. */
const at = (hour: number) => `2026-10-05T${String(hour).padStart(2, '0')}:00:00.000Z`

function leaf(
  projectId: string,
  id: string,
  kind: NavLeaf['kind'],
  branchRef: string,
  status: NavLeaf['status'],
  hour: number,
  extra: Partial<NavLeaf> = {}
): NavLeaf {
  return {
    id,
    kind,
    projectId,
    worktreeId: id,
    branchRef,
    status,
    lastActivityAt: at(hour),
    ...extra,
  }
}

function project(
  id: string,
  name: string,
  source: NavProject['source'],
  sortOrder: number,
  leaves: NavLeaf[] = []
): NavProject {
  return { id, name, source, sortOrder, leaves }
}

const adeaProjects: NavProject[] = [
  project('adea', 'adea', 'local_repo', 0, [
    leaf('adea', 'adea-main', 'checkout', 'main', 'idle', 1),
    leaf('adea', 'sidebar-ux-redesign', 'worktree', 'sidebar-ux-redesign', 'running', 9, {
      diff: { added: 412, removed: 88 },
    }),
    leaf('adea', 'shell-chrome-zorder', 'worktree', 'shell-chrome-zorder', 'needs_you', 8, {
      diff: { added: 36, removed: 12 },
    }),
    leaf('adea', 'scan-nested-gitignore', 'worktree', 'scan-nested-gitignore', 'in_review', 7, {
      pullRequest: { number: 1031 },
    }),
  ]),
  project('adea-ui', 'adea-ui', 'local_repo', 1, [
    leaf('adea-ui', 'adea-ui-tokens', 'checkout', 'feat/tokens-v2', 'running', 6),
    leaf('adea-ui', 'sidebar-tree-primitive', 'worktree', 'sidebar-tree-primitive', 'idle', 5),
  ]),
  project('adea-themes', 'adea-themes', 'local_repo', 2, [
    leaf('adea-themes', 'adea-themes-main', 'checkout', 'main', 'idle', 2),
  ]),
  project('brand', 'Brand and launch', 'none', 3),
  project('code-foundry', 'code-foundry', 'local_repo', 4, [
    leaf('code-foundry', 'code-foundry-main', 'checkout', 'main', 'idle', 3),
  ]),
]

const summary = (running: number, needsYou: number, unread = 0) => ({ running, needsYou, unread })

export const workspaceNavFixtures: NavWorkspace[] = [
  {
    id: 'adea-ws',
    name: 'Adea',
    logo: { kind: 'monogram' },
    accent: 'violet',
    sortOrder: 0,
    summary: summary(2, 1),
    projects: adeaProjects,
  },
  {
    id: 'pink-binder',
    name: 'Pink Binder',
    logo: { kind: 'emoji', value: '🎀' },
    accent: 'pink',
    sortOrder: 1,
    summary: summary(2, 0, 3),
    projects: [
      project('pink-binder-web', 'pink-binder-web', 'local_repo', 0, [
        leaf('pink-binder-web', 'pbw-develop', 'checkout', 'develop', 'idle', 1),
        leaf('pink-binder-web', 'pbw-checkout-flow', 'worktree', 'checkout-flow', 'running', 4),
        leaf('pink-binder-web', 'pbw-image-cdn', 'worktree', 'image-cdn', 'running', 3),
      ]),
      project('pink-binder-api', 'pink-binder-api', 'remote_only', 1, [
        leaf('pink-binder-api', 'pba-rate-limits', 'worktree', 'rate-limits', 'idle', 2),
      ]),
    ],
  },
  {
    id: 'nifty-league',
    name: 'Nifty League',
    logo: { kind: 'monogram' },
    accent: 'green',
    sortOrder: 2,
    summary: summary(0, 2),
    projects: [
      project('nifty-contracts', 'nifty-contracts', 'local_repo', 0, [
        leaf(
          'nifty-contracts',
          'nc-reduce-mint-gas',
          'worktree',
          'reduce-mint-gas',
          'needs_you',
          4
        ),
      ]),
      project('nifty-launcher', 'nifty-launcher', 'local_repo', 1, [
        leaf('nifty-launcher', 'nl-release', 'checkout', 'release/1.4', 'needs_you', 3),
      ]),
    ],
  },
  {
    id: 'personal',
    name: 'Personal',
    logo: { kind: 'emoji', value: '🏡' },
    accent: null,
    sortOrder: 3,
    summary: summary(0, 0),
    projects: [
      project('dotfiles', 'dotfiles', 'local_repo', 0, [
        leaf('dotfiles', 'dotfiles-main', 'checkout', 'main', 'idle', 1),
      ]),
      project('travel', 'Travel', 'none', 1),
      project('blog', 'blog', 'local_repo', 2, [
        leaf('blog', 'blog-october-post', 'worktree', 'october-post', 'idle', 2),
      ]),
    ],
  },
]
