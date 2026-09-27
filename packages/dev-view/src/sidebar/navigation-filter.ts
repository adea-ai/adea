import type { DevGroupFixture } from '../dev-workspace-entry'

/**
 * Projects a text query onto the existing sidebar hierarchy. The projection
 * keeps canonical IDs and does not change selection, collapse, or runtime
 * state.
 */
export function filterDevNavigationGroups(
  groups: readonly DevGroupFixture[],
  query: string
): readonly DevGroupFixture[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return groups

  return groups.flatMap((group) => {
    if (group.name.toLowerCase().includes(normalizedQuery)) return [group]

    const projects = group.projects.flatMap((project) => {
      if (project.name.toLowerCase().includes(normalizedQuery)) return [project]

      const sessions = project.sessions.filter((session) =>
        session.title.toLowerCase().includes(normalizedQuery)
      )
      return sessions.length > 0 ? [{ ...project, sessions }] : []
    })

    return projects.length > 0 ? [{ ...group, projects }] : []
  })
}
