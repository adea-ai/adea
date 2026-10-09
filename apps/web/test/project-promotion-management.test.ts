// Promotion wiring through the shared management API (M14.03.2, adea#1218).
// The same gateway contract the sibling #1215 slice enforces for other
// project operations applies here: the first authorization plus the late recheck, exact revision, and
// explicit confirmation, on the human and lead lanes alike.
import { describe, expect, test } from 'bun:test'
import type { AgentHqDatabase } from '@adea-ai/db'
import type { UserPrincipalRef } from '@adea-ai/types'

import {
  createManagementGateway,
  type ManagementAuditDecision,
  type ManagementCaller,
} from '../src/server/management-gateway'
import {
  createManagementOperations,
  type ManagementExecutors,
} from '../src/server/management-operations'
import { MANAGEMENT_NOW, managementAuthorityDecision } from './helpers/management-authority'

const WORKSPACE = '0f3a2e1c-0000-4000-8000-000000000001'
const PROJECT = '0f3a2e1c-0000-4000-8000-000000000002'
const PROJECT_VERSION = 7
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
  version: PROJECT_VERSION,
  visibility: 'workspace' as const,
  workspaceId: WORKSPACE,
}

type ExecutorCall = Readonly<{ args: readonly unknown[]; name: string }>

function harness(caller: ManagementCaller, options: Readonly<{ allowed?: boolean }> = {}) {
  const calls: ExecutorCall[] = []
  const authorized: Readonly<{ permission: string; workspaceId: string }>[] = []
  const audited: ManagementAuditDecision[] = []
  const executors: ManagementExecutors = {
    archiveProject: async (...args: unknown[]) => {
      calls.push({ args, name: 'archiveProject' })
    },
    createProject: async () => project,
    promoteProjectState: async (...args: unknown[]) => {
      calls.push({ args, name: 'promoteProjectState' })
      return project
    },
    removeProjectMember: async () => true,
    reopenWorkspace: async () => project,
    reorderProjects: async () => [project],
    setProjectMember: async () => ({
      createdAt: project.createdAt,
      displayName: null,
      projectId: PROJECT,
      role: 'viewer' as const,
      updatedAt: project.updatedAt,
      userId: PRINCIPAL.userId,
    }),
    setProjectVisibility: async () => project,
    softDeleteProject: async (...args: unknown[]) => {
      calls.push({ args, name: 'softDeleteProject' })
    },
    updateProject: async () => project,
    updateWorkspace: async () => ({ ...project, version: 2 }),
  }
  const gateway = createManagementGateway(
    {
      async assertCurrent() {},
      async authorize(input) {
        authorized.push({ permission: input.permission, workspaceId: input.workspaceId })
        return options.allowed ?? true
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
  }
}

function promoteInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    confirmed: true,
    expectedVersion: PROJECT_VERSION,
    principal: PRINCIPAL,
    projectId: PROJECT,
    workspaceId: WORKSPACE,
    ...overrides,
  }
}

describe('project promotion through the shared management API (#1218)', () => {
  test('authorizes with workspace.update and executes the exact revisioned call', async () => {
    const run = harness({ kind: 'human' })
    const outcome = await run.operations.projectPromote(promoteInput(), undefined)
    expect(outcome).toEqual({ ok: true, operation: 'project.promote', value: project })
    // The combined gateway authorizes once and rechecks after the awaited
    // authorize/audit, so a revocation during those waits stops the effect.
    expect(run.authorized).toEqual([
      { permission: 'workspace.update', workspaceId: WORKSPACE },
      { permission: 'workspace.update', workspaceId: WORKSPACE },
    ])
    expect(run.calls).toEqual([
      {
        args: [
          DATABASE,
          WORKSPACE,
          PROJECT,
          PRINCIPAL,
          { confirmed: true, expectedVersion: PROJECT_VERSION },
        ],
        name: 'promoteProjectState',
      },
    ])
  })

  test('a denied authorization never reaches the executor', async () => {
    const run = harness({ kind: 'human' }, { allowed: false })
    const outcome = await run.operations.projectPromote(promoteInput(), undefined)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure).toMatchObject({ code: 'forbidden', operation: 'project.promote' })
    expect(run.calls).toEqual([])
  })

  test('a stale revision projects to the typed stale-revision failure', async () => {
    const run = harness({ kind: 'human' })
    run.setExecutor('promoteProjectState', async () => {
      // The real class names its message `Project promotion conflict`; the
      // gateway maps on that stable public refusal, not on a private field.
      throw Object.assign(new Error('Project promotion conflict'), {
        name: 'ProjectStatePromotionError',
      })
    })
    const outcome = await run.operations.projectPromote(promoteInput(), undefined)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure).toMatchObject({
      code: 'stale_revision',
      message: 'Management target changed; refresh and retry',
      operation: 'project.promote',
    })
  })

  test('a missing confirmation projects to a typed conflict, never a silent promotion', async () => {
    const run = harness({ kind: 'human' })
    run.setExecutor(
      'promoteProjectState',
      async (_database, _workspace, _project, _principal, input) => {
        if (!input.confirmed) throw new Error('Project promotion not confirmed')
        return project
      }
    )
    const outcome = await run.operations.projectPromote(promoteInput({ confirmed: false }))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure).toMatchObject({
      code: 'conflict',
      message: 'Management target requires explicit confirmation',
      operation: 'project.promote',
    })
  })

  test('a lead caller takes the identical authorization and audit path', async () => {
    const decision = await managementAuthorityDecision({
      input: { confirmed: true, expectedVersion: PROJECT_VERSION },
      operation: 'project.promote',
      targetId: PROJECT,
    })
    const lead: ManagementCaller = {
      decision,
      kind: 'lead',
      reference: {
        authorityRef: decision.authorityRef,
        intentId: decision.intentId,
        leadAgentId: decision.leadAgentId,
      },
    }
    const run = harness(lead)
    const outcome = await run.operations.projectPromote(promoteInput(), decision.binding)
    expect(outcome).toEqual({ ok: true, operation: 'project.promote', value: project })
    expect(run.authorized).toEqual([
      { permission: 'workspace.update', workspaceId: WORKSPACE },
      { permission: 'workspace.update', workspaceId: WORKSPACE },
    ])
    expect(run.audited).toEqual([
      {
        authorityRef: decision.authorityRef,
        binding: decision.binding,
        caller: lead,
        decision: 'allowed',
        decisionId: decision.decisionId,
        operation: 'project.promote',
        permission: 'workspace.update',
        principal: PRINCIPAL,
        reason: 'lead_management_allowed',
        workspaceId: WORKSPACE,
      },
    ])
  })
})
