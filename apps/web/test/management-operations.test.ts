import { describe, expect, test } from 'bun:test'
import type { AgentHqDatabase } from '@adea-ai/db'
import type { UserPrincipalRef } from '@adea-ai/types'

import {
  createManagementGateway,
  type ManagementAuditDecision,
  type ManagementCaller,
} from '../src/server/management-gateway'
import type { ManagementAuthorityDecision } from '@adea-ai/types/management'
import {
  createManagementOperations,
  type ManagementExecutors,
} from '../src/server/management-operations'
import { MANAGEMENT_NOW, managementAuthorityDecision } from './helpers/management-authority'

const WORKSPACE = '0f3a2e1c-0000-4000-8000-000000000001'
const PROJECT = '0f3a2e1c-0000-4000-8000-000000000002'
const PRINCIPAL: UserPrincipalRef = { kind: 'user', userId: 'user-1' }
const DATABASE = {} as AgentHqDatabase

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

type ExecutorCall = Readonly<{ args: readonly unknown[]; name: string }>

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

function harness(caller: ManagementCaller) {
  const calls: ExecutorCall[] = []
  const audited: ManagementAuditDecision[] = []
  const authorized: Readonly<{ permission: string; workspaceId: string }>[] = []
  const overrides: Partial<ManagementExecutors> = {}
  function recorded(name: string, result: unknown) {
    return async (...args: unknown[]) => {
      calls.push({ args, name })
      return result
    }
  }
  const executor = <Key extends keyof ManagementExecutors>(key: Key, result: unknown) =>
    (overrides[key] ?? recorded(key, result)) as ManagementExecutors[Key]
  const executors: ManagementExecutors = {
    archiveProject: async (...args: unknown[]) => {
      calls.push({ args, name: 'archiveProject' })
    },
    createProject: executor('createProject', project),
    removeProjectMember: executor('removeProjectMember', true),
    reopenWorkspace: executor('reopenWorkspace', project),
    reorderProjects: executor('reorderProjects', [project]),
    setProjectMember: executor('setProjectMember', {
      createdAt: project.createdAt,
      displayName: null,
      projectId: PROJECT,
      role: 'viewer' as const,
      updatedAt: project.updatedAt,
      userId: PRINCIPAL.userId,
    }),
    setProjectVisibility: executor('setProjectVisibility', project),
    softDeleteProject: async (...args: unknown[]) => {
      calls.push({ args, name: 'softDeleteProject' })
    },
    updateProject: executor('updateProject', project),
    updateWorkspace: executor('updateWorkspace', { ...project, version: 2 }),
  }
  Object.assign(executors, overrides)
  const gateway = createManagementGateway(
    {
      async authorize(input) {
        authorized.push({ permission: input.permission, workspaceId: input.workspaceId })
        return true
      },
      async audit(decision) {
        audited.push(decision)
      },
    },
    caller,
    () => MANAGEMENT_NOW
  )
  return {
    audited,
    authorized,
    calls,
    operations: createManagementOperations({
      database: () => DATABASE,
      executors,
      gateway,
    }),
    setExecutor<Key extends keyof ManagementExecutors>(key: Key, value: ManagementExecutors[Key]) {
      Object.assign(executors, { [key]: value })
    },
    setResult(key: keyof ManagementExecutors, result: unknown) {
      Object.assign(executors, { [key]: recorded(key, result) })
    },
  }
}

describe('shared management operations (#1215)', () => {
  test('workspace update authorizes and executes the existing versioned API', async () => {
    const run = harness({ kind: 'human' })
    run.setResult('updateWorkspace', { ...project, version: 3 })
    const outcome = await run.operations.workspaceUpdate({
      expectedVersion: 2,
      principal: PRINCIPAL,
      update: { name: 'Renamed' },
      workspaceId: WORKSPACE,
    })
    expect(outcome).toEqual({
      ok: true,
      operation: 'config.workspace.update',
      value: { ...project, version: 3 },
    })
    expect(run.authorized).toEqual([{ permission: 'workspace.update', workspaceId: WORKSPACE }])
    expect(run.calls).toEqual([
      {
        args: [DATABASE, WORKSPACE, PRINCIPAL, { expectedVersion: 2, update: { name: 'Renamed' } }],
        name: 'updateWorkspace',
      },
    ])
  })

  test('a lead project update takes the identical authorization and executor path', async () => {
    const decision = await managementAuthorityDecision({
      input: { name: 'Lead rename' },
      operation: 'project.update',
      targetId: PROJECT,
      workspaceId: WORKSPACE,
    })
    const lead: ManagementCaller = leadCaller(decision)
    const run = harness(lead)
    run.setResult('updateProject', { ...project, name: 'Lead rename' })
    const outcome = await run.operations.projectUpdate(
      {
        name: 'Lead rename',
        principal: PRINCIPAL,
        projectId: PROJECT,
        workspaceId: WORKSPACE,
      },
      decision.binding
    )
    expect(outcome).toEqual({
      ok: true,
      operation: 'project.update',
      value: { ...project, name: 'Lead rename' },
    })
    expect(run.authorized).toEqual([{ permission: 'workspace.update', workspaceId: WORKSPACE }])
    expect(run.calls[0]?.name).toBe('updateProject')
    expect(run.audited).toEqual([
      {
        authorityRef: decision.authorityRef,
        binding: decision.binding,
        caller: lead,
        decision: 'allowed',
        decisionId: decision.decisionId,
        operation: 'project.update',
        permission: 'workspace.update',
        principal: PRINCIPAL,
        reason: 'lead_management_allowed',
        workspaceId: WORKSPACE,
      },
    ])
  })

  test('a lead operation without its exact-call binding performs zero executor calls', async () => {
    const decision = await managementAuthorityDecision({
      input: { name: 'Lead rename' },
      operation: 'project.update',
      targetId: PROJECT,
      workspaceId: WORKSPACE,
    })
    const run = harness(leadCaller(decision))
    const outcome = await run.operations.projectUpdate({
      name: 'Lead rename',
      principal: PRINCIPAL,
      projectId: PROJECT,
      workspaceId: WORKSPACE,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.reason).toBe('authority_binding_mismatch')
    expect(run.authorized).toEqual([])
    expect(run.calls).toEqual([])
  })

  test('a lead audit record carries IDs and digests only, never raw input or secrets', async () => {
    const canary = 'canary-secret-7f3d9a1c-do-not-echo'
    const decision = await managementAuthorityDecision({
      input: { name: canary },
      operation: 'project.update',
      targetId: PROJECT,
      workspaceId: WORKSPACE,
    })
    const run = harness(leadCaller(decision))
    run.setResult('updateProject', { ...project, name: canary })
    await run.operations.projectUpdate(
      {
        name: canary,
        principal: PRINCIPAL,
        projectId: PROJECT,
        workspaceId: WORKSPACE,
      },
      decision.binding
    )
    const serialized = JSON.stringify(run.audited)
    expect(serialized).not.toContain(canary)
    expect(serialized).not.toContain('7f3d9a1c')
    expect(run.audited[0]?.decisionId).toBe(decision.decisionId)
    expect(run.audited[0]?.binding?.actionDigest).toBe(decision.binding.actionDigest)
    expect(run.audited[0]?.binding?.inputDigest).toBe(decision.binding.inputDigest)
    expect(run.audited[0]?.binding?.targetDigest).toBe(decision.binding.targetDigest)
  })

  test('maps a stale workspace revision to a typed failure without leaking detail', async () => {
    const run = harness({ kind: 'human' })
    run.setExecutor('updateWorkspace', async () => {
      // The real class names its message `Workspace version conflict`; the
      // gateway maps on that stable public refusal, not on a private field.
      throw Object.assign(new Error('Workspace version conflict'), {
        name: 'WorkspaceVersionConflictError',
      })
    })
    const outcome = await run.operations.workspaceUpdate({
      expectedVersion: 1,
      principal: PRINCIPAL,
      update: { name: 'Renamed' },
      workspaceId: WORKSPACE,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.code).toBe('stale_revision')
    expect(outcome.failure.message).toBe('Management target changed; refresh and retry')
  })

  test('maps a project order conflict to the same stale-revision contract', async () => {
    const run = harness({ kind: 'human' })
    run.setExecutor('reorderProjects', async () => {
      throw new Error('Project order conflict')
    })
    const outcome = await run.operations.projectReorder({
      principal: PRINCIPAL,
      projectIds: [PROJECT],
      workspaceId: WORKSPACE,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.code).toBe('stale_revision')
  })

  test('confirmation operations route through their dedicated executor and null value', async () => {
    const run = harness({ kind: 'human' })
    const archived = await run.operations.projectArchive({
      principal: PRINCIPAL,
      projectId: PROJECT,
      workspaceId: WORKSPACE,
    })
    const deleted = await run.operations.projectDelete({
      principal: PRINCIPAL,
      projectId: PROJECT,
      workspaceId: WORKSPACE,
    })
    expect(archived).toEqual({ ok: true, operation: 'project.archive', value: null })
    expect(deleted).toEqual({ ok: true, operation: 'project.delete', value: null })
    expect(run.calls.map((call) => call.name)).toEqual(['archiveProject', 'softDeleteProject'])
  })

  test('reopen passes the archived workspace authorization option', async () => {
    const run = harness({ kind: 'human' })
    run.setResult('reopenWorkspace', { ...project, deleted: false })
    await run.operations.workspaceReopen({ principal: PRINCIPAL, workspaceId: WORKSPACE })
    expect(run.calls[0]).toEqual({
      args: [DATABASE, WORKSPACE, PRINCIPAL],
      name: 'reopenWorkspace',
    })
  })
})
