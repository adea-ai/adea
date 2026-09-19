import { describe, expect, test } from 'bun:test'

import { devOperationDefinitions } from '../../../packages/types/src/dev-runtime'

import {
  archiveShelfReady,
  archiveShelfUnavailable,
  beginArchiveShelfLoad,
  cancelPendingDelete,
  confirmPendingDelete,
  requestDelete,
  restoreCompleted,
  SESSION_DELETE_OPERATION,
  sessionDeleteContractAvailable,
  type ArchiveShelfState,
} from '../src/sidebar/archive-shelf-model'

const items = [
  { id: 's1', projectId: 'p1', title: 'Old session', archivedAt: '2026-09-01T00:00:00.000Z' },
  { id: 's2', projectId: 'p2', title: 'Older session', archivedAt: '2026-08-01T00:00:00.000Z' },
]

const ready: ArchiveShelfState = archiveShelfReady(items)

describe('archive shelf model', () => {
  test('loading and unavailable states never fabricate items', () => {
    expect(beginArchiveShelfLoad()).toEqual({ status: 'loading', items: [] })
    expect(archiveShelfUnavailable('unavailable')).toEqual({
      status: 'unavailable',
      reason: 'unavailable',
      items: [],
    })
  })

  test('restore removes exactly the restored session', () => {
    expect(restoreCompleted(ready, 's1').items.map((item) => item.id)).toEqual(['s2'])
    expect(restoreCompleted(ready, 'ghost')).toBe(ready)
  })

  test('a destructive delete requires an explicit confirmation step', () => {
    const requested = requestDelete(ready, 's1')
    expect(requested.pendingDeleteId).toBe('s1')
    // Cancel returns to the ready state with no pending deletion.
    expect(cancelPendingDelete(requested)).toEqual(ready)
    // Confirm commits the pending id exactly once and clears it.
    const commit = confirmPendingDelete(requested)
    expect(commit).toEqual({ state: { ...ready, pendingDeleteId: undefined }, commitId: 's1' })
    expect(confirmPendingDelete(ready).commitId).toBeUndefined()
  })

  test('the session delete host contract is an explicit handoff, not a silent no-op', () => {
    // The M12 registry has no dev.session.delete operation: the shelf must
    // say so instead of pretending the destructive commit succeeded.
    expect(sessionDeleteContractAvailable(devOperationDefinitions)).toBe(false)
    expect(SESSION_DELETE_OPERATION).toBe('dev.session.delete')
  })
})
