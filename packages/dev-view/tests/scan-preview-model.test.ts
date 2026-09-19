import { describe, expect, test } from 'bun:test'

import type { ProjectScanPage } from '@adea-ai/types/dev-runtime'

import {
  bookmarkRows,
  importBodyFor,
  importableRows,
  scanNotice,
  scanPreviews,
  type ScanPreviewRow,
} from '../src/sidebar/scan-preview-model'

const entry = (overrides: Partial<ProjectScanPage['items'][number]> = {}) => ({
  name: 'app',
  relativeDir: 'apps/app',
  manifestPath: 'apps/app/package.json',
  packageManager: 'pnpm' as const,
  languages: ['typescript'],
  suggestedScripts: ['build'],
  diagnostics: [],
  ...overrides,
})

describe('scan preview model (#398)', () => {
  test('bookmark rows flatten valid items and drop malformed ones', () => {
    const rows = bookmarkRows([
      {
        id: '00000000-0000-4000-8000-0000000000b0',
        label: 'Work',
        kind: 'directory',
        canonicalRoot: '/srv/work',
        state: 'active',
      },
      { id: 42, label: 'Broken' },
      {
        id: '00000000-0000-4000-8000-0000000000b1',
        label: 'Repo',
        kind: 'repository',
        canonicalRoot: '/srv/repo',
        state: 'stale',
      },
    ])
    expect(rows.length).toBe(2)
    expect(rows[0]).toMatchObject({ label: 'Work', state: 'active' })
    expect(rows[1]!.kind).toBe('repository')
  })

  test('duplicate previews match known project names case-insensitively', () => {
    const rows = scanPreviews(
      { items: [entry(), entry({ name: ' Tools ', relativeDir: 'tools' })] },
      ['App', 'tools']
    )
    expect(rows.map((row) => row.duplicate)).toEqual([true, true])
  })

  test('scan notices describe partial results honestly', () => {
    expect(scanNotice([])).toBeUndefined()
    expect(scanNotice(['budget_exhausted'])).toContain('budget')
    expect(scanNotice(['cancelled'])).toContain('cancelled')
    expect(scanNotice(['gitignore_negation_unsupported:.'])).toContain('negation')
    expect(scanNotice(['root_unreadable'])).toContain('could not be read')
    // Unknown diagnostics are surfaced verbatim instead of swallowed.
    expect(scanNotice(['mystery_code'])).toContain('mystery_code')
  })

  test('import plans build the import body and never offer duplicates', () => {
    const rows: readonly ScanPreviewRow[] = scanPreviews(
      { items: [entry(), entry({ name: 'dup', relativeDir: 'dup' })] },
      ['dup']
    )
    const importable = importableRows(rows)
    expect(importable.length).toBe(1)
    expect(importBodyFor(importable[0]!, 'bookmark', ['group-1'])).toEqual({
      name: 'app',
      rootBookmarkId: 'bookmark',
      groupIds: ['group-1'],
    })
  })
})
