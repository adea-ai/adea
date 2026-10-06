import { describe, expect, test } from 'bun:test'
import type { DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'

import {
  archiveWorktree,
  commitWorktreeCleanup,
  createSessionOn,
  createWorktree,
  openWorktreeExternally,
  planWorktreeCleanup,
  renameWorktree,
  unbindProject,
} from '../src/sidebar/dev-nav-actions'
import {
  listDevHarnessRuns,
  listDevWorktrees,
  readDevDiffSummaries,
} from '../src/sidebar/dev-nav-runtime'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

function runtime(respond: (command: DevCommand) => unknown) {
  const commands: DevCommand[] = []
  return {
    commands,
    execute: async (command: DevCommand): Promise<DevReply> => {
      commands.push(command)
      const value = respond(command)
      if (value instanceof Error)
        return {
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: false,
          error: {
            code: 'invalid_state',
            retryable: false,
            message: value.message,
            observedAt: '2026-10-06T00:00:00.000Z',
          },
        }
      return {
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        ok: true,
        value,
      } as DevReply
    },
  }
}

const record = {
  id: 'wt-1',
  projectId: 'p',
  kind: 'managed' as const,
  repoId: 'repo-1',
  generation: 4,
  version: 7,
  rootIdentity: { mtimeNs: '1', size: '2' },
}

describe('Dev sidebar runtime reads', () => {
  test('worktrees are listed scope-wide, paged with a bound, and parsed fail-closed', async () => {
    const service = runtime((command) => {
      const body = command.body as { cursor?: string }
      if (!body.cursor)
        return {
          items: [
            { id: 'wt-a', projectId: 'p', kind: 'primary', headRef: 'main', generation: 2 },
            { id: 'bad', projectId: 'p', kind: 'unknown' },
          ],
          nextCursor: 'c1',
        }
      return { items: [{ id: 'wt-b', projectId: 'p', kind: 'managed', branchRef: 'x' }] }
    })
    const worktrees = await listDevWorktrees(service, scope)
    expect(worktrees?.map((item) => [item.id, item.kind])).toEqual([
      ['wt-a', 'primary'],
      ['wt-b', 'managed'],
    ])
    expect(service.commands.map((command) => command.operation)).toEqual([
      'dev.worktree.list',
      'dev.worktree.list',
    ])
    expect(service.commands[0]!.body).toEqual({ archived: false, limit: 500 })
    expect(service.commands[0]!.capabilities).toEqual(['dev.worktree.read'])
  })

  test('a refused read is undefined, never an empty list', async () => {
    const service = runtime(() => new Error('missing capability'))
    expect(await listDevWorktrees(service, scope)).toBeUndefined()
    expect(await listDevHarnessRuns(service, scope)).toBeUndefined()
    expect(await readDevDiffSummaries(service, scope, ['wt'])).toBeUndefined()
  })

  test('harness runs keep only the fields leaf status reads', async () => {
    const service = runtime(() => ({
      items: [
        { id: 'r1', runtimeSessionId: 's', state: 'awaiting_input', extra: 'dropped' },
        { id: 'r2', runtimeSessionId: 's', state: 'not-a-state' },
      ],
    }))
    expect(await listDevHarnessRuns(service, scope)).toEqual([
      { runtimeSessionId: 's', state: 'awaiting_input' },
    ])
  })

  test('diff summaries are one batch of at most fifty distinct ids; none issues no call', async () => {
    const service = runtime((command) =>
      (command.body as { worktreeIds: string[] }).worktreeIds.map((worktreeId) => ({
        worktreeId,
        added: 1,
        removed: 2,
        filesChanged: 1,
      }))
    )
    expect(await readDevDiffSummaries(service, scope, [])).toEqual(new Map())
    expect(service.commands).toHaveLength(0)
    const ids = [...Array.from({ length: 70 }, (_, index) => `wt-${index}`), 'wt-0']
    const diffs = await readDevDiffSummaries(service, scope, ids)
    expect(service.commands).toHaveLength(1)
    expect((service.commands[0]!.body as { worktreeIds: string[] }).worktreeIds).toHaveLength(50)
    expect(service.commands[0]!.resource).toBeUndefined()
    expect(diffs?.get('wt-0')).toEqual({ added: 1, removed: 2 })
  })
})

describe('Dev sidebar runtime mutations', () => {
  test('new worktree names the project, repository, base and branch with an idempotency key', async () => {
    const service = runtime(() => ({ operationId: 'wt-new' }))
    const result = await createWorktree(service, scope, {
      projectId: 'p',
      repoId: 'repo-1',
      baseRef: 'main',
      branchName: 'feature/new',
    })
    expect(result.ok).toBe(true)
    const command = service.commands[0]!
    expect(command.operation).toBe('dev.worktree.create')
    expect(command.body).toEqual({
      projectId: 'p',
      repoId: 'repo-1',
      baseRef: 'main',
      branchName: 'feature/new',
    })
    expect(command.idempotencyKey).toBeString()
    expect(command.resource).toBeUndefined()
  })

  test('rename, archive and open bind the worktree resource at its generation', async () => {
    const service = runtime(() => ({ accepted: true }))
    await renameWorktree(service, scope, record, 'New title')
    await archiveWorktree(service, scope, record)
    await openWorktreeExternally(service, scope, record)
    const [rename, archive, open] = service.commands
    expect(rename!.body).toEqual({ worktreeId: 'wt-1', expectedVersion: 7, title: 'New title' })
    expect(rename!.resource).toEqual({ kind: 'worktree', id: 'wt-1', generation: 4 })
    expect(archive!.body).toEqual({ worktreeId: 'wt-1', expectedGeneration: 4 })
    expect(open!.operation).toBe('dev.files.openExternal')
    expect(open!.resource).toEqual({ kind: 'workspace_root', id: 'wt-1', generation: 4 })
    expect(open!.body).toMatchObject({
      worktreeId: 'wt-1',
      path: { worktreeId: 'wt-1', relativePath: '' },
      expectedIdentity: record.rootIdentity,
    })
  })

  test('delete plans first, words every step, and commits the reviewed plan', async () => {
    const service = runtime((command) =>
      command.operation === 'dev.worktree.cleanupPlan'
        ? {
            id: 'plan-1',
            digest: 'a'.repeat(64),
            steps: [{ kind: 'quarantine_worktree' }, { kind: 'delete_branch' }],
            blockers: [],
          }
        : { cleanupJobId: 'plan-1', state: 'completed' }
    )
    const plan = await planWorktreeCleanup(service, scope, record)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.steps).toEqual([
      'Move the worktree folder to quarantine',
      'Delete the worktree branch',
    ])
    expect((service.commands[0]!.body as { allowedSteps: string[] }).allowedSteps).toContain(
      'delete_branch'
    )
    await commitWorktreeCleanup(service, scope, record, plan.value)
    expect(service.commands[1]!.operation).toBe('dev.worktree.cleanupCommit')
    expect(service.commands[1]!.body).toEqual({ planId: 'plan-1', planDigest: 'a'.repeat(64) })
    expect(service.commands[1]!.resource).toEqual({ kind: 'worktree', id: 'wt-1', generation: 4 })
  })

  test('a refusal is a message, not a throw', async () => {
    const service = runtime(() => new Error('the worktree has live sessions'))
    expect(await archiveWorktree(service, scope, record)).toEqual({
      ok: false,
      message: 'the worktree has live sessions',
    })
    expect(
      await openWorktreeExternally(service, scope, { ...record, rootIdentity: undefined })
    ).toMatchObject({ ok: false })
  })

  test('an empty leaf starts a session on its worktree; unbind names the binding version', async () => {
    const service = runtime((command) =>
      command.operation === 'dev.session.create' ? { id: 'session-new' } : { id: 'p' }
    )
    expect(await createSessionOn(service, scope, 'p', record)).toEqual({
      ok: true,
      value: 'session-new',
    })
    expect(service.commands[0]!.body).toEqual({
      projectId: 'p',
      repoId: 'repo-1',
      worktreeId: 'wt-1',
    })
    await unbindProject(service, scope, 'p', 9)
    expect(service.commands[1]!.body).toEqual({ projectId: 'p', expectedVersion: 9 })
    expect(service.commands[1]!.resource).toEqual({ kind: 'project', id: 'p', generation: 9 })
  })
})
