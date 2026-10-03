/*
 * The sidebar tree: GitHub owners (organizations and the viewer's own
 * account) at the top level, each labelled with its provider, and the Adea
 * projects whose repository lives there underneath. Projects without a
 * GitHub remote are not source control destinations and are left out; the
 * caller reports how many were skipped. Archived projects collapse into one
 * row at the bottom.
 */
import type { GitHubCheckRollupState } from '@adea-ai/types/dev-runtime'

export type ProjectFact = Readonly<{
  id: string
  name: string
  repoIds: readonly string[]
  archived: boolean
}>

export type RepoFact = Readonly<{
  id: string
  provider: 'github' | 'gitlab' | 'other'
  host: string
  ownerPath: string
  /** The display URL; its last segment names the repository. */
  displayUrl: string
}>

export type TreeProject = Readonly<{
  /** Stable row key: one row per project repository. */
  key: string
  projectId: string
  repoId: string
  owner: string
  name: string
  projectName: string
  host: string
  archived: boolean
  openCount?: number
  /** The open count is a lower bound: more pages exist. */
  openCountMore: boolean
  ci?: GitHubCheckRollupState
}>

export type TreeOwner = Readonly<{
  key: string
  owner: string
  host: string
  provider: 'GitHub'
  isViewer: boolean
  projects: readonly TreeProject[]
}>

export type SourceControlTree = Readonly<{
  owners: readonly TreeOwner[]
  archived: readonly TreeProject[]
  /** Projects with no GitHub repository. */
  skipped: number
}>

export type RepoStats = Readonly<{
  openCount?: number
  openCountMore?: boolean
  ci?: GitHubCheckRollupState
}>

export function repositoryName(displayUrl: string): string {
  const trimmed = displayUrl.replace(/\/+$/, '').replace(/\.git$/, '')
  const segment = trimmed.slice(trimmed.lastIndexOf('/') + 1).replace(/^.*:/, '')
  return segment.length > 0 ? segment : displayUrl
}

export function buildTree(
  projects: readonly ProjectFact[],
  repos: readonly RepoFact[],
  stats: ReadonlyMap<string, RepoStats>,
  viewer: string | undefined
): SourceControlTree {
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const owners = new Map<string, { owner: string; host: string; projects: TreeProject[] }>()
  const archived: TreeProject[] = []
  let skipped = 0
  for (const project of projects) {
    const github = project.repoIds
      .map((id) => repoById.get(id))
      .filter((repo): repo is RepoFact => repo !== undefined && repo.provider === 'github')
    if (github.length === 0) {
      skipped += 1
      continue
    }
    for (const repo of github) {
      const name = repositoryName(repo.displayUrl)
      const stat = stats.get(repo.id)
      const row: TreeProject = {
        key: `${project.id}:${repo.id}`,
        projectId: project.id,
        repoId: repo.id,
        owner: repo.ownerPath,
        name,
        projectName: project.name,
        host: repo.host,
        archived: project.archived,
        ...(stat?.openCount !== undefined ? { openCount: stat.openCount } : {}),
        openCountMore: stat?.openCountMore === true,
        ...(stat?.ci ? { ci: stat.ci } : {}),
      }
      if (project.archived) {
        archived.push(row)
        continue
      }
      const key = `${repo.host}/${repo.ownerPath}`.toLowerCase()
      const group = owners.get(key) ?? { owner: repo.ownerPath, host: repo.host, projects: [] }
      group.projects.push(row)
      owners.set(key, group)
    }
  }
  const isViewer = (owner: string) =>
    Boolean(viewer && owner.toLowerCase() === viewer.toLowerCase())
  const ordered = [...owners.entries()]
    .map(([key, group]) => ({
      key,
      owner: group.owner,
      host: group.host,
      provider: 'GitHub' as const,
      isViewer: isViewer(group.owner),
      projects: group.projects.toSorted((a, b) => a.name.localeCompare(b.name)),
    }))
    // Organizations first, alphabetically; the viewer's own account last.
    .toSorted((a, b) =>
      a.isViewer === b.isViewer ? a.owner.localeCompare(b.owner) : a.isViewer ? 1 : -1
    )
  return {
    owners: ordered,
    archived: archived.toSorted((a, b) => a.name.localeCompare(b.name)),
    skipped,
  }
}

/** Two-letter monogram for an owner: the design system has no logo files. */
export function monogram(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0)
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`.toUpperCase()
  return name.slice(0, 2).toUpperCase()
}
