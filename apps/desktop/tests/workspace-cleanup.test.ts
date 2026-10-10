import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorkspaceCleanup } from '../shell/src/workspace-cleanup'
const scope = {
  accountId: 'account',
  workspaceId: '00000000-0000-4000-8000-00000000000a',
  runtimeNodeId: 'node',
}
const credential = { kind: 'temporary' as const, credential: 'fixture-only' }
function fixture(
  run: (context: {
    create(): ReturnType<typeof createWorkspaceCleanup>
    steps: string[]
    state(value: 'active' | 'deleted'): void
    idle(value: boolean): void
    failOnce(): void
  }) => Promise<void>
) {
  const dir = mkdtempSync(join(tmpdir(), 'adea-cleanup-'))
  const steps: string[] = []
  let state: 'active' | 'deleted' = 'active'
  let idle = true
  let fail = false
  const create = () =>
    createWorkspaceCleanup({
      dataDir: dir,
      currentScope: () => scope,
      verify: async () => state,
      assertIdle: async () => {
        if (!idle) throw new Error('workspace_cleanup_running_work')
      },
      planData: () => {},
      archiveSessions: () => {
        steps.push('archive')
      },
      purgeData: () => {
        if (fail) {
          fail = false
          throw new Error('fixture filesystem failure')
        }
        steps.push('purge')
      },
      forgetWorkspace: () => {
        steps.push('identity')
      },
    })
  return run({
    create,
    steps,
    state: (next) => {
      state = next
    },
    idle: (next) => {
      idle = next
    },
    failOnce: () => {
      fail = true
    },
  }).finally(() => rmSync(dir, { recursive: true, force: true }))
}
describe('workspace native deletion protocol', () => {
  test('refuses foreign scope and running work before any destructive effect', () =>
    fixture(async ({ create, steps, idle }) => {
      const cleanup = create()
      await expect(
        cleanup.prepare('00000000-0000-4000-8000-00000000000b', credential)
      ).rejects.toThrow('scope_unavailable')
      idle(false)
      await expect(cleanup.prepare(scope.workspaceId, credential)).rejects.toThrow('running_work')
      expect(steps).toEqual([])
      expect(cleanup.isPaused(scope)).toBe(false)
    }))
  test('fences writes until owner-confirmed cancellation; never trusts an uncommitted cloud deletion', () =>
    fixture(async ({ create, state, steps }) => {
      const cleanup = create()
      const ticket = await cleanup.prepare(scope.workspaceId, credential)
      expect(cleanup.isPaused(scope)).toBe(true)
      await expect(cleanup.commit(ticket.operationId, credential)).rejects.toThrow('not_deleted')
      expect(steps).toEqual([])
      await cleanup.cancel(ticket.operationId, credential)
      expect(cleanup.isPaused(scope)).toBe(false)
      const retry = await cleanup.prepare(scope.workspaceId, credential)
      state('deleted')
      await expect(cleanup.cancel(retry.operationId, credential)).rejects.toThrow('pending')
      expect(cleanup.isPaused(scope)).toBe(true)
    }))
  test('keeps a durable pending failure; retries after restart without re-archiving or claiming completion', () =>
    fixture(async ({ create, state, steps, failOnce }) => {
      const cleanup = create()
      const ticket = await cleanup.prepare(scope.workspaceId, credential)
      state('deleted')
      failOnce()
      await expect(cleanup.commit(ticket.operationId, credential)).rejects.toThrow('pending')
      expect(steps).toEqual(['archive'])
      expect(cleanup.pending()).toEqual([{ ...ticket, state: 'failed' }])
      expect(cleanup.isPaused(scope)).toBe(true)
      const restarted = create()
      expect(restarted.pending()).toEqual([{ ...ticket, state: 'failed' }])
      expect(await restarted.commit(ticket.operationId, credential)).toEqual({
        workspaceId: scope.workspaceId,
        complete: true,
      })
      expect(steps).toEqual(['archive', 'purge', 'identity'])
      expect(restarted.pending()).toEqual([])
      await restarted.commit(ticket.operationId, credential)
      expect(steps).toEqual(['archive', 'purge', 'identity'])
    }))
})

test('a restarted cleanup enters only the shell receipt scope after owner proof and restores the active scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adea-cleanup-resume-'))
  let cloud: 'active' | 'deleted' = 'active'
  let current = scope
  const entered: string[] = []
  const options = {
    dataDir: dir,
    currentScope: () => current,
    verify: async () => cloud,
    assertIdle: async () => {},
    planData: () => {},
    archiveSessions: () => {},
    purgeData: () => {},
    forgetWorkspace: () => {},
    activateScope: async (target: typeof scope) => {
      entered.push(target.workspaceId)
      return () => entered.push('restored')
    },
  }
  try {
    const ticket = await createWorkspaceCleanup(options).prepare(scope.workspaceId, credential)
    current = { ...scope, workspaceId: '00000000-0000-4000-8000-00000000000b' }
    const restarted = createWorkspaceCleanup(options)
    await expect(restarted.commit(ticket.operationId, credential)).rejects.toThrow('not_deleted')
    expect(entered).toEqual([])
    cloud = 'deleted'
    expect(await restarted.commit(ticket.operationId, credential)).toMatchObject({ complete: true })
    expect(entered).toEqual([scope.workspaceId, 'restored'])
    expect(restarted.isPaused(scope)).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('prepare intent alone never authorizes native deletion, including interrupted restart and repeated commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adea-cleanup-unverified-'))
  let state: 'active' | 'cleanup_pending' = 'active'
  const steps: string[] = []
  const options = {
    dataDir: dir,
    currentScope: () => scope,
    verify: async () => state,
    assertIdle: async () => {},
    planData: () => {},
    archiveSessions: () => {
      steps.push('archive')
    },
    purgeData: () => {
      steps.push('purge')
    },
    forgetWorkspace: () => {
      steps.push('identity')
    },
  }
  try {
    const ticket = await createWorkspaceCleanup(options).prepare(scope.workspaceId, credential)
    state = 'cleanup_pending'
    for (let retry = 0; retry < 2; retry++) {
      const restarted = createWorkspaceCleanup(options)
      await expect(restarted.commit(ticket.operationId, credential)).rejects.toThrow(
        'completion_unverified'
      )
      expect(steps).toEqual([])
      expect(restarted.pending()).toEqual([{ ...ticket, state: 'prepared' }])
      expect(restarted.isPaused(scope)).toBe(true)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
