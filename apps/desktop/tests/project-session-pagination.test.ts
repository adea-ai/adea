import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DevAuthorityError } from '../shell/src/dev-runtime/authority'
import {
  registerProjectSessionRuntime,
  type ProjectSessionRuntime,
} from '../shell/src/dev-runtime/project-session/register'
import type {
  DevCommand,
  DevRuntimePage,
  Project,
  RuntimeSession,
  Scope,
} from '@adea-ai/types/dev-runtime'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const project: Project = {
  id: '00000000-0000-4000-8000-000000000020',
  scope,
  repoIds: ['00000000-0000-4000-8000-000000000030'],
  lifecycle: 'ready',
  version: 1,
}
const session: RuntimeSession = {
  id: '00000000-0000-4000-8000-000000000040',
  scope,
  projectId: project.id,
  repoId: project.repoIds[0]!,
  worktreeId: '00000000-0000-4000-8000-000000000050',
  displayName: 'Foundation',
  lifecycle: 'completed',
  archived: false,
  projection: 'structured',
  generation: 1,
  version: 1,
}

function openRuntime(dataDir: string): ProjectSessionRuntime {
  return registerProjectSessionRuntime({
    authority: { registerCommandProvider() {} },
    dataDir,
    scope,
  })
}

function provider(
  runtime: ProjectSessionRuntime,
  operation: keyof ProjectSessionRuntime['providers'] & string
): (command: DevCommand) => unknown {
  const handler = runtime.providers[operation as DevCommand['operation']]
  if (!handler) throw new Error(`provider missing for ${operation}`)
  return handler
}

function command(body: unknown): DevCommand {
  return {
    schemaVersion: 1,
    operation: 'dev.session.list',
    requestId: 'test-request',
    nonce: 'test-nonce',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    scope,
    capabilities: ['dev.session.read'],
    body,
  } as DevCommand
}

function list(runtime: ProjectSessionRuntime, body: unknown): DevRuntimePage<RuntimeSession> {
  return provider(runtime, 'dev.session.list')(command(body)) as DevRuntimePage<RuntimeSession>
}

function expectCode(run: () => unknown, code: DevAuthorityError['code']): void {
  try {
    run()
  } catch (error) {
    if (error instanceof DevAuthorityError) {
      expect(error.code).toBe(code)
      return
    }
    const candidate = error as { code?: unknown }
    if (candidate && typeof candidate === 'object' && candidate.code === code) return
    throw error
  }
  throw new Error(`expected DevAuthorityError ${code}`)
}

// Even suffixes leave odd suffixes available as never-stored keyset boundaries.
function sessionId(index: number): string {
  return `00000000-0000-4000-8000-${(index * 2 + 256).toString(16).padStart(12, '0')}`
}

describe('durable runtime-session keyset pagination', () => {
  test('continues a >500-row filtered inventory after reopening the SQLite authority', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-pagination-restart-'))
    try {
      const firstRuntime = openRuntime(dataDir)
      firstRuntime.upsertProject(project)
      const liveIds = Array.from({ length: 620 }, (_, index) => sessionId(index))
      const archivedIds = Array.from({ length: 13 }, (_, index) => sessionId(index + 620))
      const allIds = [...liveIds, ...archivedIds]
      // Deliberately seed out of order; authority order must not become cursor order.
      for (let index = allIds.length - 1; index >= 0; index -= 1) {
        firstRuntime.upsertSession({
          ...session,
          archived: index >= liveIds.length,
          id: allIds[index]!,
        })
      }
      const filters = {
        archived: false,
        projectId: project.id,
        worktreeId: session.worktreeId,
      }
      const defaultPage = list(firstRuntime, filters)
      expect(defaultPage.items.map(({ id }) => id)).toEqual(liveIds.slice(0, 200))
      expect(defaultPage.nextCursor).toBe(liveIds[199])

      const firstPage = list(firstRuntime, { ...filters, limit: 500 })
      expect(firstPage.items.map(({ id }) => id)).toEqual(liveIds.slice(0, 500))
      expect(firstPage.nextCursor).toBe(liveIds[499])

      // Match the existing store tests' restart seam: a fresh register over the
      // same directory, with no re-seeding and no calls to session create/resume.
      const reopened = openRuntime(dataDir)
      const finalPage = list(reopened, {
        ...filters,
        cursor: firstPage.nextCursor,
        limit: 500,
      })
      expect(finalPage.items.map(({ id }) => id)).toEqual(liveIds.slice(500))
      expect(finalPage.nextCursor).toBeUndefined()
      const capturedIds = [...firstPage.items, ...finalPage.items].map(({ id }) => id)
      expect(capturedIds).toEqual(liveIds)
      expect(new Set(capturedIds).size).toBe(620)

      const archivedPage = list(reopened, { archived: true, limit: 500 })
      expect(archivedPage.items.map(({ id }) => id)).toEqual(archivedIds)
      expect(archivedPage.nextCursor).toBeUndefined()
      const allFirst = list(reopened, { limit: 500 })
      const allFinal = list(reopened, { cursor: allFirst.nextCursor, limit: 500 })
      expect([...allFirst.items, ...allFinal.items].map(({ id }) => id)).toEqual(allIds)
      expect(allFinal.nextCursor).toBeUndefined()
      expect(list(reopened, { ...filters, cursor: liveIds.at(-1), limit: 500 }).items).toEqual([])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('uses an exclusive key boundary even when that ID is absent from matching rows', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-pagination-boundary-'))
    try {
      const runtime = openRuntime(dataDir)
      runtime.upsertProject(project)
      const ids = [sessionId(0), sessionId(1), sessionId(2)]
      for (const id of ids) runtime.upsertSession({ ...session, id })
      const first = list(runtime, { archived: false, limit: 1 })
      expect(first.nextCursor).toBe(ids[0])
      // There is no session-delete API. Remove the boundary from the filtered
      // set via a versioned archive-state upsert, then reopen durable state.
      runtime.upsertSession({ ...session, id: ids[0]!, archived: true, version: 2 })
      const reopened = openRuntime(dataDir)
      const continued = list(reopened, { archived: false, cursor: first.nextCursor, limit: 2 })
      expect(continued.items.map(({ id }) => id)).toEqual(ids.slice(1))
      expect(continued.nextCursor).toBeUndefined()
      const neverStoredCursor = '00000000-0000-4000-8000-000000000101'
      expect(
        list(reopened, { cursor: neverStoredCursor, limit: 2 }).items.map(({ id }) => id)
      ).toEqual(ids.slice(1))
      const pastEnd = list(reopened, { cursor: sessionId(99), limit: 1 })
      expect(pastEnd.items).toEqual([])
      expect(pastEnd.nextCursor).toBeUndefined()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('filters project and worktree independently and together before pagination', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-pagination-filters-'))
    try {
      const runtime = openRuntime(dataDir)
      const otherProject: Project = {
        ...project,
        id: '00000000-0000-4000-8000-000000000021',
      }
      const otherWorktreeId = '00000000-0000-4000-8000-000000000051'
      runtime.upsertProject(project)
      runtime.upsertProject(otherProject)
      const ids = Array.from({ length: 4 }, (_, index) => sessionId(index))
      const rows = [
        { projectId: project.id, worktreeId: session.worktreeId },
        { projectId: otherProject.id, worktreeId: session.worktreeId },
        { projectId: project.id, worktreeId: otherWorktreeId },
        { projectId: otherProject.id, worktreeId: otherWorktreeId },
      ]
      rows.forEach((row, index) => runtime.upsertSession({ ...session, ...row, id: ids[index]! }))

      expect(list(runtime, { projectId: project.id }).items.map(({ id }) => id)).toEqual([
        ids[0],
        ids[2],
      ])
      expect(list(runtime, { worktreeId: session.worktreeId }).items.map(({ id }) => id)).toEqual([
        ids[0],
        ids[1],
      ])
      const combined = list(runtime, {
        projectId: project.id,
        worktreeId: otherWorktreeId,
        limit: 1,
      })
      // Matching row is third in global ID order; filtering must precede slicing.
      expect(combined.items.map(({ id }) => id)).toEqual([ids[2]])
      expect(combined.nextCursor).toBeUndefined()
      const first = list(runtime, { projectId: project.id, limit: 1 })
      expect(first.items.map(({ id }) => id)).toEqual([ids[0]])
      expect(first.nextCursor).toBe(ids[0])
      const final = list(runtime, { projectId: project.id, cursor: first.nextCursor, limit: 1 })
      expect(final.items.map(({ id }) => id)).toEqual([ids[2]])
      expect(final.nextCursor).toBeUndefined()
      const foreignId = '00000000-0000-4000-8000-000000000099'
      for (const filters of [{ projectId: foreignId }, { worktreeId: foreignId }]) {
        const empty = list(runtime, { ...filters, limit: 1 })
        expect(empty.items).toEqual([])
        expect(empty.nextCursor).toBeUndefined()
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('rejects invalid limits and cursors without changing durable session state', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-pagination-invalid-'))
    try {
      const runtime = openRuntime(dataDir)
      runtime.upsertProject(project)
      runtime.upsertSession(session)
      const invalidLimits: readonly unknown[] = [0, -1, 1.5, 501, NaN, Infinity, '1', false]
      const invalidCursors: readonly unknown[] = ['', 'x'.repeat(513), null, 1, false, {}, []]
      for (const limit of invalidLimits) {
        expectCode(() => list(runtime, { limit }), 'invalid_state')
      }
      for (const cursor of invalidCursors) {
        expectCode(() => list(runtime, { cursor, limit: 1 }), 'invalid_state')
      }
      const reopened = openRuntime(dataDir)
      const remaining = list(reopened, { limit: 1 })
      expect(remaining.items).toEqual([session])
      expect(remaining.nextCursor).toBeUndefined()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
