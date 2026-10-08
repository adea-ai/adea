/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * The add surface's "From GitHub" source (ADR 0011): the bounded
 * `dev.github.repositories` listing, its search filter, and the
 * `dev.project.clone` (managed) request body for one picked repository.
 *
 * Pure model: no Solid, no I/O. The reply items were already decoded once by
 * the host's strict reply decoder; these helpers re-prove the shape at the
 * client boundary (the same discipline `bookmarkRows` applies to bookmark
 * pages). The clone body carries only redacted remote parts — never a raw
 * URL and never credential material — and the host re-proves every admission
 * (transport, unbound project id, budgets) when the clone runs.
 */
import type { GitHubRepositorySummary } from '@adea-ai/types/dev-runtime'

/** A pickable import-source row: the decoded summary re-proven client-side. */
export type GitHubImportRow = Readonly<
  Pick<GitHubRepositorySummary, 'nameWithOwner' | 'url' | 'visibility' | 'updatedAt' | 'isFork'>
>

/** Re-prove one host-decoded listing item; an unexpected shape drops the row
 *  instead of rendering unvalidated provider data. */
function repositoryRow(raw: Record<string, unknown>): GitHubImportRow | undefined {
  const nameWithOwner = raw.nameWithOwner
  const url = raw.url
  const visibility = raw.visibility
  const updatedAt = raw.updatedAt
  const isFork = raw.isFork
  if (
    typeof nameWithOwner !== 'string' ||
    nameWithOwner.length === 0 ||
    typeof url !== 'string' ||
    url.length === 0 ||
    (visibility !== 'public' && visibility !== 'private' && visibility !== 'internal') ||
    typeof updatedAt !== 'string' ||
    Number.isNaN(Date.parse(updatedAt)) ||
    typeof isFork !== 'boolean'
  )
    return undefined
  return { nameWithOwner, url, visibility, updatedAt, isFork }
}

/** Flatten a `dev.github.repositories` reply value into pickable rows,
 *  newest-updated first regardless of the transport's ordering. */
export function repositoryRows(items: readonly unknown[]): GitHubImportRow[] {
  const rows: GitHubImportRow[] = []
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const row = repositoryRow(raw as Record<string, unknown>)
    if (row !== undefined) rows.push(row)
  }
  return rows.toSorted((left, right) =>
    left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0
  )
}

/** Case-insensitive search over `owner/repository` and the plain repo name. */
export function filterRepositories(
  rows: readonly GitHubImportRow[],
  query: string
): GitHubImportRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...rows]
  return rows.filter((row) => {
    const nameWithOwner = row.nameWithOwner.toLowerCase()
    const separator = nameWithOwner.lastIndexOf('/')
    const plainName = separator >= 0 ? nameWithOwner.slice(separator + 1) : nameWithOwner
    return nameWithOwner.includes(needle) || plainName.includes(needle)
  })
}

/**
 * The `dev.project.clone` (managed) body that binds `projectId` to the picked
 * repository: github remotes always rebuild to `https://<host>/<owner>/<repo>.git`
 * host-side, so the body names the remote only by its redacted parts.
 * Returns undefined for a summary whose name has no owner part (the host would
 * refuse it; the row is simply unpickable).
 */
export function managedCloneBodyFor(
  repository: Pick<GitHubImportRow, 'nameWithOwner'>,
  projectId: string
):
  | Readonly<{
      projectId: string
      mode: 'managed'
      remote: Readonly<{
        provider: 'github'
        host: string
        ownerPath: string
        repository: string
      }>
    }>
  | undefined {
  const separator = repository.nameWithOwner.indexOf('/')
  if (separator <= 0 || separator === repository.nameWithOwner.length - 1) return undefined
  return {
    projectId,
    mode: 'managed',
    remote: {
      provider: 'github',
      host: 'github.com',
      ownerPath: repository.nameWithOwner.slice(0, separator),
      repository: repository.nameWithOwner.slice(separator + 1),
    },
  }
}
