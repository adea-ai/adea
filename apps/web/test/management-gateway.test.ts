import { describe, expect, test } from 'bun:test'
import type { UserPrincipalRef, WorkspacePermission } from '@adea-ai/types'
import type { ManagementOperationId } from '@adea-ai/types/management'

import {
  createManagementGateway,
  managementFailure,
  type ManagementAuditDecision,
  type ManagementCaller,
} from '../src/server/management-gateway'

const WORKSPACE = '0f3a2e1c-0000-4000-8000-000000000001'
const PROJECT = '0f3a2e1c-0000-4000-8000-000000000002'
const PRINCIPAL: UserPrincipalRef = { kind: 'user', userId: 'user-1' }

const human: ManagementCaller = { kind: 'human' }
const lead: ManagementCaller = {
  authorityRef: 'lead-turn:authority',
  intentId: 'intent-1',
  kind: 'lead',
  leadAgentId: 'agent-lead-1',
}

type AuthorizeCall = Readonly<{
  includeArchived?: boolean
  permission: WorkspacePermission
  principal: UserPrincipalRef
  workspaceId: string
}>

function dependencies(options?: { allowed?: boolean }) {
  const authorized: AuthorizeCall[] = []
  const audited: ManagementAuditDecision[] = []
  let executed = 0
  return {
    audited,
    authorized,
    dependencies: {
      async authorize(input: AuthorizeCall) {
        authorized.push(input)
        return options?.allowed ?? true
      },
      async audit(record: ManagementAuditDecision) {
        audited.push(record)
      },
    },
    executed: () => executed,
    countExecution() {
      executed += 1
    },
  }
}

describe('shared management gateway (#1215)', () => {
  test('a human and a lead caller run the same operation through the same authorization', async () => {
    const runs = await Promise.all(
      [human, lead].map(async (caller) => {
        const harness = dependencies()
        const gateway = createManagementGateway(harness.dependencies, caller)
        const outcome = await gateway.run(
          'project.update',
          { principal: PRINCIPAL, workspaceId: WORKSPACE },
          async () => {
            harness.countExecution()
            return { projectId: PROJECT, updated: true }
          }
        )
        return { harness, outcome }
      })
    )
    for (const { harness, outcome } of runs) {
      expect(outcome).toEqual({
        ok: true,
        operation: 'project.update',
        value: { projectId: PROJECT, updated: true },
      })
      expect(harness.authorized).toEqual([
        {
          permission: 'workspace.update',
          principal: PRINCIPAL,
          workspaceId: WORKSPACE,
        },
      ])
      expect(harness.executed()).toBe(1)
    }
    // The human decision is already audited by the shared authorization API;
    // only the lead's inherited action is attributed here.
    expect(runs[0]!.harness.audited).toEqual([])
    expect(runs[1]!.harness.audited).toEqual([
      {
        caller: lead,
        decision: 'allowed',
        operation: 'project.update',
        permission: 'workspace.update',
        principal: PRINCIPAL,
        reason: 'lead_management_allowed',
        workspaceId: WORKSPACE,
      },
    ])
  })

  test('a lead caller without resolved authority fails closed before authorization', async () => {
    const harness = dependencies()
    const gateway = createManagementGateway(harness.dependencies, {
      kind: 'lead',
      authorityRef: '',
      intentId: '',
      leadAgentId: '',
    })
    const outcome = await gateway.run(
      'project.update',
      { principal: PRINCIPAL, workspaceId: WORKSPACE },
      async () => harness.countExecution()
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure).toMatchObject({
      code: 'authority_required',
      reason: 'upstream_authority_unavailable',
    })
    expect(harness.authorized).toEqual([])
    expect(harness.audited).toEqual([])
    expect(harness.executed()).toBe(0)
  })

  test('device-only management is refused with a typed reason and no side effects', async () => {
    const harness = dependencies()
    const gateway = createManagementGateway(harness.dependencies, lead)
    const outcome = await gateway.run(
      'memory.entry.update',
      { principal: PRINCIPAL, workspaceId: WORKSPACE },
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

  test('denied authorization never executes and is attributed for a lead', async () => {
    const harness = dependencies({ allowed: false })
    const gateway = createManagementGateway(harness.dependencies, lead)
    const outcome = await gateway.run(
      'project.delete',
      { principal: PRINCIPAL, workspaceId: WORKSPACE },
      async () => harness.countExecution()
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.code).toBe('forbidden')
    expect(harness.executed()).toBe(0)
    expect(harness.audited).toEqual([
      {
        caller: lead,
        decision: 'denied',
        operation: 'project.delete',
        permission: 'workspace.update',
        principal: PRINCIPAL,
        reason: 'lead_management_denied',
        workspaceId: WORKSPACE,
      },
    ])
  })

  test('reopen passes the archived authorization flag exactly once through the shared path', async () => {
    const harness = dependencies()
    const gateway = createManagementGateway(harness.dependencies, human)
    await gateway.run(
      'config.workspace.reopen',
      { includeArchived: true, principal: PRINCIPAL, workspaceId: WORKSPACE },
      async () => 'reopened'
    )
    expect(harness.authorized).toEqual([
      {
        includeArchived: true,
        permission: 'workspace.update',
        principal: PRINCIPAL,
        workspaceId: WORKSPACE,
      },
    ])
  })

  test('maps stale revisions, conflicts and unavailable rows to typed failures', () => {
    for (const [message, code] of [
      ['Workspace version conflict', 'stale_revision'],
      ['Workspace order conflict', 'stale_revision'],
      ['Project order conflict', 'stale_revision'],
      ['Project id conflict', 'conflict'],
      ['Project sharing forbidden', 'forbidden'],
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
