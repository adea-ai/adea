/*
 * The browser-pane harness's cookie fixtures (#646) ride the same
 * `DevRuntimeService` seam the packaged app uses, so every reply they produce
 * must survive the operation's own decoder — the render lane is only honest if
 * the wire shapes it draws are the wire shapes `decodeDevReply` admits. A
 * fixture that rendered only because a decoder was never consulted would pin
 * a fiction.
 */
import { describe, expect, test } from 'bun:test'
import type { DevCommand } from '@adea-ai/types/dev-runtime'
import { decodeDevReply, devOperationDefinitions } from '@adea-ai/types/dev-runtime'

import {
  browserPaneFixtureScope,
  cookieFixtureMode,
  cookieImportCommitReply,
  cookieImportPlanReply,
  cookieSourcesReply,
  fixtureCookiePlanDigest,
  fixtureCookiePlanId,
  type CookieFixtureLane,
} from '../e2e/helpers/dev-browser-pane-cookie-fixtures'

function command(
  operation: keyof typeof devOperationDefinitions,
  body: Record<string, unknown>,
  resource?: { kind: string; id: string; generation: number }
): DevCommand {
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-000000000004',
    nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
    issuedAt: '2026-09-15T12:00:00.000Z',
    expiresAt: '2026-09-15T12:01:00.000Z',
    scope: browserPaneFixtureScope,
    capabilities: devOperationDefinitions[operation].capabilities,
    ...(resource ? { resource } : {}),
    body,
  }
}

const liveLane: CookieFixtureLane = {
  id: 'browser-pane-fixture-lane',
  generation: 7,
  state: 'ready',
}
const stoppedLane: CookieFixtureLane = { ...liveLane, state: 'closed' }
const laneResource = { kind: 'browser_lane', id: liveLane.id, generation: liveLane.generation }

describe('cookie fixture replies decode through the operations own decoders', () => {
  test('the sources page and its typed refusal both decode', () => {
    for (const mode of ['ok', 'sources-unavailable'] as const) {
      expect(() =>
        decodeDevReply(cookieSourcesReply(command('dev.browser.cookieSources', {}), mode))
      ).not.toThrow()
    }
  })

  test('the plan decodes for every fixture variant, blockers included', () => {
    for (const mode of ['ok', 'blocked', 'keychain', 'stale', 'sources-unavailable'] as const) {
      const reply = cookieImportPlanReply(
        command('dev.browser.cookieImportPlan', {
          browserLaneId: liveLane.id,
          domains: [],
          expectedGeneration: liveLane.generation,
          sourceProfileId: 'chrome:Default',
        }, laneResource),
        liveLane,
        mode
      )
      const decoded = decodeDevReply(reply)
      expect(decoded.ok).toBe(mode !== 'keychain')
    }
  })

  test('the commit decodes with the seam refusal order: stopped lane first, stale second', () => {
    const commitCommand = command(
      'dev.browser.cookieImportCommit',
      { planDigest: fixtureCookiePlanDigest, planId: fixtureCookiePlanId },
      laneResource
    )
    // A live lane refuses as invalid_state in every mode: the seam checks the
    // engine before it checks the plan.
    expect(
      decodeDevReply(cookieImportCommitReply(commitCommand, liveLane, 'ok'))
    ).toMatchObject({ error: { code: 'invalid_state' } })
    expect(
      decodeDevReply(cookieImportCommitReply(commitCommand, liveLane, 'stale'))
    ).toMatchObject({ error: { code: 'invalid_state' } })

    const committed = decodeDevReply(cookieImportCommitReply(commitCommand, stoppedLane, 'ok'))
    if (!committed.ok) throw new Error('the stopped-lane commit fixture must succeed')
    expect(committed.value).toMatchObject({ imported: 12, rolledBack: false })
    expect(
      decodeDevReply(cookieImportCommitReply(commitCommand, stoppedLane, 'stale'))
    ).toMatchObject({ error: { code: 'plan_stale' } })
  })

  test('the fixture plan carries the value-free facts the surface projects', () => {
    const decoded = decodeDevReply(
      cookieImportPlanReply(
        command('dev.browser.cookieImportPlan', {}, laneResource),
        liveLane,
        'ok'
      )
    )
    if (!decoded.ok) throw new Error('the happy-path plan fixture must succeed')
    const plan = decoded.value as { factVersions: Record<string, string>; id: string }
    expect(plan.id).toBe(fixtureCookiePlanId)
    expect(Object.keys(plan.factVersions).toSorted()).toEqual([
      'domains',
      'skipped',
      'sourceProfileId',
      'stagedRemovals',
      'stagedWrites',
    ])
  })

  test('unrecognized mode query parameters fall back to the happy path', () => {
    expect(cookieFixtureMode(new URLSearchParams(''))).toBe('ok')
    expect(cookieFixtureMode(new URLSearchParams('cookies=nonsense'))).toBe('ok')
    expect(cookieFixtureMode(new URLSearchParams('cookies=stale'))).toBe('stale')
  })
})
