/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Add/search presentation model for the contextual sidebar (#398): recent
 * authorized roots, monorepo scan previews, and the confirm-before-import
 * plan. Composition semantics follow the sidebar add flows substantially
 * translated from KiroCrew's ChatSidebar and Orca's AddRepoDialog (donor
 * audit #398); every runtime decision stays behind the authority commands.
 *
 * Pure model: no Solid, no I/O. Recommendations are previews requiring
 * confirmation — nothing here executes install/bootstrap commands, and the
 * authoritative duplicate/refusal decision always happens in the register.
 */
import type { ProjectScanEntry, ProjectScanPage } from '@adea-ai/types/dev-runtime'

export type ScanBookmarkRow = Readonly<{
  id: string
  label: string
  kind: 'directory' | 'repository'
  canonicalRoot: string
  state: string
}>

export type ScanPreviewRow = Readonly<{
  entry: ProjectScanEntry
  /** A live project already claims this name (the register confirms). */
  duplicate: boolean
}>

/** Flattened bookmark page items into sidebar rows, without guessing. */
export function bookmarkRows(items: readonly Record<string, unknown>[]): ScanBookmarkRow[] {
  return items.flatMap((raw) => {
    const id = raw.id
    const label = raw.label
    const canonicalRoot = raw.canonicalRoot
    const kind = raw.kind
    const state = raw.state
    if (
      typeof id !== 'string' ||
      typeof label !== 'string' ||
      typeof canonicalRoot !== 'string' ||
      (kind !== 'directory' && kind !== 'repository') ||
      typeof state !== 'string'
    )
      return []
    return [{ id, label, kind, canonicalRoot, state }]
  })
}

/** Case-insensitive duplicate projection for previews; the register's
 * bookmark-binding check remains the authoritative refusal. */
export function scanPreviews(
  page: Pick<ProjectScanPage, 'items'>,
  knownProjectNames: readonly string[]
): ScanPreviewRow[] {
  const known = new Set(knownProjectNames.map((name) => name.trim().toLowerCase()))
  return page.items.map((entry) => ({
    entry,
    duplicate: known.has(entry.name.trim().toLowerCase()),
  }))
}

/** One honest notice per scan-level diagnostic; unknown codes render as-is. */
export function scanNotice(diagnostics: readonly string[]): string | undefined {
  if (diagnostics.length === 0) return undefined
  const notices: string[] = []
  if (diagnostics.some((code) => code === 'budget_exhausted'))
    notices.push('Scan stopped at its budget — results are partial.')
  if (diagnostics.some((code) => code === 'cancelled'))
    notices.push('Scan was cancelled — results are partial.')
  if (diagnostics.some((code) => code.startsWith('gitignore_negation_unsupported')))
    notices.push('Some .gitignore negation rules were not applied.')
  if (diagnostics.some((code) => code === 'root_unreadable'))
    notices.push('The authorized root could not be read.')
  const unmentioned = diagnostics.filter(
    (code) =>
      code !== 'budget_exhausted' &&
      code !== 'cancelled' &&
      code !== 'root_unreadable' &&
      !code.startsWith('gitignore_negation_unsupported')
  )
  if (unmentioned.length > 0) notices.push(...unmentioned.map((code) => `Scan note: ${code}.`))
  return notices.length > 0 ? notices.join(' ') : undefined
}

/** The `dev.project.import` body for one confirmed preview row. */
export function importBodyFor(
  row: ScanPreviewRow,
  rootBookmarkId: string,
  groupIds: readonly string[]
): {
  name: string
  rootBookmarkId: string
  groupIds: string[]
} {
  return {
    name: row.entry.name,
    rootBookmarkId,
    groupIds: [...groupIds],
  }
}

/** A row is importable when it was confirmed and is not a known duplicate. */
export function importableRows(rows: readonly ScanPreviewRow[]): ScanPreviewRow[] {
  return rows.filter((row) => !row.duplicate)
}
