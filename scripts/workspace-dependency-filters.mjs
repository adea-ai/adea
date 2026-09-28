export function getWorkspaceDependencyFilters(...dependencyGroups) {
  const workspaceNames = new Set(
    dependencyGroups.flatMap((dependencies = {}) =>
      Object.entries(dependencies)
        .filter(([, version]) => typeof version === 'string' && version.startsWith('workspace:'))
        .map(([name]) => name)
    )
  )

  return [...workspaceNames].map((name) => `--filter=${name}`)
}
