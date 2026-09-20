/*
 * Source control model tests (#399): status bucket grouping with conflicts,
 * branch labels, and the bounded plain-text diff renderer.
 */
import { describe, expect, test } from 'bun:test'

import type { DiffHunk, GitStatus } from '@adea-ai/types/dev-runtime'

import {
  branchLabel,
  groupStatus,
  renderUnifiedDiff,
  statusLabel,
} from '../src/source-control/source-control-model'

function entry(relativePath: string, staged: string, unstaged: string, untracked = false) {
  return {
    path: {
      worktreeId: 'wt',
      rootIdentity: { mtimeNs: '1', size: '1' },
      relativePath,
    },
    staged,
    unstaged,
    untracked,
  }
}

const BASE: GitStatus = {
  worktreeId: 'wt',
  indexSha: '0'.repeat(64),
  entries: [],
  observedAt: '2026-01-01T00:00:00.000Z',
}

describe('source control model', () => {
  test('groups staged, unstaged, untracked, and conflicted entries', () => {
    const grouped = groupStatus({
      ...BASE,
      entries: [
        entry('staged-only.ts', 'M', '.'),
        entry('both.ts', 'M', 'M'),
        entry('unstaged-only.ts', '.', 'D'),
        entry('new.ts', '?', '?', true),
        entry('conflict1.ts', 'U', 'U'),
        entry('conflict2.ts', 'A', 'A'),
      ],
    })
    expect(grouped.staged.map((e) => e.path.relativePath)).toEqual(['staged-only.ts', 'both.ts'])
    expect(grouped.unstaged.map((e) => e.path.relativePath)).toEqual([
      'both.ts',
      'unstaged-only.ts',
    ])
    expect(grouped.untracked.map((e) => e.path.relativePath)).toEqual(['new.ts'])
    expect(grouped.conflicted.map((e) => e.path.relativePath)).toEqual([
      'conflict1.ts',
      'conflict2.ts',
    ])
  })

  test('labels codes and branches', () => {
    expect(statusLabel('M')).toBe('modified')
    expect(statusLabel('.')).toBe('clean')
    expect(statusLabel('U')).toBe('conflict')
    expect(branchLabel({ headRef: 'main', headSha: undefined })).toBe('main')
    expect(branchLabel({ headRef: undefined, headSha: 'abc1234def4567890' })).toBe(
      'detached HEAD @ abc1234'
    )
  })

  test('renderUnifiedDiff bounds output with an explicit truncation budget', () => {
    const hunk: DiffHunk = {
      path: { worktreeId: 'wt', rootIdentity: { mtimeNs: '1', size: '1' }, relativePath: 'a.ts' },
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        { kind: 'context', text: 'keep' },
        { kind: 'delete', text: 'old' },
        { kind: 'add', text: 'new' },
      ],
    }
    const rendered = renderUnifiedDiff([hunk])
    expect(rendered.length).toBe(4)
    expect(rendered[0]?.kind).toBe('meta')
    expect(rendered[2]?.text).toBe('-old')
    // Budget of 2 lines: the header plus one line, never an unbounded dump.
    expect(renderUnifiedDiff([hunk], 2).length).toBe(2)
  })
})
