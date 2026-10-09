// Pure policy suite for explicit project-state promotion (M14.03.2,
// adea#1218). The transactional `promoteProjectState` path is covered by
// `tests/integration/project-state-promotion.test.ts`; here the decision is
// exercised over injected observations only.
import { describe, expect, test } from 'bun:test'

import {
  decideProjectStatePromotion,
  ProjectStatePromotionError,
  type ProjectStatePromotionObservation,
  type ProjectStatePromotionRefusal,
} from '../../src/project-state-policy'

const WORKSPACE = '00000000-0000-4000-8000-00000000000a'
const ELSEWHERE = '00000000-0000-4000-8000-00000000000b'
const UPDATED = '2026-10-08T12:00:00.000Z'

function observation(
  overrides: Partial<ProjectStatePromotionObservation> = {}
): ProjectStatePromotionObservation {
  return {
    deletedAt: null,
    id: '00000000-0000-4000-8000-0000000000aa',
    lifecycleState: 'archived',
    updatedAt: UPDATED,
    visibility: 'workspace',
    workspaceId: WORKSPACE,
    ...overrides,
  }
}

function decide(overrides: Partial<Parameters<typeof decideProjectStatePromotion>[0]> = {}) {
  return decideProjectStatePromotion({
    authorizedWorkspaceId: WORKSPACE,
    confirmed: true,
    expectedUpdatedAt: UPDATED,
    project: observation(),
    ...overrides,
  })
}

function refusalOf(overrides: Partial<Parameters<typeof decideProjectStatePromotion>[0]>) {
  const decision = decide(overrides)
  return decision.allowed ? undefined : decision.reason
}

describe('project-state promotion decision', () => {
  test('promotes an archived project and preserves its exact audience', () => {
    for (const visibility of ['workspace', 'members'] as const) {
      const decision = decide({ project: observation({ visibility }) })
      expect(decision.allowed).toBe(true)
      if (!decision.allowed) continue
      expect(decision.plan).toEqual({
        projectId: observation().id,
        audienceWorkspaceId: WORKSPACE,
        retainedVisibility: visibility,
        from: 'archived',
        to: 'active',
        expectedUpdatedAt: UPDATED,
      })
    }
  })

  test('a missing or foreign project is one indistinguishable refusal', () => {
    expect(refusalOf({ project: null })).toBe('project_unavailable')
    expect(refusalOf({ project: observation({ workspaceId: ELSEWHERE }) })).toBe(
      'project_unavailable'
    )
  })

  test('soft-deleted, active and stale observations refuse with typed reasons', () => {
    expect(refusalOf({ project: observation({ deletedAt: UPDATED }) })).toBe('promotion_deleted')
    expect(refusalOf({ project: observation({ lifecycleState: 'active' }) })).toBe(
      'promotion_state_invalid'
    )
    expect(refusalOf({ expectedUpdatedAt: '2026-10-08T11:59:59.000Z' })).toBe('promotion_stale')
    expect(refusalOf({ expectedUpdatedAt: '' })).toBe('promotion_stale')
    expect(refusalOf({ expectedUpdatedAt: 'not-a-date' })).toBe('promotion_stale')
  })

  test('promotion is explicit opt-in: no confirmation, no promotion', () => {
    expect(refusalOf({ confirmed: false })).toBe('promotion_not_confirmed')
  })

  test('the typed error carries the refusal and no project detail', () => {
    const error = new ProjectStatePromotionError('promotion_stale')
    expect(error.name).toBe('ProjectStatePromotionError')
    expect(error.reason).toBe('promotion_stale')
    expect(error.message).toBe('Project promotion conflict')
    const reasons: ProjectStatePromotionRefusal[] = [
      'project_unavailable',
      'promotion_deleted',
      'promotion_state_invalid',
      'promotion_stale',
      'promotion_not_confirmed',
    ]
    for (const reason of reasons) {
      expect(new ProjectStatePromotionError(reason).message).not.toContain(WORKSPACE)
    }
  })
})
