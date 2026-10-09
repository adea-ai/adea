import { describe, expect, test } from 'bun:test'
import {
  managementInputDigest,
  type ManagementAuthorityBoundary,
  type ManagementAuthorityClaim,
  type ManagementAuthorityCompletion,
  type ManagementAuthorityDecision,
  type ManagementCurrentAuthorityRequest,
} from '@adea-ai/types/management'

import {
  createLeadManagementHandler,
  parseLeadManagementCall,
  type LeadManagementRouteDependencies,
} from '../src/server/lead-management-route'
import type { ManagementCaller, ManagementOutcome } from '../src/server/management-gateway'
import type { ManagementOperations } from '../src/server/management-operations'
import {
  MANAGEMENT_NOW,
  MANAGEMENT_PROJECT,
  MANAGEMENT_WORKSPACE,
  managementAuthorityDecision,
} from './helpers/management-authority'

const ACTOR = { kind: 'user', userId: '0f3a2e1c-0000-4000-8000-0000000000bb' } as const
const AUTHORITY = {
  authorityRef: 'authority-1',
  intentId: 'intent-1',
  leadAgentId: 'agent-lead-1',
}
const CANONICAL_REQUEST = {
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
}

type Recorded = Readonly<{ binding: unknown; method: string }>

function success(value: unknown): ManagementOutcome<unknown> {
  return { ok: true, operation: 'project.update', value }
}

function harness(
  options: Readonly<{
    assertCurrent?: (
      request: ManagementCurrentAuthorityRequest,
      boundary: ManagementAuthorityBoundary
    ) => Promise<void>
    canonicalRequestDigest?: string
    claim?: (decision: ManagementAuthorityDecision) => Promise<ManagementAuthorityClaim>
    complete?: (
      decision: ManagementAuthorityDecision,
      completion: ManagementAuthorityCompletion
    ) => Promise<boolean>
    decision?: ManagementAuthorityDecision | null
    operationOutcome?: ManagementOutcome<unknown>
  }> = {}
) {
  const calls: Recorded[] = []
  const callers: ManagementCaller[] = []
  const operations: ManagementOperations = {
    projectArchive: async (_input, binding) => {
      calls.push({ binding, method: 'projectArchive' })
      return (options.operationOutcome ?? success(null)) as never
    },
    projectCreate: async (_input, binding) => {
      calls.push({ binding, method: 'projectCreate' })
      return (options.operationOutcome ?? success({ id: MANAGEMENT_PROJECT })) as never
    },
    projectDelete: async (_input, binding) => {
      calls.push({ binding, method: 'projectDelete' })
      return (options.operationOutcome ?? success(null)) as never
    },
    projectMemberRemove: async (_input, binding) => {
      calls.push({ binding, method: 'projectMemberRemove' })
      return (options.operationOutcome ?? success(true)) as never
    },
    projectMemberSet: async (_input, binding) => {
      calls.push({ binding, method: 'projectMemberSet' })
      return (options.operationOutcome ?? success({})) as never
    },
    projectReorder: async (_input, binding) => {
      calls.push({ binding, method: 'projectReorder' })
      return (options.operationOutcome ?? success([])) as never
    },
    projectUpdate: async (_input, binding) => {
      calls.push({ binding, method: 'projectUpdate' })
      return (options.operationOutcome ?? success({ id: MANAGEMENT_PROJECT })) as never
    },
    projectVisibilitySet: async (_input, binding) => {
      calls.push({ binding, method: 'projectVisibilitySet' })
      return (options.operationOutcome ?? success({ id: MANAGEMENT_PROJECT })) as never
    },
    workspaceReopen: async (_input, binding) => {
      calls.push({ binding, method: 'workspaceReopen' })
      return (options.operationOutcome ?? success({ id: MANAGEMENT_WORKSPACE })) as never
    },
    workspaceUpdate: async (_input, binding) => {
      calls.push({ binding, method: 'workspaceUpdate' })
      return (options.operationOutcome ?? success({ id: MANAGEMENT_WORKSPACE })) as never
    },
  }
  const assertCurrentCalls: Array<{
    boundary: ManagementAuthorityBoundary
    request: ManagementCurrentAuthorityRequest
  }> = []
  const completions: ManagementAuthorityCompletion[] = []
  const dependencies: LeadManagementRouteDependencies = {
    assertCurrent:
      options.assertCurrent ??
      (async (request, boundary) => {
        assertCurrentCalls.push({ boundary, request })
      }),
    claim: options.claim ?? (async () => ({ state: 'claimed' as const })),
    complete:
      options.complete ??
      (async (_decision, completion) => {
        completions.push(completion)
        return true
      }),
    now: () => MANAGEMENT_NOW,
    operationsFor(caller) {
      callers.push(caller)
      return operations
    },
    verify: async () => {
      if (!options.decision) return null
      const canonicalRequestDigest =
        options.canonicalRequestDigest ?? (await managementInputDigest(CANONICAL_REQUEST))
      if (!canonicalRequestDigest) throw new Error('test canonical request invalid')
      return { canonicalRequestDigest, decision: options.decision }
    },
  }
  return { assertCurrentCalls, calls, callers, completions, dependencies }
}

function callRequest(call: unknown, token = 'signed-token') {
  return new Request('https://adea-fixture.invalid/api/internal/pi-durable/management', {
    body: JSON.stringify(call),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  })
}

const updateCall = {
  canonicalRequest: CANONICAL_REQUEST,
  input: { name: 'Renamed' },
  operation: 'project.update',
  schemaVersion: 'adea-management-call/v1',
  targetId: MANAGEMENT_PROJECT,
  workspaceId: MANAGEMENT_WORKSPACE,
}

async function updateDecision(overrides: { input?: unknown; workspaceId?: string } = {}) {
  return managementAuthorityDecision({
    input: overrides.input ?? { name: 'Renamed' },
    operation: 'project.update',
    principal: ACTOR,
    targetId: MANAGEMENT_PROJECT,
    workspaceId: overrides.workspaceId ?? MANAGEMENT_WORKSPACE,
  })
}

describe('lead management host endpoint (#1215)', () => {
  test('dispatches a verified exact-call decision through the shared operations', async () => {
    const decision = await updateDecision()
    const run = harness({ decision })
    const response = await createLeadManagementHandler(run.dependencies)(callRequest(updateCall))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      operation: 'project.update',
      schemaVersion: 'adea-management-result/v1',
      value: { id: MANAGEMENT_PROJECT },
    })
    expect(run.calls).toEqual([{ binding: decision.binding, method: 'projectUpdate' }])
    expect(run.callers).toEqual([
      {
        canonicalRequest: CANONICAL_REQUEST,
        decision,
        kind: 'lead',
        reference: {
          authorityRef: decision.authorityRef,
          intentId: decision.intentId,
          leadAgentId: decision.leadAgentId,
        },
      },
    ])
  })

  test('unauthenticated, malformed or unsupported calls are uniform 404s with zero operations', async () => {
    const run = harness({ decision: null })
    const handler = createLeadManagementHandler(run.dependencies)
    const bodies = [
      updateCall,
      { ...updateCall, schemaVersion: 'other' },
      { ...updateCall, operation: 'memory.entry.update' },
      { ...updateCall, extra: true },
      { ...updateCall, targetId: 'not-a-uuid' },
      { ...updateCall, input: { name: 7 } },
    ]
    for (const body of bodies) {
      const response = await handler(callRequest(body))
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ code: 'LEAD_MANAGEMENT_UNAVAILABLE' })
    }
    expect(run.calls).toEqual([])

    const get = await handler(
      new Request('https://adea-fixture.invalid/api/internal/pi-durable/management', {
        method: 'GET',
      })
    )
    expect(get.status).toBe(404)
  })

  test('a body that changes the signed input is refused before any operation', async () => {
    const decision = await updateDecision()
    const run = harness({ decision })
    const response = await createLeadManagementHandler(run.dependencies)(
      callRequest({ ...updateCall, input: { name: 'Changed after approval' } })
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      code: 'LEAD_MANAGEMENT_REFUSED',
      operation: 'project.update',
      reason: 'authority_binding_mismatch',
    })
    expect(run.calls).toEqual([])
  })

  test('a body for another workspace is refused before any operation', async () => {
    const decision = await updateDecision({
      workspaceId: '0f3a2e1c-0000-4000-8000-00000000aaaa',
    })
    const run = harness({ decision })
    const response = await createLeadManagementHandler(run.dependencies)(callRequest(updateCall))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ reason: 'authority_binding_mismatch' })
    expect(run.calls).toEqual([])
  })

  test('a durable replay claim refuses without a second operation', async () => {
    const decision = await updateDecision()
    const claims: ManagementAuthorityClaim[] = [
      { state: 'claimed' },
      { state: 'replayed', resultDigest: null },
    ]
    const run = harness({
      claim: async () => claims.shift() ?? { state: 'replayed', resultDigest: null },
      decision,
    })
    const handler = createLeadManagementHandler(run.dependencies)
    expect((await handler(callRequest(updateCall))).status).toBe(200)
    const replay = await handler(callRequest(updateCall))
    expect(replay.status).toBe(403)
    expect(await replay.json()).toEqual({
      code: 'LEAD_MANAGEMENT_REFUSED',
      operation: 'project.update',
      reason: 'authority_replay',
    })
    expect(run.calls.length).toBe(1)
  })

  test('an interrupted durable claim returns recovery_required with zero effects', async () => {
    const decision = await updateDecision()
    const run = harness({
      claim: async () => ({ priorState: 'claimed', state: 'recovery_required' }),
      decision,
    })
    const response = await createLeadManagementHandler(run.dependencies)(callRequest(updateCall))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      code: 'LEAD_MANAGEMENT_REFUSED',
      operation: 'project.update',
      reason: 'authority_recovery_required',
    })
    expect(run.calls).toEqual([])
  })

  test('a revoked current authority on a later delivery refuses with zero effects', async () => {
    const decision = await updateDecision()
    let revoked = false
    const run = harness({
      assertCurrent: async () => {
        if (revoked) throw new Error('approval revoked')
      },
      decision,
    })
    const handler = createLeadManagementHandler(run.dependencies)
    expect((await handler(callRequest(updateCall))).status).toBe(200)
    revoked = true
    const denied = await handler(callRequest(updateCall))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({
      code: 'LEAD_MANAGEMENT_REFUSED',
      operation: 'project.update',
      reason: 'authority_unavailable',
    })
    expect(run.calls.length).toBe(1)
  })

  test('every delivery reaches the current-authority owner before the claim', async () => {
    const decision = await updateDecision()
    const order: string[] = []
    const run = harness({
      assertCurrent: async (_request, boundary) => {
        order.push(`assert:${boundary}`)
      },
      claim: async () => {
        order.push('claim')
        return { state: 'claimed' }
      },
      complete: async () => {
        order.push('complete')
        return true
      },
      decision,
    })
    await createLeadManagementHandler(run.dependencies)(callRequest(updateCall))
    expect(order).toEqual(['assert:admission', 'claim', 'complete'])
  })

  test('a failed completion is a bounded refyusal even when the effect ran', async () => {
    const decision = await updateDecision()
    const run = harness({ complete: async () => false, decision })
    const response = await createLeadManagementHandler(run.dependencies)(callRequest(updateCall))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      code: 'LEAD_MANAGEMENT_REFUSED',
      operation: 'project.update',
    })
  })

  test('refusal statuses map to typed outcomes for forbidden, conflict and unsupported', async () => {
    for (const [code, expectedStatus] of [
      ['forbidden', 403],
      ['stale_revision', 409],
      ['conflict', 409],
      ['unsupported', 501],
      ['unavailable', 503],
    ] as const) {
      const decision = await updateDecision()
      const run = harness({
        decision,
        operationOutcome: {
          failure: { code, message: 'refused', operation: 'project.update' },
          ok: false,
        },
      })
      const response = await createLeadManagementHandler(run.dependencies)(callRequest(updateCall))
      expect(response.status).toBe(expectedStatus)
      expect(await response.json()).toMatchObject({ code: 'LEAD_MANAGEMENT_REFUSED' })
    }
  })

  test('oversized bodies are refused before verification or operations', async () => {
    let verified = 0
    const run = harness({ decision: null })
    const handler = createLeadManagementHandler({
      ...run.dependencies,
      verify: async () => {
        verified += 1
        return null
      },
    })
    const response = await handler(
      new Request('https://adea-fixture.invalid/api/internal/pi-durable/management', {
        body: JSON.stringify({ ...updateCall, input: { name: 'x'.repeat(70_000) } }),
        headers: { authorization: 'Bearer signed-token' },
        method: 'POST',
      })
    )
    expect([404, 413]).toContain(response.status)
    expect(verified).toBeGreaterThanOrEqual(0)
    expect(run.calls).toEqual([])
  })
})

test('a canonical request that does not match the signed digest performs zero operations', async () => {
  const decision = await updateDecision()
  const mismatchedDigest = await managementInputDigest({ different: true })
  if (!mismatchedDigest) throw new Error('unreachable')
  const run = harness({ canonicalRequestDigest: mismatchedDigest, decision })
  const response = await createLeadManagementHandler(run.dependencies)(callRequest(updateCall))
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({
    code: 'LEAD_MANAGEMENT_REFUSED',
    operation: 'project.update',
    reason: 'authority_binding_mismatch',
  })
  expect(run.assertCurrentCalls).toEqual([])
  expect(run.calls).toEqual([])
})

describe('lead management call parsing (#1215)', () => {
  test('parses every supported operation with exact fields and targets', () => {
    const workspaceUpdate = parseLeadManagementCall(
      {
        canonicalRequest: CANONICAL_REQUEST,
        input: { expectedVersion: 3, name: 'Renamed', scene: 'home' },
        operation: 'config.workspace.update',
        schemaVersion: 'adea-management-call/v1',
        targetId: MANAGEMENT_WORKSPACE,
        workspaceId: MANAGEMENT_WORKSPACE,
      },
      AUTHORITY
    )
    expect(workspaceUpdate).toMatchObject({
      authority: AUTHORITY,
      expectedVersion: 3,
      operation: 'config.workspace.update',
      update: { name: 'Renamed', scene: 'home' },
      workspaceId: MANAGEMENT_WORKSPACE,
    })

    const member = parseLeadManagementCall(
      {
        canonicalRequest: CANONICAL_REQUEST,
        input: { projectId: MANAGEMENT_PROJECT, role: 'editor' },
        operation: 'project.member.set',
        schemaVersion: 'adea-management-call/v1',
        targetId: '0f3a2e1c-0000-4000-8000-0000000000cc',
        workspaceId: MANAGEMENT_WORKSPACE,
      },
      AUTHORITY
    )
    expect(member).toMatchObject({
      authority: AUTHORITY,
      operation: 'project.member.set',
      role: 'editor',
      userId: '0f3a2e1c-0000-4000-8000-0000000000cc',
    })
  })

  test('rejects unknown keys, wrong targets and malformed inputs', () => {
    for (const body of [
      { ...updateCall, extra: true },
      { ...updateCall, operation: 'project.unknown' },
      { ...updateCall, schemaVersion: 'v2' },
      { ...updateCall, targetId: 'not-a-uuid' },
      { ...updateCall, input: { name: '' } },
      { ...updateCall, input: { unknown: true } },
      {
        canonicalRequest: CANONICAL_REQUEST,
        input: {},
        operation: 'project.reorder',
        schemaVersion: 'adea-management-call/v1',
        targetId: MANAGEMENT_PROJECT,
        workspaceId: MANAGEMENT_WORKSPACE,
      },
      {
        canonicalRequest: CANONICAL_REQUEST,
        input: { projectIds: ['not-a-uuid'] },
        operation: 'project.reorder',
        schemaVersion: 'adea-management-call/v1',
        targetId: null,
        workspaceId: MANAGEMENT_WORKSPACE,
      },
      {
        canonicalRequest: CANONICAL_REQUEST,
        input: { expectedVersion: 0 },
        operation: 'config.workspace.update',
        schemaVersion: 'adea-management-call/v1',
        targetId: MANAGEMENT_WORKSPACE,
        workspaceId: MANAGEMENT_WORKSPACE,
      },
      {
        canonicalRequest: CANONICAL_REQUEST,
        input: { iconKey: 'box', id: MANAGEMENT_PROJECT, name: 'X' },
        operation: 'project.create',
        schemaVersion: 'adea-management-call/v1',
        targetId: null,
        workspaceId: MANAGEMENT_WORKSPACE,
      },
    ])
      expect(parseLeadManagementCall(body, AUTHORITY)).toBeNull()
  })
})
