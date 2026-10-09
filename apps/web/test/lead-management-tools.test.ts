import { describe, expect, test } from 'bun:test'
import type { UserPrincipalRef } from '@adea-ai/types'
import {
  managementOperationIds,
  managementOperationSupport,
  managementOperations,
} from '@adea-ai/types/management'

import {
  executeLeadManagementTool,
  leadManagementToolDefinitions,
  type LeadManagementToolCall,
  type LeadManagementToolsDependencies,
} from '../src/server/lead-management-tools'
import type { ManagementCaller, ManagementOutcome } from '../src/server/management-gateway'
import type { ManagementOperations } from '../src/server/management-operations'

const WORKSPACE = '0f3a2e1c-0000-4000-8000-000000000001'
const PROJECT = '0f3a2e1c-0000-4000-8000-000000000002'
const PRINCIPAL: UserPrincipalRef = { kind: 'user', userId: 'user-1' }
const AUTHORITY = {
  authorityRef: 'authority-1',
  intentId: 'intent-1',
  leadAgentId: 'agent-lead-1',
} as const

type Call = Readonly<{ args: unknown; method: keyof ManagementOperations }>

function success<T>(value: T) {
  return { ok: true as const, operation: 'project.update' as const, value }
}

function harness(resolved: Readonly<{ principal: UserPrincipalRef }> | null) {
  const calls: Call[] = []
  const callers: ManagementCaller[] = []
  const project = {
    createdAt: '2026-10-09T00:00:00.000Z',
    iconKey: 'box',
    id: PROJECT,
    lifecycleState: 'active' as const,
    name: 'Lane',
    sortOrder: 0,
    sourceKind: 'none' as const,
    updatedAt: '2026-10-09T00:00:00.000Z',
    visibility: 'workspace' as const,
    workspaceId: WORKSPACE,
  }
  const respond =
    <Method extends keyof ManagementOperations>(method: Method, value: unknown) =>
    async (args: unknown) => {
      calls.push({ args, method })
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
  return {
    calls,
    callers,
    dependencies: {
      operationsFor(caller) {
        callers.push(caller)
        return operations
      },
      resolveAuthority: async () => resolved,
    } satisfies LeadManagementToolsDependencies,
  }
}

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

  test('a resolved authority routes the tool through the shared operation', async () => {
    const run = harness({ principal: PRINCIPAL })
    const outcome = await executeLeadManagementTool(run.dependencies, {
      authority: AUTHORITY,
      name: 'Lead rename',
      operation: 'project.update',
      projectId: PROJECT,
      workspaceId: WORKSPACE,
    })
    expect(outcome).toEqual({
      ok: true,
      operation: 'project.update',
      value: expect.objectContaining({ name: 'Lead rename' }),
    })
    expect(run.callers).toEqual([
      {
        authorityRef: AUTHORITY.authorityRef,
        intentId: AUTHORITY.intentId,
        kind: 'lead',
        leadAgentId: AUTHORITY.leadAgentId,
      },
    ])
    expect(run.calls).toEqual([
      {
        args: {
          name: 'Lead rename',
          principal: PRINCIPAL,
          projectId: PROJECT,
          workspaceId: WORKSPACE,
        },
        method: 'projectUpdate',
      },
    ])
  })

  test('an unresolved upstream authority fails closed before any operation', async () => {
    const run = harness(null)
    const outcome = await executeLeadManagementTool(run.dependencies, {
      authority: AUTHORITY,
      name: 'Lead rename',
      operation: 'project.update',
      projectId: PROJECT,
      workspaceId: WORKSPACE,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure).toEqual({
      code: 'authority_required',
      message: 'Lead management authority is unavailable',
      operation: 'project.update',
      reason: 'upstream_authority_unavailable',
    })
    expect(run.callers).toEqual([])
    expect(run.calls).toEqual([])
  })

  test('a missing authority resolver and incomplete authority both fail closed', async () => {
    const withoutResolver: LeadManagementToolsDependencies = {
      operationsFor() {
        throw new Error('must not build operations without authority')
      },
    }
    const call = {
      authority: AUTHORITY,
      name: 'Lead rename',
      operation: 'project.update',
      projectId: PROJECT,
      workspaceId: WORKSPACE,
    } satisfies LeadManagementToolCall
    const first = await executeLeadManagementTool(withoutResolver, call)
    expect(first.ok).toBe(false)
    if (first.ok) throw new Error('unreachable')
    expect(first.failure.code).toBe('authority_required')

    const incomplete = harness({ principal: PRINCIPAL })
    const second = await executeLeadManagementTool(incomplete.dependencies, {
      ...call,
      authority: { ...AUTHORITY, authorityRef: '' },
    })
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('unreachable')
    expect(second.failure.reason).toBe('upstream_authority_unavailable')
    expect(incomplete.callers).toEqual([])
  })

  test('a device-only operation is refused with its inventory reason before authority', async () => {
    const run = harness({ principal: PRINCIPAL })
    const outcome = await executeLeadManagementTool(run.dependencies, {
      authority: AUTHORITY,
      operation: 'memory.entry.update',
      workspaceId: WORKSPACE,
    } as unknown as LeadManagementToolCall)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure).toEqual({
      code: 'unsupported',
      message: 'Management operation is not available on this lane',
      operation: 'memory.entry.update',
      reason: 'device_required',
    })
    expect(run.callers).toEqual([])
    expect(run.calls).toEqual([])
  })
})
