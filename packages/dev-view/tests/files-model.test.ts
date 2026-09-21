/*
 * Files pane model tests (#399): tree merging with deterministic ordering,
 * visible-row flattening, filtering, quick-open ranking, and modification
 * markers.
 */
import { describe, expect, test } from 'bun:test'

import type { FileEntry } from '@adea-ai/types/dev-runtime'

import {
  filterTree,
  fuzzyQuickOpen,
  markerBadge,
  markerMap,
  mergeListing,
  rankQuickOpen,
  visibleRows,
} from '../src/files/files-model'

function entry(relativePath: string, kind: FileEntry['kind']): FileEntry {
  return {
    path: {
      worktreeId: 'wt-1',
      rootIdentity: { mtimeNs: '1', size: '1' },
      relativePath,
    },
    identity: { mtimeNs: '111', size: '7' },
    kind,
    size: '7',
    observedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('files tree model', () => {
  test('merges listings with directories before files, then by name', () => {
    let nodes = mergeListing(
      [],
      [entry('zeta.ts', 'file'), entry('src', 'directory'), entry('alpha.ts', 'file')]
    )
    expect(nodes.map((node) => node.name)).toEqual(['src', 'alpha.ts', 'zeta.ts'])
    nodes = mergeListing(nodes, [entry('src/inner.ts', 'file')])
    expect(nodes[0]?.children.map((child) => child.relativePath)).toEqual(['src/inner.ts'])
  })

  test('visible rows flatten only expanded directories', () => {
    let nodes = mergeListing([], [entry('src', 'directory'), entry('README.md', 'file')])
    nodes = mergeListing(nodes, [entry('src/a.ts', 'file'), entry('src/b.ts', 'file')])
    const collapsed = visibleRows(nodes, new Set())
    expect(collapsed.map((row) => row.node.name)).toEqual(['src', 'README.md'])
    const expanded = visibleRows(nodes, new Set(['src']))
    expect(expanded.map((row) => row.node.relativePath)).toEqual([
      'src',
      'src/a.ts',
      'src/b.ts',
      'README.md',
    ])
    expect(expanded[1]?.depth).toBe(1)
  })

  test('filter keeps self matches and ancestors of matches', () => {
    let nodes = mergeListing([], [entry('src', 'directory'), entry('docs', 'directory')])
    nodes = mergeListing(nodes, [
      entry('src/keep.ts', 'file'),
      entry('src/drop.ts', 'file'),
      entry('docs/other.md', 'file'),
    ])
    const filtered = filterTree(nodes, 'keep')
    expect(filtered.length).toBe(1)
    expect(filtered[0]?.relativePath).toBe('src')
    expect(filtered[0]?.children.map((child) => child.name)).toEqual(['keep.ts'])
  })

  test('quick open ranks exact name, then prefix, then path substring', () => {
    const paths = [
      'src/lib/parse.ts',
      'parse.ts',
      'a/parsley.ts',
      'unrelated/x/parse/deep.ts',
      'nothing.md',
    ]
    expect(rankQuickOpen(paths, 'parse')).toEqual([
      'parse.ts',
      'src/lib/parse.ts',
      'unrelated/x/parse/deep.ts',
    ])
    expect(rankQuickOpen(paths, '')).toEqual([])
  })

  test('markers map by path and badge prefers untracked then staged', () => {
    const markers = markerMap([
      { path: { relativePath: 'a.ts' }, staged: 'M', unstaged: '.', untracked: false },
      { path: { relativePath: 'b.ts' }, staged: '.', unstaged: 'D', untracked: false },
      { path: { relativePath: 'c.ts' }, staged: '?', unstaged: '?', untracked: true },
      { path: { relativePath: 'd.ts' }, staged: '.', unstaged: '.', untracked: false },
    ])
    expect(markerBadge(markers.get('a.ts'))).toBe('M')
    expect(markerBadge(markers.get('b.ts'))).toBe('D')
    expect(markerBadge(markers.get('c.ts'))).toBe('?')
    expect(markerBadge(markers.get('d.ts'))).toBe('')
    expect(markerBadge(undefined)).toBe('')
  })

  test('fuzzy quick open matches in-order subsequences and prefers boundaries and filenames', () => {
    const paths = [
      'src/lib/view-model.ts',
      'docs/viewmodel-notes.md',
      'apps/viewer/index.ts',
      'unrelated.md',
    ]
    // "vm" is a subsequence of "view-model" (boundary runs) and "viewmodel".
    const ranked = fuzzyQuickOpen(paths, 'vm')
    expect(ranked.length).toBe(2)
    expect(ranked).toContain('src/lib/view-model.ts')
    expect(ranked).toContain('docs/viewmodel-notes.md')
    // A match whose characters all sit inside the filename outranks a match
    // inside a directory part.
    const scoped = ['readme/notes.md', 'src/readme.md']
    expect(fuzzyQuickOpen(scoped, 'readme')[0]).toBe('src/readme.md')
    // Non-matching needles return nothing; empty queries never rank.
    expect(fuzzyQuickOpen(paths, 'zzz')).toEqual([])
    expect(fuzzyQuickOpen(paths, '')).toEqual([])
    // Bounded results.
    const many = Array.from({ length: 50 }, (_, index) => `src/file-${index}.ts`)
    expect(fuzzyQuickOpen(many, 'file').length).toBe(20)
  })
})
