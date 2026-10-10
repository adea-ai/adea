import { describe, expect, test } from 'bun:test'
import type { UserPrincipalRef, WorkspacePermission } from '@adea-ai/types'
import type { ManagementOperationId } from '@adea-ai/types/management'

import {
  createManagementGateway,
  managementFailure,
  type ManagementAuditDecision,
  type ManagementCaller,
} from '../src/server/management-gateway'
import type { ManagementAuthorityDecision } from '@adea-ai/types/management'
import {
  MANAGEMENT_NOW,
  MANAGEMENT_PRINCIPAL,
  MANAGEMENT_PROJECT,
  MANAGEMENT_WORKSPACE,
  managementAuthorityDecision,
} from './helpers/management-authority'

const PRINCIPAL: UserPrincipalRef = MANAGEMENT_PRINCIPAL

const human: ManagementCaller = { kind: 'human' }

function humanCaller(): ManagementCaller {
  return human
}

function leadCaller(decision: ManagementAuthorityDecision): ManagementCaller {
  return {
    decision,
    kind: 'lead',
    reference: {
      authorityRef: decision.authorityRef,
      intentId: decision.intentId,
      leadAgentId: decision.leadAgentId,
    },
  }
}

type AuthorizeCall = Readonly<{
  includeArchived?: boolean
  permission: WorkspacePermission
  principal: UserPrincipalRef
  workspaceId: string
}>

function dependencies(options?: {
  allowed?: boolean
  allowedSequence?: boolean[]
  assertCurrentThrows?: boolean
  auditThrows?: boolean
  authorizeThrows?: boolean
}) {
  const authorized: AuthorizeCall[] = []
  const audited: ManagementAuditDecision[] = []
  const assertCurrentCalls: Array<{ boundary: string; request: unknown }> = []
  let executed = 0
  return {
    assertCurrentCalls,
    audited,
    authorized,
    dependencies: {
      async assertCurrent(request: unknown, boundary: string) {
        if (options?.assertCurrentThrows) throw new Error('current authority revoked')
        assertCurrentCalls.push({ boundary, request })
      },
      async authorize(input: AuthorizeCall) {
        if (options?.authorizeThrows) throw new Error('authorization backend secret detail')
        authorized.push(input)
        if (options?.allowedSequence)
          return (
            options.allowedSequence[
              Math.min(authorized.length - 1, options.allowedSequence.length - 1)
            ] ?? true
          )
        return options?.allowed ?? true
      },
      async audit(record: ManagementAuditDecision) {
        if (options?.auditThrows) throw new Error('audit backend secret detail')
        audited.push(record)
      },
    },
    executed: () => executed,
    countExecution() {
      executed += 1
    },
  }
}

function gatewayFor(harness: ReturnType<typeof dependencies>, caller: ManagementCaller) {
  return createManagementGateway(harness.dependencies, caller, () => MANAGEMENT_NOW)
}

describe('shared management gateway (#1215)', () => {
  test('a human and a lead caller run the same operation through the same authorization', async () => {
    const decision = await managementAuthorityDecision({
      input: { name: 'Renamed' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    const lead: ManagementCaller = leadCaller(decision)
    const binding = decision.binding

    const runs = await Promise.all(
      [humanCaller(), lead].map(async (caller) => {
        const harness = dependencies()
        const gateway = gatewayFor(harness, caller)
        const outcome = await gateway.run(
          'project.update',
          { binding, principal: PRINCIPAL, workspaceId: MANAGEMENT_WORKSPACE },
          async () => {
            harness.countExecution()
            return { projectId: MANAGEMENT_PROJECT, updated: true }
          }
        )
        return { harness, outcome }
      })
    )
    for (const { harness, outcome } of runs) {
      expect(outcome).toEqual({
        ok: true,
        operation: 'project.update',
        value: { projectId: MANAGEMENT_PROJECT, updated: true },
      })
      expect(harness.authorized).toEqual([
        {
          permission: 'workspace.update',
          principal: PRINCIPAL,
          workspaceId: MANAGEMENT_WORKSPACE,
        },
        {
          permission: 'workspace.update',
          principal: PRINCIPAL,
          workspaceId: MANAGEMENT_WORKSPACE,
        },
      ])
      expect(harness.executed()).toBe(1)
    }
    // The human decision is already audited by the shared authorization API;
    // only the lead's inherited action is attributed here.
    expect(runs[0]!.harness.audited).toEqual([])
    expect(runs[1]!.harness.audited).toEqual([
      {
        authorityRef: 'authority-1',
        binding,
        caller: lead,
        decision: 'allowed',
        decisionId: 'decision-1',
        operation: 'project.update',
        permission: 'workspace.update',
        principal: PRINCIPAL,
        reason: 'lead_management_allowed',
        workspaceId: MANAGEMENT_WORKSPACE,
      },
    ])
  })

  test('a decision bound to another workspace, target, operation or input never executes', async () => {
    const cases = [
      await managementAuthorityDecision({
        input: { name: 'Renamed' },
        operation: 'project.update',
        targetId: MANAGEMENT_PROJECT,
        workspaceId: '0f3a2e1c-0000-4000-8000-00000000aaaa',
      }),
      await managementAuthorityDecision({
        input: { name: 'Renamed' },
        operation: 'project.update',
        targetId: '0f3a2e1c-0000-4000-8000-00000000bbbb',
      }),
      await managementAuthorityDecision({
        input: { name: 'Renamed' },
        operation: 'project.delete',
        targetId: MANAGEMENT_PROJECT,
      }),
      await managementAuthorityDecision({
        input: { name: 'Different' },
        operation: 'project.update',
        targetId: MANAGEMENT_PROJECT,
      }),
    ]
    for (const decision of cases) {
      const harness = dependencies()
      const gateway = gatewayFor(harness, leadCaller(decision))
      const outcome = await gateway.run(
        'project.update',
        { principal: PRINCIPAL, workspaceId: MANAGEMENT_WORKSPACE },
        async () => {
          harness.countExecution()
          return 'executed'
        }
      )
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure.reason).toBe('authority_binding_mismatch')
      expect(harness.authorized).toEqual([])
      expect(harness.audited).toEqual([])
      expect(harness.executed()).toBe(0)
    }
  })

  test('a lead caller without a decision or binding fails closed before authorization', async () => {
    const noDecisionHarness = dependencies()
    const noDecision = createManagementGateway(
      noDecisionHarness.dependencies,
      { decision: undefined as never, kind: 'lead', reference: undefined as never },
      () => MANAGEMENT_NOW
    )
    const first = await noDecision.run(
      'project.update',
      { principal: PRINCIPAL, workspaceId: MANAGEMENT_WORKSPACE },
      async () => {
        noDecisionHarness.countExecution()
        return 'executed'
      }
    )
    expect(first.ok).toBe(false)
    if (first.ok) throw new Error('unreachable')
    expect(first.failure.reason).toBe('authority_malformed')
    expect(noDecisionHarness.authorized).toEqual([])
    expect(noDecisionHarness.executed()).toBe(0)

    const decision = await managementAuthorityDecision({
      input: { name: 'Renamed' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    const noBindingHarness = dependencies()
    const noBinding = createManagementGateway(
      noBindingHarness.dependencies,
      leadCaller(decision),
      () => MANAGEMENT_NOW
    )
    const second = await noBinding.run(
      'project.update',
      { principal: PRINCIPAL, workspaceId: MANAGEMENT_WORKSPACE },
      async () => {
        noBindingHarness.countExecution()
        return 'executed'
      }
    )
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('unreachable')
    expect(second.failure.reason).toBe('authority_binding_mismatch')
    expect(noBindingHarness.authorized).toEqual([])
    expect(noBindingHarness.executed()).toBe(0)
  })

  test('denied, expired and future decisions map to typed reasons without executing', async () => {
    const denied = await managementAuthorityDecision({
      decision: 'denied',
      input: { name: 'Renamed' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    const expired = await managementAuthorityDecision({
      expiresAt: new Date(MANAGEMENT_NOW - 1).toISOString(),
      input: { name: 'Renamed' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    const future = await managementAuthorityDecision({
      input: { name: 'Renamed' },
      issuedAt: new Date(MANAGEMENT_NOW + 1_000).toISOString(),
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    for (const [decision, reason] of [
      [denied, 'authority_denied'],
      [expired, 'authority_expired'],
      [future, 'authority_not_yet_valid'],
    ] as const) {
      const harness = dependencies()
      const gateway = gatewayFor(harness, leadCaller(decision))
      const outcome = await gateway.run(
        'project.update',
        { binding: decision.binding, principal: PRINCIPAL, workspaceId: MANAGEMENT_WORKSPACE },
        async () => {
          harness.countExecution()
          return 'executed'
        }
      )
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure.reason).toBe(reason)
      expect(harness.authorized).toEqual([])
      expect(harness.executed()).toBe(0)
    }
  })

  test('a decision identity that does not match the resolver request is refused', async () => {
    const decision = await managementAuthorityDecision({
      input: { name: 'Renamed' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    const harness = dependencies()
    const gateway = createManagementGateway(
      harness.dependencies,
      {
        decision: { ...decision, intentId: 'other-intent' },
        kind: 'lead',
        reference: {
          authorityRef: decision.authorityRef,
          intentId: decision.intentId,
          leadAgentId: decision.leadAgentId,
        },
      },
      () => MANAGEMENT_NOW
    )
    const outcome = await gateway.run(
      'project.update',
      { binding: decision.binding, principal: PRINCIPAL, workspaceId: MANAGEMENT_WORKSPACE },
      async () => 'executed'
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.reason).toBe('authority_binding_mismatch')
  })

  test('device-only management is refused with a typed reason and no side effects', async () => {
    const harness = dependencies()
    const gateway = gatewayFor(harness, humanCaller())
    const outcome = await gateway.run(
      'memory.entry.update',
      { principal: PRINCIPAL, workspaceId: MANAGEMENT_WORKSPACE },
      async () => harness.countExecution()
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure).toEqual({
      code: 'unsupported',
      message: 'Management operation is not available on this lane',
      operation: 'memory.entry.update',
      reason: 'device_required',
    })
    expect(harness.authorized).toEqual([])
    expect(harness.executed()).toBe(0)
  })

  test('authorization and audit backend errors become bounded failures before execution', async () => {
    const decision = await managementAuthorityDecision({
      input: { name: 'Renamed' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    for (const options of [{ authorizeThrows: true }, { auditThrows: true }]) {
      const harness = dependencies(options)
      const gateway = gatewayFor(harness, leadCaller(decision))
      const outcome = await gateway.run(
        'project.update',
        { binding: decision.binding, principal: PRINCIPAL, workspaceId: MANAGEMENT_WORKSPACE },
        async () => {
          harness.countExecution()
          return 'executed'
        }
      )
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure).toEqual({
        code: 'unavailable',
        message: options.auditThrows
          ? 'Management audit is unavailable'
          : 'Management authorization is unavailable',
        operation: 'project.update',
      })
      expect(harness.executed()).toBe(0)
      expect(JSON.stringify(outcome)).not.toContain('secret')
    }
  })

  test('denied authorization never executes and is attributed for a lead', async () => {
    const decision = await managementAuthorityDecision({
      input: { name: 'Renamed' },
      operation: 'project.delete',
      targetId: MANAGEMENT_PROJECT,
    })
    const harness = dependencies({ allowed: false })
    const gateway = gatewayFor(harness, leadCaller(decision))
    const outcome = await gateway.run(
      'project.delete',
      { binding: decision.binding, principal: PRINCIPAL, workspaceId: MANAGEMENT_WORKSPACE },
      async () => harness.countExecution()
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.code).toBe('forbidden')
    expect(harness.executed()).toBe(0)
    expect(harness.audited).toEqual([
      {
        authorityRef: decision.authorityRef,
        binding: decision.binding,
        caller: leadCaller(decision),
        decision: 'denied',
        decisionId: decision.decisionId,
        operation: 'project.delete',
        permission: 'workspace.update',
        principal: PRINCIPAL,
        reason: 'lead_management_denied',
        workspaceId: MANAGEMENT_WORKSPACE,
      },
    ])
  })

  test('reopen passes the archived authorization flag on the entry and late checks', async () => {
    const harness = dependencies()
    const gateway = gatewayFor(harness, humanCaller())
    await gateway.run(
      'config.workspace.reopen',
      { includeArchived: true, principal: PRINCIPAL, workspaceId: MANAGEMENT_WORKSPACE },
      async () => 'reopened'
    )
    expect(harness.authorized).toEqual([
      {
        includeArchived: true,
        permission: 'workspace.update',
        principal: PRINCIPAL,
        workspaceId: MANAGEMENT_WORKSPACE,
      },
      {
        includeArchived: true,
        permission: 'workspace.update',
        principal: PRINCIPAL,
        workspaceId: MANAGEMENT_WORKSPACE,
      },
    ])
  })

  test('a decision that expires during the awaited checks refuses at the effect boundary', async () => {
    const decision = await managementAuthorityDecision({
      input: { name: 'Renamed' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    const harness = dependencies()
    let clock = MANAGEMENT_NOW
    const gateway = createManagementGateway(harness.dependencies, leadCaller(decision), () => clock)
    harness.dependencies.authorize = async (input: AuthorizeCall) => {
      harness.authorized.push(input)
      // Park the await past the decision expiry, as a slow backend can.
      clock = MANAGEMENT_NOW + 120_000
      return true
    }
    const outcome = await gateway.run(
      'project.update',
      { binding: decision.binding, principal: PRINCIPAL, workspaceId: MANAGEMENT_WORKSPACE },
      async () => {
        harness.countExecution()
        return 'executed'
      }
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.reason).toBe('authority_expired')
    expect(harness.executed()).toBe(0)
  })

  test('an authority denial that lands after the audit stops the effect', async () => {
    const decision = await managementAuthorityDecision({
      input: { name: 'Renamed' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    const harness = dependencies({ allowedSequence: [true, false] })
    const gateway = gatewayFor(harness, leadCaller(decision))
    const outcome = await gateway.run(
      'project.update',
      { binding: decision.binding, principal: PRINCIPAL, workspaceId: MANAGEMENT_WORKSPACE },
      async () => {
        harness.countExecution()
        return 'executed'
      }
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.code).toBe('forbidden')
    expect(harness.authorized).toHaveLength(2)
    expect(harness.executed()).toBe(0)
    expect(harness.audited[0]?.decision).toBe('allowed')
  })

  test('the gateway asserts the canonical effect boundary with the exact decision', async () => {
    const decision = await managementAuthorityDecision({
      input: { name: 'Renamed' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    const harness = dependencies()
    const gateway = gatewayFor(harness, leadCaller(decision))
    await gateway.run(
      'project.update',
      { binding: decision.binding, principal: PRINCIPAL, workspaceId: MANAGEMENT_WORKSPACE },
      async () => 'executed'
    )
    expect(harness.assertCurrentCalls).toHaveLength(1)
    expect(harness.assertCurrentCalls[0]?.boundary).toBe('effect')
    expect(harness.assertCurrentCalls[0]?.request).toMatchObject({
      binding: decision.binding,
      decisionId: decision.decisionId,
    })
  })

  test('the effect assertion forwards the canonical request from the lead caller', async () => {
    const decision = await managementAuthorityDecision({
      input: { name: 'Renamed' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    const canonicalRequest = { toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG' }
    const harness = dependencies()
    const gateway = createManagementGateway(
      harness.dependencies,
      {
        canonicalRequest,
        decision,
        kind: 'lead',
        reference: {
          authorityRef: decision.authorityRef,
          intentId: decision.intentId,
          leadAgentId: decision.leadAgentId,
        },
      },
      () => MANAGEMENT_NOW
    )
    await gateway.run(
      'project.update',
      { binding: decision.binding, principal: PRINCIPAL, workspaceId: MANAGEMENT_WORKSPACE },
      async () => 'executed'
    )
    expect(harness.assertCurrentCalls[0]?.request).toMatchObject({ canonicalRequest })
  })

  test('a current-authority assertion that throws stops the effect', async () => {
    const decision = await managementAuthorityDecision({
      input: { name: 'Renamed' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    const harness = dependencies({ assertCurrentThrows: true })
    const gateway = gatewayFor(harness, leadCaller(decision))
    const outcome = await gateway.run(
      'project.update',
      { binding: decision.binding, principal: PRINCIPAL, workspaceId: MANAGEMENT_WORKSPACE },
      async () => {
        harness.countExecution()
        return 'executed'
      }
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.reason).toBe('authority_unavailable')
    expect(harness.executed()).toBe(0)
  })

  test('a lead effect without a current-authority owner fails closed', async () => {
    const decision = await managementAuthorityDecision({
      input: { name: 'Renamed' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    const harness = dependencies()
    const { assertCurrent: _assertCurrent, ...withoutCurrent } = harness.dependencies
    void _assertCurrent
    const gateway = createManagementGateway(
      withoutCurrent,
      leadCaller(decision),
      () => MANAGEMENT_NOW
    )
    const outcome = await gateway.run(
      'project.update',
      { binding: decision.binding, principal: PRINCIPAL, workspaceId: MANAGEMENT_WORKSPACE },
      async () => {
        harness.countExecution()
        return 'executed'
      }
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.reason).toBe('authority_unavailable')
    expect(harness.executed()).toBe(0)
  })

  test('maps stale revisions, conflicts and unavailable rows to typed failures', () => {
    for (const [message, code] of [
      ['Workspace version conflict', 'stale_revision'],
      ['Workspace order conflict', 'stale_revision'],
      ['Project order conflict', 'stale_revision'],
      ['Project id conflict', 'conflict'],
      ['Project sharing forbidden', 'forbidden'],
      ['Project read-only', 'forbidden'],
      ['Project unavailable', 'unavailable'],
      ['Workspace unavailable', 'unavailable'],
      ['Workspace cleanup required', 'conflict'],
    ] as const) {
      const error = Object.assign(new Error(message), { name: message })
      expect(managementFailure('project.update' as ManagementOperationId, error)).toMatchObject({
        code,
        operation: 'project.update',
      })
    }
  })

  test('refuses to leak unknown error text through a typed failure', () => {
    const failure = managementFailure(
      'project.update',
      new Error('database exploded with secret detail')
    )
    expect(failure.code).toBe('unavailable')
    expect(failure.message).toBe('Management operation is unavailable')
    expect(JSON.stringify(failure)).not.toContain('secret')
  })
})
