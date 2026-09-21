/**
 * Pure sidebar reorder model (Dev Runtime spec: `dev.group.reorder` and
 * `dev.project.reorder`). The sidebar owns pointer drag-and-drop plus a
 * keyboard path with live announcements; both funnel through these pure moves
 * so a pointer reorder and a keyboard reorder produce byte-identical orders
 * for the runtime command. Boundary moves and unknown ids are no-ops, never
 * wraps.
 */
export type SidebarProjectRef = Readonly<{ id: string }>

export type SidebarGroup = Readonly<{
  id: string
  name: string
  projects: readonly SidebarProjectRef[]
}>

export type ReorderDirection = 'up' | 'down'

/** The next order after moving `id` one slot, or `undefined` for a no-op. */
export function moveIdInOrder(
  order: readonly string[],
  id: string,
  direction: ReorderDirection
): readonly string[] | undefined {
  const index = order.indexOf(id)
  if (index === -1) return undefined
  const target = direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= order.length) return undefined
  const next = [...order]
  ;[next[index], next[target]] = [next[target]!, next[index]!]
  return next
}

/**
 * The next order after a pointer drop: `id` is placed directly before
 * `targetId`. Dropping an item on itself, or on an unknown target, is a
 * no-op.
 */
export function moveIdRelativeTo(
  order: readonly string[],
  id: string,
  targetId: string
): readonly string[] | undefined {
  if (id === targetId) return undefined
  const without = order.filter((candidate) => candidate !== id)
  if (without.length === order.length) return undefined
  const index = without.indexOf(targetId)
  if (index === -1) return undefined
  const next = [...without]
  next.splice(index, 0, id)
  return next
}

type GroupLike = Readonly<{ id: string; projects: readonly Readonly<{ id: string }>[] }>

function placeGroups<T extends GroupLike>(
  groups: readonly T[],
  nextIds: readonly string[] | undefined
): readonly T[] {
  if (!nextIds) return groups
  const byId = new Map(groups.map((group) => [group.id, group]))
  return nextIds.map((groupId) => byId.get(groupId)!)
}

const groupIds = (groups: readonly GroupLike[]) => groups.map((group) => group.id)

export function reorderGroups<T extends GroupLike>(
  groups: readonly T[],
  id: string,
  direction: ReorderDirection
): readonly T[] {
  return placeGroups(groups, moveIdInOrder(groupIds(groups), id, direction))
}

export function reorderGroupsRelativeTo<T extends GroupLike>(
  groups: readonly T[],
  id: string,
  targetId: string
): readonly T[] {
  return placeGroups(groups, moveIdRelativeTo(groupIds(groups), id, targetId))
}

function reorderProjectsInGroup<T extends GroupLike>(
  group: T,
  reorder: (order: readonly string[]) => readonly string[] | undefined
): T {
  const nextIds = reorder(group.projects.map((project) => project.id))
  if (!nextIds) return group
  const byId = new Map(group.projects.map((project) => [project.id, project]))
  return { ...group, projects: nextIds.map((id) => byId.get(id)!) }
}

export function reorderProjects<T extends GroupLike>(
  groups: readonly T[],
  groupId: string,
  projectId: string,
  direction: ReorderDirection
): readonly T[] {
  const group = groups.find((candidate) => candidate.id === groupId)
  if (!group) return groups
  const nextGroup = reorderProjectsInGroup(group, (order) =>
    moveIdInOrder(order, projectId, direction)
  )
  if (nextGroup === group) return groups
  return groups.map((candidate) => (candidate.id === groupId ? nextGroup : candidate))
}

export function reorderProjectsRelativeTo<T extends GroupLike>(
  groups: readonly T[],
  groupId: string,
  projectId: string,
  targetId: string
): readonly T[] {
  const group = groups.find((candidate) => candidate.id === groupId)
  if (!group) return groups
  const nextGroup = reorderProjectsInGroup(group, (order) =>
    moveIdRelativeTo(order, projectId, targetId)
  )
  if (nextGroup === group) return groups
  return groups.map((candidate) => (candidate.id === groupId ? nextGroup : candidate))
}

/**
 * The live-region announcement for one completed move. `position` is the
 * 1-based position after the move attempt; a no-op (boundary or unknown id)
 * says the item is already there instead of staying silent.
 */
export function announcementForMove(
  label: string,
  position: number,
  total: number,
  moved: boolean
): string {
  return moved
    ? `${label} moved to position ${position} of ${total}`
    : `${label} is already at position ${position} of ${total}`
}
