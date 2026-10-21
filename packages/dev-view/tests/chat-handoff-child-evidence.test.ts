// Child delegations reported by the control plane (#1173): display-only, with
// the unavailable and partial states named and no authority derived from them.
import { describe, expect, test } from 'bun:test'

import {
  deriveDirectSessionHandoff,
  deriveHandoffInputFromConversation,
} from '../src/chat/model/handoff'
import type { ChatConversation } from '../src/chat/model/types'
import {
  deriveChildEvidence,
  type HandoffObservedChild,
} from '../src/chat/model/handoff-observation'

function child(overrides: Partial<HandoffObservedChild> = {}): HandoffObservedChild {
  return {
    delegationId: 'dlg_aaaaaaaa11111111',
    role: 'reviewer',
    state: 'running',
    awaitingInput: false,
    stopRequested: false,
    updatedAt: '2026-10-18T07:00:00.000Z',
    ...overrides,
  }
}

describe('child evidence', () => {
  test('no read supplied is not connected, never "no children"', () => {
    const evidence = deriveChildEvidence(undefined)
    expect(evidence.kind).toBe('not_connected')
    expect(evidence.summary).toContain('not connected')
  })

  test('each unavailable code is named and carries no empty set or count', () => {
    for (const reasonCode of [
      'NOT_DISPATCHED',
      'ADMISSION_SERVICE_UNAVAILABLE',
      'RUNTIME_UNAVAILABLE',
      'RUNTIME_RESPONSE_INVALID',
    ] as const) {
      const evidence = deriveChildEvidence({ availability: 'unavailable', reasonCode })
      expect(evidence.kind).toBe('unavailable')
      expect('rows' in evidence).toBe(false)
      expect(evidence.summary.length).toBeGreaterThan(10)
    }
  })

  test('only a complete read with no children says there are none', () => {
    expect(
      deriveChildEvidence({
        availability: 'available',
        children: [],
        totalChildren: 0,
        complete: true,
      }).kind
    ).toBe('none')
    const incomplete = deriveChildEvidence({
      availability: 'available',
      children: [],
      totalChildren: 3,
      complete: false,
    })
    expect(incomplete.kind).toBe('partial')
    expect(incomplete.summary).toBe('Showing 0 of 3 children; 3 not shown.')
  })

  test('a complete final cursor page with earlier children is not "all children"', () => {
    const evidence = deriveChildEvidence({
      availability: 'available',
      children: [child(), child({ delegationId: 'dlg_bbbbbbbb22222222' })],
      totalChildren: 5,
      complete: true,
    })
    expect(evidence.kind).toBe('partial')
    expect(evidence.summary).toBe(
      'This is the last page of the read: showing 2 of 5 children; 3 on earlier pages not shown.'
    )
  })

  test('a complete final page with no rows but a nonzero total never claims none', () => {
    const evidence = deriveChildEvidence({
      availability: 'available',
      children: [],
      totalChildren: 3,
      complete: true,
    })
    expect(evidence.kind).toBe('partial')
    expect(evidence.summary).toContain('0 of 3 children')
  })

  test('a complete read holding every child is complete', () => {
    expect(
      deriveChildEvidence({
        availability: 'available',
        children: [child()],
        totalChildren: 1,
        complete: true,
      }).kind
    ).toBe('complete')
  })

  test('a partial page names how many children it did not show', () => {
    const evidence = deriveChildEvidence({
      availability: 'available',
      children: [child(), child({ delegationId: 'dlg_bbbbbbbb22222222' })],
      totalChildren: 5,
      complete: false,
    })
    expect(evidence.kind).toBe('partial')
    expect(evidence.summary).toBe('Showing 2 of 5 children; 3 not shown.')
  })

  test('stop requested and unpublished outcomes are claims, not results', () => {
    const evidence = deriveChildEvidence({
      availability: 'available',
      children: [
        child({ stopRequested: true }),
        child({
          delegationId: 'dlg_cccccccc33333333',
          state: 'failed',
          outcome: { state: 'failed', failureCode: 'E_X', publication: 'pending' },
        }),
        child({
          delegationId: 'dlg_dddddddd44444444',
          state: 'manual_intervention',
          awaitingInput: true,
        }),
      ],
      totalChildren: 3,
      complete: true,
    })
    if (evidence.kind !== 'complete') throw new Error('expected complete')
    expect(evidence.rows[0]?.qualifiers).toEqual(['stop requested, not confirmed'])
    expect(evidence.rows[1]?.qualifiers).toEqual([
      'control plane outcome publication pending',
      'failure code E_X',
    ])
    expect(evidence.rows[2]?.stateText).toBe('manual intervention')
    expect(evidence.rows[2]?.qualifiers).toEqual(['awaiting input'])
    expect(evidence.summary).toBe('3 children reported.')
  })

  test('a control-plane role or failure code is shown only when it is bounded', () => {
    // The control plane types both as free strings. The surface reports what
    // it was told, but it does not repeat an unbounded or control-bearing
    // value it cannot vouch for.
    const evidence = deriveChildEvidence({
      availability: 'available',
      children: [
        child({
          delegationId: 'dlg_eeeeeeee55555555',
          role: `researcher${'x'.repeat(500)}`,
          state: 'failed',
          outcome: { state: 'failed', failureCode: 'E_'.repeat(500), publication: 'published' },
        }),
        child({
          delegationId: 'dlg_ffffffff66666666',
          role: 'researcher\u202E',
          state: 'failed',
          outcome: { state: 'failed', failureCode: 'E_X', publication: 'published' },
        }),
      ],
      totalChildren: 2,
      complete: true,
    })
    if (evidence.kind !== 'complete') throw new Error('expected complete')
    expect(evidence.rows[0]?.role).toBe('unknown')
    expect(evidence.rows[0]?.qualifiers).toEqual(['control plane outcome published'])
    expect(evidence.rows[1]?.role).toBe('unknown')
    expect(evidence.rows[1]?.qualifiers).toEqual([
      'control plane outcome published',
      'failure code E_X',
    ])
  })
})

describe('child evidence through the supplier', () => {
  const conversation: ChatConversation = {
    runtimeSessionId: 'session-1',
    scope: {
      accountId: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000002',
      runtimeNodeId: '00000000-0000-4000-8000-000000000003',
    },
    projectId: 'project-1',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    title: 'Session',
    status: 'active',
    archived: false,
    projection: 'structured',
    generation: 3,
    version: 7,
    draft: '',
    draftBlocks: [],
    events: [],
    retention: { maxEvents: 1000, complete: true },
  }
  const view = (childObservations?: Parameters<typeof deriveChildEvidence>[0]) =>
    deriveDirectSessionHandoff(
      deriveHandoffInputFromConversation({
        conversation,
        connected: true,
        ...(childObservations === undefined ? {} : { childObservations }),
      })
    )

  test('the view carries the evidence and still grants no job or descendant control', () => {
    const shown = view({
      availability: 'available',
      children: [child()],
      totalChildren: 4,
      complete: false,
    })
    expect(shown.childEvidence.kind).toBe('partial')
    expect(shown.controls.job_cancel.available).toBe(false)
    expect(shown.controls.descendant_cancel.available).toBe(false)
  })

  test('without a read the view says it is not connected', () => {
    expect(view().childEvidence.kind).toBe('not_connected')
  })
})
