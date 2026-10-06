import type { NavLeaf, NavProject } from './model'

/**
 * Each view renders the one hierarchy in its own words (ADR 0011): Dev shows
 * branch names and the checkout row, Chat shows task titles, Virtual shows
 * projects as rooms and leaves as desks. An adapter is pure data and
 * functions; components never branch on the view themselves.
 */
export type NavView = 'dev' | 'chat' | 'virtual'

export type NavMenuItemId =
  | 'rename'
  | 'settings'
  | 'share'
  | 'archive'
  | 'delete'
  | 'copy-link'
  | 'copy-path'
  | 'open-in-finder'
  | 'switch-branch'
  /** Dev: bind a local repository to a project that has none on this device. */
  | 'add-repository'

export type NavMenuItem = Readonly<{
  id: NavMenuItemId
  label: string
  destructive?: boolean
  separatorBefore?: boolean
}>

export type NavProjectIcon = 'git-folder' | 'folder' | 'cloud' | 'door' | 'hash'

export type NavLabel = Readonly<{ text: string; mono: boolean }>

export type ViewAdapterOptions = Readonly<{
  /** Show "Switch branch…" on the checkout menu (hidden until branch switching ships). */
  branchSwitching?: boolean
}>

export type ViewAdapter = Readonly<{
  view: NavView
  nouns: Readonly<{ project: string; leaf: string }>
  /** Whether the checkout is its own row under a "Worktrees" divider. */
  showCheckoutRow: boolean
  projectIcon(project: NavProject): NavProjectIcon
  leafLabel(leaf: NavLeaf, project?: NavProject): NavLabel
  leafSecondary(leaf: NavLeaf): string | undefined
  createLeafLabel(project: NavProject): string
  createProjectLabel: string
  projectMenu(project: NavProject): readonly NavMenuItem[]
  leafMenu(leaf: NavLeaf): readonly NavMenuItem[]
}>

const sourceIcon: Readonly<Record<NavProject['source'], NavProjectIcon>> = {
  local_repo: 'git-folder',
  none: 'folder',
  remote_only: 'cloud',
}

function projectMenu(settingsLabel: string): readonly NavMenuItem[] {
  return [
    { id: 'rename', label: 'Rename' },
    { id: 'settings', label: settingsLabel },
    { id: 'share', label: 'Share' },
    { id: 'archive', label: 'Archive' },
    { id: 'delete', label: 'Delete', destructive: true, separatorBefore: true },
  ]
}

function worktreeMenu(view: NavView): readonly NavMenuItem[] {
  return [
    { id: 'rename', label: 'Rename' },
    { id: 'copy-link', label: 'Copy link' },
    { id: 'share', label: 'Share' },
    ...(view === 'dev' ? [{ id: 'open-in-finder', label: 'Open in Finder' } as const] : []),
    { id: 'archive', label: 'Archive' },
    { id: 'delete', label: 'Delete', destructive: true, separatorBefore: true },
  ]
}

/** The checkout is the repository itself: it is never archived or deleted from here. */
function checkoutMenu(view: NavView, options: ViewAdapterOptions): readonly NavMenuItem[] {
  return [
    ...(view === 'dev' && options.branchSwitching
      ? [{ id: 'switch-branch', label: 'Switch branch…' } as const]
      : []),
    ...(view === 'dev'
      ? [
          { id: 'copy-path', label: 'Copy path' } as const,
          { id: 'open-in-finder', label: 'Open in Finder' } as const,
        ]
      : []),
    { id: 'share', label: 'Share' },
  ]
}

const devAdapter = (options: ViewAdapterOptions): ViewAdapter => ({
  view: 'dev',
  nouns: { project: 'Project', leaf: 'worktree' },
  showCheckoutRow: true,
  projectIcon: (project) => sourceIcon[project.source],
  leafLabel: (leaf) =>
    leaf.branchRef
      ? { text: leaf.branchRef, mono: true }
      : { text: leaf.title ?? 'Untitled', mono: false },
  leafSecondary: (leaf) => (leaf.branchRef ? leaf.title : undefined),
  createLeafLabel: (project) => (project.source === 'none' ? 'New session' : 'New worktree'),
  createProjectLabel: 'New project',
  projectMenu: () => projectMenu('Project settings'),
  leafMenu: (leaf) =>
    leaf.kind === 'checkout' ? checkoutMenu('dev', options) : worktreeMenu('dev'),
})

function titledAdapter(view: 'chat' | 'virtual', options: ViewAdapterOptions): ViewAdapter {
  const virtual = view === 'virtual'
  return {
    view,
    nouns: { project: virtual ? 'Room' : 'Project', leaf: virtual ? 'desk' : 'task' },
    showCheckoutRow: false,
    projectIcon: () => (virtual ? 'door' : 'hash'),
    // The checkout is the project's default task or desk, named after the project.
    leafLabel: (leaf, project) => {
      if (leaf.kind === 'checkout' && project) return { text: project.name, mono: false }
      if (leaf.title) return { text: leaf.title, mono: false }
      return leaf.branchRef
        ? { text: leaf.branchRef, mono: true }
        : { text: 'Untitled', mono: false }
    },
    leafSecondary: (leaf) => (leaf.title ? leaf.branchRef : undefined),
    createLeafLabel: () => (virtual ? 'New desk' : 'New task'),
    createProjectLabel: virtual ? 'New room' : 'New project',
    projectMenu: () => projectMenu(virtual ? 'Room settings' : 'Project settings'),
    leafMenu: (leaf) =>
      leaf.kind === 'checkout' ? checkoutMenu(view, options) : worktreeMenu(view),
  }
}

export function createViewAdapter(view: NavView, options: ViewAdapterOptions = {}): ViewAdapter {
  return view === 'dev' ? devAdapter(options) : titledAdapter(view, options)
}
