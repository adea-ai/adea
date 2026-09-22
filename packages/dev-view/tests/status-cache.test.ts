/*
 * Generation-fenced status cache tests (#399 residue): the client twin of
 * the shell's watcher-driven status invalidation lane. Invalidation and
 * failed refreshes turn the cache UNDEFINED — never a stale value labeled
 * fresh — entries are fenced by the worktree generation they were read
 * under, a re-fence discards the old generation's entry, the marker cache
 * follows the same contract, and a PUSHED `git.statusInvalidated` event
 * (M12) asks exactly one of three things of the pane: ignore, invalidate,
 * or re-resolve the context.
 */
import { describe, expect, test } from 'bun:test'

import type { DevGitStatusInvalidated } from '../src/platform'
import { markerBadge, markerMap } from '../src/files/files-model'
import {
  cacheStatus,
  emptyStatusCache,
  invalidateStatus,
  pushInvalidationDecision,
  refenceStatusCache,
} from '../src/files/status-cache'

type Reply = { indexSha: string; entries: readonly string[] }

const replyA: Reply = { indexSha: 'sha-a', entries: ['one'] }
const replyB: Reply = { indexSha: 'sha-b', entries: ['one', 'two'] }

const pushedEvent = (overrides: Partial<DevGitStatusInvalidated>): DevGitStatusInvalidated => ({
  worktreeId: 'wt-1',
  generation: 7,
  revision: 1,
  reason: 'tree_changed',
  ...overrides,
})

describe('status cache honesty contract', () => {
  test('an empty cache is undefined and stale — it never fabricates state', () => {
    const snapshot = emptyStatusCache<Reply>(4)
    expect(snapshot.value).toBeUndefined()
    expect(snapshot.stale).toBe(true)
    expect(snapshot.generation).toBe(4)
  })

  test('a successful dispatch publishes under its generation, fresh', () => {
    const snapshot = cacheStatus(replyA, 4)
    expect(snapshot.value).toBe(replyA)
    expect(snapshot.generation).toBe(4)
    expect(snapshot.stale).toBe(false)
  })

  test('invalidation goes undefined — never stale-fresh — and keeps its fence', () => {
    const snapshot = invalidateStatus(cacheStatus(replyA, 4))
    expect(snapshot.value).toBeUndefined()
    expect(snapshot.stale).toBe(true)
    expect(snapshot.generation).toBe(4)
  })

  test('a failed refresh cannot leave the previous listing displayed', () => {
    // The pane's exact sequence: fresh listing, then a dispatch that fails.
    let snapshot = cacheStatus(replyA, 4)
    snapshot = invalidateStatus(snapshot)
    expect(snapshot.value).toBeUndefined()
    // No sequence of invalidations can resurrect the old value.
    expect(invalidateStatus(snapshot).value).toBeUndefined()
  })

  test('a re-fence discards the old generation and the entry dies with it', () => {
    const fresh = cacheStatus(replyA, 4)
    const refenced = refenceStatusCache(fresh, 5)
    expect(refenced.value).toBeUndefined()
    expect(refenced.stale).toBe(true)
    expect(refenced.generation).toBe(5)
    // Only a successful read under the NEW generation repopulates.
    const republished = cacheStatus(replyB, 5)
    expect(republished.value).toBe(replyB)
    expect(republished.stale).toBe(false)
  })

  test('a re-fence to the current fresh generation is a no-op (same snapshot)', () => {
    const fresh = cacheStatus(replyA, 4)
    expect(refenceStatusCache(fresh, 4)).toBe(fresh)
  })

  test('a stale cache re-fenced to its own generation stays honestly empty', () => {
    const stale = invalidateStatus(cacheStatus(replyA, 4))
    const refenced = refenceStatusCache(stale, 4)
    expect(refenced.value).toBeUndefined()
    expect(refenced.stale).toBe(true)
  })
})

describe('files-pane marker contract', () => {
  const entries = [
    {
      path: { relativePath: 'src/app.ts' },
      staged: 'M',
      unstaged: '.',
      untracked: false,
    },
    {
      path: { relativePath: 'notes.txt' },
      staged: '?',
      unstaged: '.',
      untracked: true,
    },
  ]

  test('markers publish through the same cache contract', () => {
    const snapshot = cacheStatus(markerMap(entries), 2)
    expect(snapshot.value?.get('src/app.ts')).toEqual({
      staged: 'M',
      unstaged: '.',
      untracked: false,
    })
    expect(markerBadge(snapshot.value?.get('notes.txt'))).toBe('?')
  })

  test('an invalidated marker cache clears badges instead of showing stale ones', () => {
    const stale = invalidateStatus(cacheStatus(markerMap(entries), 2))
    expect(stale.value).toBeUndefined()
    // The pane's badge lookup over the cleared map renders nothing.
    expect(markerBadge(stale.value?.get('src/app.ts'))).toBe('')
  })

  test('markers re-fenced to a moved worktree generation die with the old one', () => {
    const refenced = refenceStatusCache(cacheStatus(markerMap(entries), 2), 3)
    expect(refenced.value).toBeUndefined()
    expect(refenced.generation).toBe(3)
  })
})

describe('push invalidation decision (M12 pushed events)', () => {
  const context = { worktreeId: 'wt-1', generation: 7 }
  test('a same-generation tree change invalidates: the cache dies and pull repopulates', () => {
    expect(pushInvalidationDecision(context, pushedEvent({}))).toBe('invalidate')
    // A degraded watcher is the lane telling the truth about uncertainty —
    // still a real invalidation for the same generation.
    expect(pushInvalidationDecision(context, pushedEvent({ reason: 'degraded' }))).toBe(
      'invalidate'
    )
  })

  test('a moved generation means the context itself is stale: re-resolve, never reuse', () => {
    expect(pushInvalidationDecision(context, pushedEvent({ generation: 8 }))).toBe('refence')
    expect(
      pushInvalidationDecision(context, pushedEvent({ generation: 8, reason: 'refenced' }))
    ).toBe('refence')
  })

  test("another worktree's event is ignored", () => {
    expect(pushInvalidationDecision(context, pushedEvent({ worktreeId: 'wt-other' }))).toBe(
      'ignore'
    )
    expect(
      pushInvalidationDecision(context, pushedEvent({ worktreeId: 'wt-other', generation: 99 }))
    ).toBe('ignore')
  })

  test("the watcher lane's own refreshed/stopped bookkeeping is ignored", () => {
    expect(pushInvalidationDecision(context, pushedEvent({ reason: 'refreshed' }))).toBe('ignore')
    expect(pushInvalidationDecision(context, pushedEvent({ reason: 'stopped' }))).toBe('ignore')
  })
})
