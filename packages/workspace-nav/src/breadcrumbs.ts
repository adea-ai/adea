import type { NavLabel, ViewAdapter } from './adapters'
import {
  activeWorkspace,
  sortProjectLeaves,
  type NavLeaf,
  type NavProject,
  type NavTree,
} from './model'

/**
 * The top bar's Project › Session path, derived from the same tree the
 * sidebar renders. The workspace is not a crumb: the workspace switcher beside
 * the sidebar toggle already names it. Pure data: the host decides how a
 * crumb's target opens.
 */
export type NavCrumbKind = 'project' | 'leaf'

export type NavCrumb = Readonly<{
  kind: NavCrumbKind
  id: string
  /** What the crumb is, in the view's words: Project or Room, Task or Desk. */
  noun: string
  label: NavLabel
  /** The last crumb is the current page; it never links to itself. */
  current: boolean
  /**
   * The leaf an earlier crumb opens: the project's default leaf. Absent on the
   * current crumb and when opening it would reopen the leaf already shown, so
   * no crumb is a no-op.
   */
  target?: Readonly<{ projectId: string; leafId: string }>
}>

export type NavCrumbSelection = Readonly<{
  /** The selected leaf (the sidebar's `selectedLeafId`). */
  leafId?: string | null
  /** The selected project, used when no leaf in the tree is selected. */
  projectId?: string | null
}>

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** A project's default leaf: the checkout first, else its most recent leaf. */
export function defaultLeaf(project: Pick<NavProject, 'leaves'>): NavLeaf | undefined {
  return sortProjectLeaves(project.leaves)[0]
}

function targetFor(
  project: NavProject | undefined,
  selectedLeafId: string | undefined
): NavCrumb['target'] {
  const leaf = project ? defaultLeaf(project) : undefined
  if (!project || !leaf || leaf.id === selectedLeafId) return undefined
  return { projectId: project.id, leafId: leaf.id }
}

/**
 * The breadcrumbs for the active workspace and the current selection.
 *
 * - Empty while nothing in the active workspace is selected; the top bar then
 *   shows its plain title.
 * - The project crumb leads when the selected leaf, or else the selected
 *   project, is in the active workspace.
 * - The leaf crumb is labelled by the view adapter (branch in mono for Dev,
 *   task title for Chat, desk for Virtual). A checkout the view does not show
 *   as its own row is the project's default room or channel, named after the
 *   project, so the project crumb is the current one instead of a repeat.
 */
export function breadcrumbsFor(
  tree: NavTree,
  selection: NavCrumbSelection,
  adapter: ViewAdapter
): NavCrumb[] {
  const workspace = activeWorkspace(tree)
  if (!workspace) return []
  const projects = workspace.projects ?? []
  const selectedLeafId = selection.leafId ?? undefined

  let project: NavProject | undefined
  let leaf: NavLeaf | undefined
  if (selectedLeafId) {
    for (const candidate of projects) {
      leaf = candidate.leaves.find(({ id }) => id === selectedLeafId)
      if (leaf) {
        project = candidate
        break
      }
    }
  }
  if (!project && selection.projectId)
    project = projects.find(({ id }) => id === selection.projectId)
  if (leaf && leaf.kind === 'checkout' && !adapter.showCheckoutRow) leaf = undefined

  if (!project) return []

  const crumbs: NavCrumb[] = []
  const projectCurrent = !leaf
  crumbs.push({
    kind: 'project',
    id: project.id,
    noun: adapter.nouns.project,
    label: { text: adapter.projectLabel(project).text, mono: false },
    current: projectCurrent,
    ...(projectCurrent ? {} : { target: targetFor(project, selectedLeafId) }),
  })
  if (!leaf) return crumbs

  crumbs.push({
    kind: 'leaf',
    id: leaf.id,
    noun: capitalize(adapter.nouns.leaf),
    label: adapter.leafLabel(leaf, project),
    current: true,
  })
  return crumbs
}
