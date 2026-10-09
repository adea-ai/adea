import { describe, expect, test } from 'bun:test'
import type { UserPrincipalRef } from '@adea-ai/types'
import {
  managementOperationIds,
  managementOperationSupport,
  managementOperations,
  type ManagementAuthorityDecision,
  type ManagementCallBinding,
} from '@adea-ai/types/management'

import {
  executeLeadManagementTool,
  leadManagementToolDefinitions,
  type LeadManagementAuthority,
  type LeadManagementToolCall,
  type LeadManagementToolsDependencies,
} from '../src/server/lead-management-tools'
import type { ManagementCaller, ManagementOutcome } from '../src/server/management-gateway'
import type { ManagementOperations } from '../src/server/management-operations'
import {
  MANAGEMENT_NOW,
  MANAGEMENT_PRINCIPAL,
  MANAGEMENT_PROJECT,
  MANAGEMENT_WORKSPACE,
  managementAuthorityDecision,
} from './helpers/management-authority'

const AUTHORITY: LeadManagementAuthority = {
  authorityRef: 'authority-1',
  intentId: 'intent-1',
  leadAgentId: 'agent-lead-1',
}

type Call = Readonly<{
  args: unknown
  binding: ManagementCallBinding | undefined
  method: keyof ManagementOperations
}>

function success<T>(value: T) {
  return { ok: true as const, operation: 'project.update' as const, value }
}

type Resolver = (
  input: Readonly<LeadManagementAuthority & { binding: ManagementCallBinding }>
) => Promise<unknown>

function harness(options: {
  resolved?: unknown
  resolver?: Resolver
  consume?: (decision: ManagementAuthorityDecision) => Promise<boolean>
  operationsThrow?: boolean
}) {
  const calls: Call[] = []
  const callers: ManagementCaller[] = []
  const project = {
    createdAt: '2026-10-09T00:00:00.000Z',
    iconKey: 'box',
    id: MANAGEMENT_PROJECT,
    lifecycleState: 'active' as const,
    name: 'Lane',
    sortOrder: 0,
    sourceKind: 'none' as const,
    updatedAt: '2026-10-09T00:00:00.000Z',
    visibility: 'workspace' as const,
    workspaceId: MANAGEMENT_WORKSPACE,
  }
  const respond =
    <Method extends keyof ManagementOperations>(method: Method, value: unknown) =>
    async (args: unknown, binding?: ManagementCallBinding) => {
      calls.push({ args, binding, method })
      return success(value) as ManagementOutcome<unknown> as Awaited<
        ReturnType<ManagementOperations[Method]>
      >
    }
  const operations: ManagementOperations = {
    projectArchive: respond('projectArchive', null),
    projectCreate: respond('projectCreate', project),
    projectDelete: respond('projectDelete', null),
    projectMemberRemove: respond('projectMemberRemove', true),
    projectMemberSet: respond('projectMemberSet', {}),
    projectReorder: respond('projectReorder', [project]),
    projectUpdate: respond('projectUpdate', { ...project, name: 'Lead rename' }),
    projectVisibilitySet: respond('projectVisibilitySet', project),
    workspaceReopen: respond('workspaceReopen', project),
    workspaceUpdate: respond('workspaceUpdate', project),
  }
  const dependencies: LeadManagementToolsDependencies = {
    operationsFor(caller) {
      if (options.operationsThrow) throw new Error('operations composition crashed')
      callers.push(caller)
      return operations
    },
    resolveAuthority:
      options.resolver ??
      (async () => {
        if ('resolved' in options) return options.resolved
        return null
      }),
    ...(options.consume ? { consumeDecision: options.consume } : {}),
    now: () => MANAGEMENT_NOW,
  }
  return { calls, callers, dependencies }
}

const updateCall = {
  authority: AUTHORITY,
  name: 'Lead rename',
  operation: 'project.update',
  projectId: MANAGEMENT_PROJECT,
  workspaceId: MANAGEMENT_WORKSPACE,
} satisfies LeadManagementToolCall

describe('lead management tools (#1215)', () => {
  test('defines exactly the lead-callable inventory slice', () => {
    const expected = managementOperationIds.filter(
      (id) => managementOperationSupport(id, 'lead').state === 'supported'
    )
    expect(
      leadManagementToolDefinitions()
        .map((tool) => tool.name)
        .toSorted()
    ).toEqual([...expected].toSorted())
    for (const tool of leadManagementToolDefinitions()) {
      expect(tool.domain).toBe(managementOperations[tool.name].domain)
      expect(managementOperationSupport(tool.name, 'lead')).toEqual({ state: 'supported' })
      expect(managementOperations[tool.name].api.kind).toBe('web')
    }
  })

  test('a current exact-call bound decision routes through the shared operation', async () => {
    const decision = await managementAuthorityDecision({
      input: { name: 'Lead rename' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    const run = harness({ resolved: decision })
    const outcome = await executeLeadManagementTool(run.dependencies, updateCall)
    expect(outcome).toEqual({
      ok: true,
      operation: 'project.update',
      value: expect.objectContaining({ name: 'Lead rename' }),
    })
    expect(run.callers).toEqual([{ decision, kind: 'lead', reference: AUTHORITY }])
    expect(run.calls).toEqual([
      {
        args: {
          name: 'Lead rename',
          principal: MANAGEMENT_PRINCIPAL,
          projectId: MANAGEMENT_PROJECT,
          workspaceId: MANAGEMENT_WORKSPACE,
        },
        binding: decision.binding,
        method: 'projectUpdate',
      },
    ])
  })

  test('the resolver receives the exact-call binding, not just reference strings', async () => {
    const decision = await managementAuthorityDecision({
      input: { name: 'Lead rename' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    const received: unknown[] = []
    const run = harness({
      resolver: async (input) => {
        received.push(input)
        return decision
      },
    })
    await executeLeadManagementTool(run.dependencies, updateCall)
    expect(received).toEqual([{ ...AUTHORITY, binding: decision.binding }])
  })

  test('missing, unresolved or throwing authority fails closed before any operation', async () => {
    const withoutResolver: LeadManagementToolsDependencies = {
      operationsFor() {
        throw new Error('must not build operations without authority')
      },
    }
    const first = await executeLeadManagementTool(withoutResolver, updateCall)
    expect(first.ok).toBe(false)
    if (first.ok) throw new Error('unreachable')
    expect(first.failure.reason).toBe('authority_unavailable')

    const unresolved = harness({ resolved: null })
    const second = await executeLeadManagementTool(unresolved.dependencies, updateCall)
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('unreachable')
    expect(second.failure.reason).toBe('authority_unavailable')
    expect(unresolved.callers).toEqual([])

    const throwing = harness({
      resolver: async () => {
        throw new Error('authority service secret detail')
      },
    })
    const third = await executeLeadManagementTool(throwing.dependencies, updateCall)
    expect(third.ok).toBe(false)
    if (third.ok) throw new Error('unreachable')
    expect(third.failure.reason).toBe('authority_unavailable')
    expect(JSON.stringify(third)).not.toContain('secret')
    expect(throwing.callers).toEqual([])
  })

  test('malformed authority references fail closed without calling the resolver', async () => {
    for (const authority of [
      undefined,
      null,
      'authority-1',
      { ...AUTHORITY, authorityRef: '' },
      { ...AUTHORITY, intentId: 7 },
      { ...AUTHORITY, leadAgentId: '   ' },
    ]) {
      let resolverCalls = 0
      const run = harness({
        resolver: async () => {
          resolverCalls += 1
          return null
        },
      })
      const outcome = await executeLeadManagementTool(run.dependencies, {
        ...updateCall,
        authority: authority as LeadManagementAuthority,
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure.reason).toBe('authority_malformed')
      expect(resolverCalls).toBe(0)
      expect(run.callers).toEqual([])
    }
  })

  test('a malformed or mismatched decision performs zero operations', async () => {
    const malformed = harness({ resolved: { schemaVersion: 'adea-management-authority/v1' } })
    const first = await executeLeadManagementTool(malformed.dependencies, updateCall)
    expect(first.ok).toBe(false)
    if (first.ok) throw new Error('unreachable')
    expect(first.failure.reason).toBe('authority_malformed')
    expect(malformed.callers).toEqual([])

    const otherWorkspace = await managementAuthorityDecision({
      input: { name: 'Lead rename' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
      workspaceId: '0f3a2e1c-0000-4000-8000-00000000aaaa',
    })
    const otherTarget = await managementAuthorityDecision({
      input: { name: 'Lead rename' },
      operation: 'project.update',
      targetId: '0f3a2e1c-0000-4000-8000-00000000bbbb',
    })
    const otherOperation = await managementAuthorityDecision({
      input: {},
      operation: 'project.delete',
      targetId: MANAGEMENT_PROJECT,
    })
    const otherInput = await managementAuthorityDecision({
      input: { name: 'Different rename' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    for (const decision of [otherWorkspace, otherTarget, otherOperation, otherInput]) {
      const run = harness({ resolved: decision })
      const outcome = await executeLeadManagementTool(run.dependencies, updateCall)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure.reason).toBe('authority_binding_mismatch')
      expect(run.callers).toEqual([])
      expect(run.calls).toEqual([])
    }
  })

  test('denied and expired decisions map to typed reasons', async () => {
    const denied = await managementAuthorityDecision({
      decision: 'denied',
      input: { name: 'Lead rename' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    const expired = await managementAuthorityDecision({
      expiresAt: new Date(MANAGEMENT_NOW - 1).toISOString(),
      input: { name: 'Lead rename' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    for (const [decision, reason] of [
      [denied, 'authority_denied'],
      [expired, 'authority_expired'],
    ] as const) {
      const run = harness({ resolved: decision })
      const outcome = await executeLeadManagementTool(run.dependencies, updateCall)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure.reason).toBe(reason)
      expect(run.callers).toEqual([])
      expect(run.calls).toEqual([])
    }
  })

  test('a replayed single-use decision fails closed before any operation', async () => {
    const decision = await managementAuthorityDecision({
      input: { name: 'Lead rename' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    let consumed = false
    const run = harness({
      consume: async () => {
        if (consumed) return false
        consumed = true
        return true
      },
      resolved: decision,
    })
    const first = await executeLeadManagementTool(run.dependencies, updateCall)
    expect(first.ok).toBe(true)
    expect(run.calls.length).toBe(1)
    const replay = await executeLeadManagementTool(run.dependencies, updateCall)
    expect(replay.ok).toBe(false)
    if (replay.ok) throw new Error('unreachable')
    expect(replay.failure.reason).toBe('authority_replay')
    expect(run.calls.length).toBe(1)
  })

  test('a device-only operation is refused with its inventory reason before authority', async () => {
    let resolverCalls = 0
    const run = harness({
      resolver: async () => {
        resolverCalls += 1
        return null
      },
    })
    const outcome = await executeLeadManagementTool(run.dependencies, {
      authority: AUTHORITY,
      operation: 'memory.entry.update',
      workspaceId: MANAGEMENT_WORKSPACE,
    } as unknown as LeadManagementToolCall)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure).toEqual({
      code: 'unsupported',
      message: 'Management operation is not available on this lane',
      operation: 'memory.entry.update',
      reason: 'device_required',
    })
    expect(resolverCalls).toBe(0)
    expect(run.callers).toEqual([])
    expect(run.calls).toEqual([])
  })

  test('an unknown or malformed call is refused as authority_malformed', async () => {
    const run = harness({ resolved: null })
    for (const call of [null, 'project.update', { operation: 'not.an.operation' }]) {
      const outcome = await executeLeadManagementTool(
        run.dependencies,
        call as unknown as LeadManagementToolCall
      )
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure.reason).toBe('authority_malformed')
    }
    expect(run.callers).toEqual([])
  })

  test('an operations composition failure is a bounded typed failure', async () => {
    const decision = await managementAuthorityDecision({
      input: { name: 'Lead rename' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    const run = harness({ operationsThrow: true, resolved: decision })
    const outcome = await executeLeadManagementTool(run.dependencies, updateCall)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.code).toBe('unavailable')
    expect(JSON.stringify(outcome)).not.toContain('crashed')
  })

  test('the principal always comes from the decision, never from the call', async () => {
    const otherUser: UserPrincipalRef = { kind: 'user', userId: 'user-2' }
    const decision = await managementAuthorityDecision({
      input: { name: 'Lead rename' },
      operation: 'project.update',
      principal: otherUser,
      targetId: MANAGEMENT_PROJECT,
    })
    const run = harness({ resolved: decision })
    await executeLeadManagementTool(run.dependencies, updateCall)
    expect(run.calls[0]?.args).toMatchObject({ principal: otherUser })
  })
})
