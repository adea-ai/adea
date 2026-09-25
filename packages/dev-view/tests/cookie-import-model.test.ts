import { describe, expect, test } from 'bun:test'

import {
  canCommit,
  cookieSourceLabel,
  cookieSourceState,
  importOutcomeMessage,
  previewFromPlan,
  previewSummary,
  type CookieSource,
} from '../src/browser/cookie-import-model'

const scope = {
  accountId: '11111111-1111-4111-8111-111111111111',
  actorId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  nodeId: '33333333-3333-4333-8333-333333333333',
}

function source(overrides: Partial<CookieSource> = {}): CookieSource {
  return {
    availability: 'available',
    id: 'chrome:Default',
    kind: 'chrome',
    label: 'Google Chrome — Default',
    ...overrides,
  }
}

function plan(facts: Record<string, string>, blockers: readonly { message: string }[] = []) {
  return {
    blockers: blockers.map((blocker) => ({ ...blocker, code: 'plan_blocked' as const })),
    digest: 'a'.repeat(64),
    expiresAt: '2026-09-25T12:05:00.000Z',
    factVersions: facts,
    id: 'plan-1',
    operation: 'dev.browser.cookieImportCommit',
    requiredApprovalIds: [],
    resource: { generation: 4, id: 'lane-1', kind: 'browser_lane' },
    scope,
    steps: [],
  }
}

describe('cookie import sources', () => {
  test('only a readable source is selectable, and each refusal carries its reason', () => {
    expect(cookieSourceState(source())).toEqual({ selectable: true, note: '' })
    expect(cookieSourceState(source({ availability: 'locked' }))).toMatchObject({
      selectable: false,
      note: expect.stringContaining('Quit it'),
    })
    expect(cookieSourceState(source({ availability: 'unsupported_format' }))).toMatchObject({
      selectable: false,
      note: expect.stringContaining('cannot read'),
    })
    expect(cookieSourceState(source({ availability: 'unreadable' }))).toMatchObject({
      selectable: false,
      note: expect.stringContaining('could not be read'),
    })
  })

  test('names the browser when a source carries no label of its own', () => {
    expect(cookieSourceLabel(source())).toBe('Google Chrome — Default')
    expect(cookieSourceLabel(source({ kind: 'firefox', label: '   ' }))).toBe('Firefox')
  })
})

describe('cookie import preview', () => {
  test('projects only the plan facts the surface needs, never a value', () => {
    const preview = previewFromPlan(
      plan({
        domains: 'example.com,github.com',
        skipped: '3',
        sourceProfileId: 'chrome:Default',
        stagedRemovals: '4',
        stagedWrites: '12',
      })
    )

    expect(preview).toMatchObject({
      domains: ['example.com', 'github.com'],
      planDigest: 'a'.repeat(64),
      planId: 'plan-1',
      skipped: 3,
      stagedRemovals: 4,
      stagedWrites: 12,
    })
    expect(Object.keys(preview)).not.toContain('cookie')
    expect(previewSummary(preview)).toBe(
      '12 cookies to import · 4 cookies replaced · 3 skipped across 2 families.'
    )
  })

  test('reads a malformed or absent count as zero rather than as NaN', () => {
    const preview = previewFromPlan(plan({ domains: '', stagedWrites: 'nonsense' }))
    expect(preview.stagedWrites).toBe(0)
    expect(preview.domains).toEqual([])
    expect(previewSummary(preview)).toBe('Nothing to import from 0 selected families.')
  })

  test('states a single family and a single cookie in the singular', () => {
    const preview = previewFromPlan(plan({ domains: 'example.com', stagedWrites: '1' }))
    expect(previewSummary(preview)).toBe('1 cookie to import across 1 family.')
  })

  test('refuses a commit when the plan is stale, blocked, or stages nothing', () => {
    const now = '2026-09-25T12:00:00.000Z'
    const fresh = previewFromPlan(plan({ domains: 'example.com', stagedWrites: '5' }))
    expect(canCommit(fresh, now)).toBe(true)

    const expired = previewFromPlan(plan({ domains: 'example.com', stagedWrites: '5' }, []))
    expect(canCommit({ ...expired, expiresAt: '2026-09-25T11:59:00.000Z' }, now)).toBe(false)
    expect(canCommit({ ...expired, expiresAt: 'not a time' }, now)).toBe(false)

    const blocked = previewFromPlan(
      plan({ domains: 'example.com', stagedWrites: '5' }, [{ message: 'lane is busy' }])
    )
    expect(blocked.blockers).toEqual(['lane is busy'])
    expect(canCommit(blocked, now)).toBe(false)

    const empty = previewFromPlan(plan({ domains: 'example.com' }))
    expect(canCommit(empty, now)).toBe(false)
  })

  test('reports a rollback as an unchanged profile rather than a partial import', () => {
    expect(importOutcomeMessage({ imported: 12, rolledBack: true, skipped: 0 })).toContain(
      'rolled back'
    )
    expect(importOutcomeMessage({ imported: 1, rolledBack: false, skipped: 0 })).toBe(
      '1 cookie imported.'
    )
    expect(importOutcomeMessage({ imported: 9, rolledBack: false, skipped: 2 })).toBe(
      '9 cookies imported · 2 skipped.'
    )
  })
})
