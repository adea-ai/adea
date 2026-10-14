import { describe, expect, test } from 'bun:test'
import type { WorkspaceMemoryEntry } from '@adea-ai/types'

import {
  MEMORY_ENTRY_MAX_CHARS,
  MEMORY_UNAVAILABLE_COPY,
  memoryDateLabel,
  memoryDraftError,
  memoryErrorCode,
  memoryErrorMessage,
  memoryErrorNeedsRefresh,
  memoryOriginDetail,
  memorySourceLabel,
  memoryView,
} from '../../src/memory-model'

const WORKSPACE = '00000000-0000-4000-8000-00000000000a'
const OTHER = '00000000-0000-4000-8000-00000000000b'

function entry(
  id: string,
  createdAt: string,
  overrides: Partial<WorkspaceMemoryEntry> = {}
): WorkspaceMemoryEntry {
  return {
    id,
    workspaceId: WORKSPACE,
    text: `note ${id}`,
    source: 'user',
    status: 'active',
    createdAt,
    updatedAt: createdAt,
    revision: 1,
    origin: { kind: 'user' },
    ...overrides,
  }
}

describe('workspace memory settings model', () => {
  test('partitions active memory from pending proposals, newest first', () => {
    const view = memoryView(
      {
        entries: [
          entry('a', '2026-10-01T00:00:01.000Z'),
          entry('b', '2026-10-01T00:00:03.000Z'),
          entry('c', '2026-10-01T00:00:02.000Z', { source: 'agent', status: 'pending' }),
          entry('d', '2026-10-01T00:00:04.000Z', { source: 'agent', status: 'pending' }),
          entry('x', '2026-10-01T00:00:09.000Z', { workspaceId: OTHER }),
        ],
        injectionEnabled: false,
        unreadable: 1,
      },
      WORKSPACE
    )
    expect(view.active.map(({ id }) => id)).toEqual(['b', 'a'])
    expect(view.pending.map(({ id }) => id)).toEqual(['d', 'c'])
    expect(view.injectionEnabled).toBe(false)
    expect(view.unreadable).toBe(1)
  })

  test('validates drafts against the store bound', () => {
    expect(memoryDraftError('   ')).toBe('Write a note before saving.')
    expect(memoryDraftError('x'.repeat(MEMORY_ENTRY_MAX_CHARS))).toBeUndefined()
    expect(memoryDraftError('x'.repeat(MEMORY_ENTRY_MAX_CHARS + 1))).toContain('at most')
    expect(MEMORY_ENTRY_MAX_CHARS).toBe(2_000)
  })

  test('maps shell refusal codes to copy and never surfaces raw errors', () => {
    expect(memoryErrorCode(new Error('memory_stale_revision'))).toBe('memory_stale_revision')
    expect(memoryErrorCode(new Error('ENOENT: /Users/someone/secret'))).toBe('memory_unavailable')
    expect(memoryErrorCode(undefined)).toBe('memory_unavailable')
    expect(memoryErrorMessage('memory_workspace_unauthorized')).toContain('signed in to')
    expect(memoryErrorNeedsRefresh('memory_stale_revision')).toBe(true)
    expect(memoryErrorNeedsRefresh('memory_limit_exceeded')).toBe(false)
  })

  test('a workspace whose device cleanup is prepared reads as paused, not as unreadable memory', () => {
    const code = memoryErrorCode(new Error('workspace_cleanup_pending'))
    expect(code).toBe('workspace_cleanup_pending')
    expect(memoryErrorMessage(code)).toContain('memory is paused')
    expect(memoryErrorMessage(code)).not.toBe(memoryErrorMessage('memory_unavailable'))
    // The shell changed nothing, so there is nothing to re-read.
    expect(memoryErrorNeedsRefresh(code)).toBe(false)
  })

  test('labels sources and dates, and names the desktop-only unavailable state', () => {
    expect(memorySourceLabel(entry('a', '2026-10-01T00:00:00.000Z'))).toBe('You')
    expect(memorySourceLabel(entry('a', '2026-10-01T00:00:00.000Z', { source: 'agent' }))).toBe(
      'Agent'
    )
    expect(memoryDateLabel('2026-10-01T12:00:00.000Z', 'en-US')).toBe('Oct 1, 2026')
    expect(memoryDateLabel('not a date')).toBe('')
    expect(MEMORY_UNAVAILABLE_COPY).toBe(
      'Memory is stored on your desktop. Open Adea Desktop to manage it.'
    )
  })

  test('states the verified origin of an agent entry and nothing for a user note', () => {
    const at = '2026-10-01T00:00:00.000Z'
    expect(memoryOriginDetail(entry('a', at))).toBeUndefined()
    expect(
      memoryOriginDetail(
        entry('b', at, { source: 'agent', origin: { kind: 'agent', provenance: 'unknown' } })
      )
    ).toBe('Origin not recorded (added before agent runs were tracked)')
    const recorded = {
      kind: 'agent',
      provenance: 'recorded',
      agentProfileId: 'profile-1',
      runtimeSessionId: '11111111-2222-4333-8444-555555555555',
      runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    } as const
    expect(
      memoryOriginDetail(
        entry('c', at, { source: 'agent', origin: { ...recorded, harnessId: 'pi' } })
      )
    ).toBe('Proposed by Pi in session 11111111 (run aaaaaaaa)')
    expect(
      memoryOriginDetail(
        entry('d', at, { source: 'agent', origin: { ...recorded, harnessId: null } })
      )
    ).toBe('Proposed by an agent in session 11111111 (run aaaaaaaa)')
  })
})
