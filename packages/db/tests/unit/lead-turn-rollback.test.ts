import { describe, expect, test } from 'bun:test'
import {
  assertLeadTurnRollbackFenceRequest,
  classifyLeadTurnRollback,
  type LeadTurnRollbackEvidence,
  parseLeadTurnRollbackAuthority,
} from '../../src/lead-turn-rollback'

const userId = '0f8b7c2e-1a2b-4c3d-8e9f-001122334455'
const authority = {
  schemaVersion: 1,
  workspaceId: '5c1e2d3f-4a5b-4c6d-8e7f-998877665544',
  actorMembershipId: 'mem_1',
  actorRole: 'owner',
  channelId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  channelVersion: 2,
  channelLifecycleState: 'archived',
  runtimeState: null,
  disposition: 'no_effect_recorded',
}

describe('REQ 154 fence request and authority validation', () => {
  test('accepts a workspace user and a trusted operator with a well-formed id', () => {
    expect(() =>
      assertLeadTurnRollbackFenceRequest({
        actor: { kind: 'user', principal: { kind: 'user', userId } },
        reason: 'rollback_cohort',
      })
    ).not.toThrow()
    expect(() =>
      assertLeadTurnRollbackFenceRequest({
        actor: { kind: 'operator', operatorId: 'ops:rollback-1' },
        reason: 'operator_intervention',
      })
    ).not.toThrow()
  })

  test('refuses an unknown reason, a malformed user id and a malformed operator id before any write', () => {
    for (const request of [
      {
        actor: { kind: 'user' as const, principal: { kind: 'user' as const, userId } },
        reason: 'retry_forever' as never,
      },
      {
        actor: {
          kind: 'user' as const,
          principal: { kind: 'user' as const, userId: 'not-a-uuid' },
        },
        reason: 'rollback_cohort' as const,
      },
      {
        actor: { kind: 'operator' as const, operatorId: 'Bad Operator Id' },
        reason: 'operator_intervention' as const,
      },
      {
        actor: { kind: 'operator' as const, operatorId: 'x'.repeat(129) },
        reason: 'operator_intervention' as const,
      },
    ]) {
      expect(() => assertLeadTurnRollbackFenceRequest(request)).toThrow(
        'INVALID_ROLLBACK_FENCE_REQUEST'
      )
    }
  })

  test('parses well-formed retained authority and fails closed on any other shape', () => {
    expect(parseLeadTurnRollbackAuthority(authority)).toEqual(authority)
    for (const malformed of [
      null,
      'authority',
      { ...authority, schemaVersion: 2 },
      { ...authority, schemaVersion: undefined },
      { ...authority, channelLifecycleState: 'deleted' },
      { ...authority, actorRole: 'member' },
      { ...authority, channelVersion: 0 },
      { ...authority, disposition: 'resume_anyway' },
    ]) {
      expect(() => parseLeadTurnRollbackAuthority(malformed)).toThrow(
        'LEAD_TURN_FENCE_EVIDENCE_INVALID'
      )
    }
  })
})

type Binding = {
  dispatchId: string | null
  runtimeSessionId: string | null
  observedAt: Date | null
}
const observedAt = new Date('2026-10-09T00:00:00.000Z')
const bound: Binding = {
  dispatchId: 'dispatch_' + 'a'.repeat(32),
  runtimeSessionId: 'ses_X',
  observedAt,
}
const unbound: Binding = { dispatchId: null, runtimeSessionId: null, observedAt: null }

function runtime(state: string, fields: Partial<Binding> = unbound) {
  return { state, ...unbound, ...fields }
}

describe('A31 rollback evidence classification', () => {
  test('a non-terminal admission without a fence must be fenced before any routing decision', () => {
    for (const state of ['prepared', 'dispatch_pending', 'running', 'unknown']) {
      expect(classifyLeadTurnRollback({ fenced: false, runtime: runtime(state, bound) })).toBe(
        'fence_required'
      )
    }
    expect(classifyLeadTurnRollback({ fenced: false })).toBe('fence_required')
  })

  test('a fenced admission with no runtime row or an unbound prepared row has no effect recorded', () => {
    expect(classifyLeadTurnRollback({ fenced: true })).toBe('no_effect_recorded')
    expect(classifyLeadTurnRollback({ fenced: true, runtime: runtime('prepared') })).toBe(
      'no_effect_recorded'
    )
  })

  test('a fenced prepared row that carries a dispatch binding is unclassifiable, not reroutable', () => {
    expect(classifyLeadTurnRollback({ fenced: true, runtime: runtime('prepared', bound) })).toBe(
      'blocked_unclassifiable'
    )
  })

  test('dispatch-pending and unknown outcomes keep an uncertain effect that must be reconciled', () => {
    expect(classifyLeadTurnRollback({ fenced: true, runtime: runtime('dispatch_pending') })).toBe(
      'reconcile_uncertain_effect'
    )
    expect(
      classifyLeadTurnRollback({ fenced: true, runtime: runtime('dispatch_pending', bound) })
    ).toBe('reconcile_uncertain_effect')
    expect(classifyLeadTurnRollback({ fenced: true, runtime: runtime('unknown', bound) })).toBe(
      'reconcile_uncertain_effect'
    )
  })

  test('an observed active session is owned by the runtime and never by a second path', () => {
    for (const state of ['starting', 'running', 'awaiting_input', 'cancelling']) {
      expect(classifyLeadTurnRollback({ fenced: true, runtime: runtime(state, bound) })).toBe(
        'in_flight_fenced'
      )
    }
  })

  test('an active state without its full observed binding fails closed', () => {
    for (const fields of [
      { ...bound, observedAt: null },
      { ...bound, dispatchId: null },
      { ...bound, runtimeSessionId: null },
    ]) {
      expect(classifyLeadTurnRollback({ fenced: true, runtime: runtime('running', fields) })).toBe(
        'blocked_unclassifiable'
      )
    }
  })

  test('terminal outcomes are retained history whether or not the admission is fenced', () => {
    for (const state of ['cancelled', 'completed', 'failed', 'timed_out']) {
      for (const fenced of [false, true]) {
        expect(classifyLeadTurnRollback({ fenced, runtime: runtime(state, bound) })).toBe(
          'terminal_retained'
        )
      }
    }
  })

  test('an unknown or malformed state is preserved and blocked, never read as resumable', () => {
    expect(classifyLeadTurnRollback({ fenced: true, runtime: runtime('resumed', bound) })).toBe(
      'blocked_unclassifiable'
    )
    expect(classifyLeadTurnRollback({ fenced: true, runtime: runtime('', bound) })).toBe(
      'blocked_unclassifiable'
    )
  })

  test('classification is pure: it never mutates the evidence it reads', () => {
    const evidence: LeadTurnRollbackEvidence = {
      fenced: true,
      runtime: runtime('dispatch_pending', { dispatchId: null, runtimeSessionId: null }),
    }
    const before = JSON.stringify(evidence)
    classifyLeadTurnRollback(evidence)
    expect(JSON.stringify(evidence)).toBe(before)
  })
})

describe('A36 rollback reader boundary', () => {
  test('the rollback module does not depend on cross-device content sync or remote content', async () => {
    const source = await Bun.file(
      new URL('../../src/lead-turn-rollback.ts', import.meta.url)
    ).text()
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '')
    expect(imports.length).toBeGreaterThan(0)
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/content|remote|sync|replica|device|history/i)
    }
  })
})
