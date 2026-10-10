import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { DevAuthorityError } from '../shell/src/dev-runtime/authority'
import { createDurableSqliteStore } from '../shell/src/dev-runtime/host-store'
import {
  registerProjectSessionRuntime,
  type ProjectSessionRuntime,
} from '../shell/src/dev-runtime/project-session/register'
import type {
  ArchiveRecord,
  DevCommand,
  Project,
  RuntimeSession,
  Scope,
} from '../../../../packages/types/src/dev-runtime'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const otherScope: Scope = { ...scope, workspaceId: '00000000-0000-4000-8000-000000000099' }

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
  lifecycle: 'active',
  archived: false,
  projection: 'structured',
  generation: 1,
  version: 1,
}

function seedRuntime(dataDir: string): ProjectSessionRuntime {
  const runtime = registerProjectSessionRuntime({
    authority: { registerCommandProvider() {} },
    dataDir,
    scope,
  })
  runtime.upsertProject(project)
  runtime.upsertSession(session)
  return runtime
}

function authorityFile(dataDir: string): string {
  const directory = join(dataDir, 'dev-runtime', 'project-session')
  const name = readdirSync(directory).find(
    (entry) => entry.startsWith('authority-v2-') && entry.endsWith('.sqlite3')
  )
  if (!name) throw new Error('scoped v2 authority SQLite file was not created')
  return join(directory, name)
}

function provider(
  runtime: ProjectSessionRuntime,
  operation: keyof ProjectSessionRuntime['providers'] & string
): (command: DevCommand) => unknown {
  const handler = runtime.providers[operation as DevCommand['operation']]
  if (!handler) throw new Error(`provider missing for ${operation}`)
  return handler
}

function command(
  body: unknown,
  commandScope: Scope = scope,
  overrides: Partial<DevCommand> = {}
): DevCommand {
  return {
    schemaVersion: 1,
    operation: 'dev.session.list',
    requestId: 'test-request',
    nonce: 'test-nonce',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    scope: commandScope,
    capabilities: ['dev.session.read'],
    body,
    ...overrides,
  } as DevCommand
}

function expectCode(run: () => unknown, code: DevAuthorityError['code']) {
  try {
    run()
  } catch (error) {
    if (error instanceof DevAuthorityError) {
      expect(error.code).toBe(code)
      return
    }
    // Resource-binding refusals are plain DevError-shaped objects, which the
    // channel surfaces verbatim; assert them by the same contract code.
    const candidate = error as { code?: unknown }
    if (candidate && typeof candidate === 'object' && candidate.code === code) return
    throw error
  }
  throw new Error(`expected DevAuthorityError ${code}`)
}

describe('project/session authority store', () => {
  test('project bindings, sessions, and archive records survive a process restart without fixtures', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      const first = seedRuntime(dataDir)
      const archiveReply = provider(
        first,
        'dev.session.archive'
      )(
        command({
          runtimeSessionId: session.id,
          expectedGeneration: session.generation,
          reason: 'owner request',
        })
      ) as ArchiveRecord
      expect(archiveReply.state).toBe('archived')

      // A brand-new register over the same data directory simulates a restart.
      const restarted = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      expect(
        (provider(restarted, 'dev.project.get')(command({ projectId: project.id })) as Project).id
      ).toBe(project.id)
      const restartedSession = provider(
        restarted,
        'dev.session.get'
      )(
        command({
          runtimeSessionId: session.id,
        })
      ) as RuntimeSession
      expect(restartedSession.archived).toBe(true)
      expect(restartedSession.version).toBe(session.version + 1)
      const archivedList = provider(
        restarted,
        'dev.session.list'
      )(
        command({
          archived: true,
        })
      ) as { items: RuntimeSession[] }
      expect(archivedList.items.map((entry) => entry.id)).toEqual([session.id])
      expect(restarted.archiveRecords().map((record) => record.id)).toEqual([archiveReply.id])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('archive persists the durable record and unarchive appends a restored record across restart', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      const first = seedRuntime(dataDir)
      provider(
        first,
        'dev.session.archive'
      )(
        command({
          runtimeSessionId: session.id,
          expectedGeneration: session.generation,
        })
      )
      const restored = provider(
        first,
        'dev.session.unarchive'
      )(
        command({
          runtimeSessionId: session.id,
          expectedGeneration: session.generation,
        })
      ) as ArchiveRecord
      expect(restored.state).toBe('restored')
      expect(restored.restoredAt).toBeString()

      const restarted = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      const persisted = provider(
        restarted,
        'dev.session.get'
      )(
        command({
          runtimeSessionId: session.id,
        })
      ) as RuntimeSession
      expect(persisted.archived).toBe(false)
      const records = restarted.archiveRecords()
      expect(records.map((record) => record.state)).toEqual(['archived', 'restored'])
      expect(records[0]!.runtimeSessionId).toBe(session.id)
      expect(records[0]!.worktreeId).toBe(session.worktreeId)
      expect(records[1]!.restoredAt).toBeString()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('archive and unarchive enforce scope, existence, generation, and state', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      const runtime = seedRuntime(dataDir)
      const archive = provider(runtime, 'dev.session.archive')
      const unarchive = provider(runtime, 'dev.session.unarchive')
      const unknownId = '00000000-0000-4000-8000-0000000000ff'
      expectCode(
        () => archive(command({ runtimeSessionId: session.id, expectedGeneration: 1 }, otherScope)),
        'unauthorized'
      )
      expectCode(
        () => archive(command({ runtimeSessionId: unknownId, expectedGeneration: 1 })),
        'not_found'
      )
      expectCode(
        () => unarchive(command({ runtimeSessionId: unknownId, expectedGeneration: 1 })),
        'not_found'
      )
      // The session exists and is live: unarchiving it violates the state machine.
      expectCode(
        () => unarchive(command({ runtimeSessionId: session.id, expectedGeneration: 1 })),
        'invalid_state'
      )
      // An ownership epoch bump fences commands bound to the old generation.
      const next = { ...session, generation: session.generation + 1, version: session.version + 1 }
      runtime.upsertSession(next)
      expectCode(
        () =>
          archive(
            command({ runtimeSessionId: session.id, expectedGeneration: session.generation })
          ),
        'stale_generation'
      )
      archive(command({ runtimeSessionId: session.id, expectedGeneration: next.generation }))
      expectCode(
        () =>
          archive(command({ runtimeSessionId: session.id, expectedGeneration: next.generation })),
        'invalid_state'
      )
      // Restore the session so the archive count assertions stay independent.
      const unarchived = unarchive(
        command({ runtimeSessionId: session.id, expectedGeneration: next.generation })
      ) as ArchiveRecord
      expect(unarchived.state).toBe('restored')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('dev.session.create validates the project and repository binding and persists across restart', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      const first = seedRuntime(dataDir)
      const create = provider(first, 'dev.session.create')
      const created = create(
        command({
          projectId: project.id,
          repoId: project.repoIds[0]!,
          worktreeId: '00000000-0000-4000-8000-000000000051',
        })
      ) as RuntimeSession
      expect(created.lifecycle).toBe('preparing')
      expect(created.archived).toBe(false)
      expect(created.generation).toBe(1)
      expect(created.version).toBe(1)
      expect(created.scope).toEqual(scope)

      expectCode(
        () =>
          create(
            command({
              projectId: '00000000-0000-4000-8000-0000000000ff',
              repoId: project.repoIds[0]!,
              worktreeId: '00000000-0000-4000-8000-000000000051',
            })
          ),
        'not_found'
      )
      expectCode(
        () =>
          create(
            command({
              projectId: project.id,
              repoId: '00000000-0000-4000-8000-0000000000ff',
              worktreeId: '00000000-0000-4000-8000-000000000051',
            })
          ),
        'identity_mismatch'
      )
      expectCode(
        () =>
          create(
            command(
              { projectId: project.id, repoId: project.repoIds[0]!, worktreeId: 'w' },
              otherScope
            )
          ),
        'unauthorized'
      )

      const restarted = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      const persisted = provider(
        restarted,
        'dev.session.get'
      )(
        command({
          runtimeSessionId: created.id,
        })
      ) as RuntimeSession
      expect(persisted.id).toBe(created.id)
      expect(persisted.worktreeId).toBe('00000000-0000-4000-8000-000000000051')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('dev.session.create replays one canonical session for the same key across restart', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      const first = seedRuntime(dataDir)
      const body = {
        projectId: project.id,
        repoId: project.repoIds[0]!,
        worktreeId: '00000000-0000-4000-8000-000000000051',
      }
      const keyed = (input: typeof body) =>
        ({
          ...command(input),
          idempotencyKey: 'chat-create-1',
        }) as DevCommand
      const created = provider(first, 'dev.session.create')(keyed(body)) as RuntimeSession
      expect((provider(first, 'dev.session.create')(keyed(body)) as RuntimeSession).id).toBe(
        created.id
      )

      const restarted = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      expect((provider(restarted, 'dev.session.create')(keyed(body)) as RuntimeSession).id).toBe(
        created.id
      )
      const sessions = provider(restarted, 'dev.session.list')(command({})) as {
        items: RuntimeSession[]
      }
      expect(sessions.items.filter((entry) => entry.worktreeId === body.worktreeId)).toHaveLength(1)
      expectCode(
        () =>
          provider(
            restarted,
            'dev.session.create'
          )(keyed({ ...body, worktreeId: '00000000-0000-4000-8000-000000000052' })),
        'idempotency_conflict'
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('dev.session.create forgets a key after the seven-day replay window', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      const first = seedRuntime(dataDir)
      const body = {
        projectId: project.id,
        repoId: project.repoIds[0]!,
        worktreeId: '00000000-0000-4000-8000-000000000051',
      }
      const keyed = (input: typeof body) =>
        ({
          ...command(input),
          idempotencyKey: 'expired-chat-create',
        }) as DevCommand
      const created = provider(first, 'dev.session.create')(keyed(body)) as RuntimeSession
      const storeFile = authorityFile(dataDir)
      const db = new Database(storeFile)
      try {
        const row = db.query('SELECT payload FROM durable_store_records WHERE id = 1').get() as {
          payload: string
        }
        const records = JSON.parse(row.payload) as Array<{
          sessionCreates?: Array<Record<string, unknown>>
        }>
        records[0]!.sessionCreates![0]!.createdAt = '2020-01-01T00:00:00.000Z'
        db.query('UPDATE durable_store_records SET payload = ? WHERE id = 1').run(
          JSON.stringify(records)
        )
      } finally {
        db.close()
      }

      const restarted = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      const recreated = provider(restarted, 'dev.session.create')(keyed(body)) as RuntimeSession
      expect(recreated.id).not.toBe(created.id)
      const sessions = provider(restarted, 'dev.session.list')(command({})) as {
        items: RuntimeSession[]
      }
      expect(sessions.items.filter((entry) => entry.worktreeId === body.worktreeId)).toHaveLength(2)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('upserts are the canonical write path: stale versions and lower generations are rejected', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      const runtime = seedRuntime(dataDir)
      expectCode(() => runtime.upsertSession(session), 'stale_version')
      expectCode(
        () => runtime.upsertSession({ ...session, version: session.version + 1, generation: 0 }),
        'stale_generation'
      )
      runtime.upsertSession({ ...session, version: session.version + 1 })
      expectCode(() => runtime.upsertProject(project), 'stale_version')
      // A foreign-scope write is rejected instead of silently dropped.
      expectCode(
        () =>
          runtime.upsertSession({ ...session, scope: otherScope, version: session.version + 2 }),
        'unauthorized'
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a corrupted authority store fails closed and retains the unread file', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      seedRuntime(dataDir)
      const storeFile = authorityFile(dataDir)
      writeFileSync(storeFile, '{not sqlite', { mode: 0o600 })
      expectCode(
        () =>
          registerProjectSessionRuntime({
            authority: { registerCommandProvider() {} },
            dataDir,
            scope,
          }),
        'corrupt_state'
      )
      // The unread bytes are retained beside the store for export/recovery.
      const retained = readdirSync(join(storeFile, '..')).filter(
        (name) =>
          name.startsWith(`${basename(storeFile)}.corrupt-`) &&
          !name.endsWith('-wal') &&
          !name.endsWith('-shm')
      )
      expect(retained.length).toBeGreaterThan(0)
      expect(readFileSync(join(storeFile, '..', retained[0]!), 'utf8')).toBe('{not sqlite')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a stored record for a foreign scope fails closed instead of rendering for the wrong node', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      seedRuntime(dataDir)
      const storeFile = authorityFile(dataDir)
      const database = new Database(storeFile)
      const payload = JSON.parse(
        (
          database.query('SELECT payload FROM durable_store_records WHERE id = 1').get() as {
            payload: string
          }
        ).payload
      ) as Array<Record<string, unknown>>
      payload[0] = {
        ...(payload[0] as { scope: Scope }),
        scope: otherScope,
      }
      database
        .query('UPDATE durable_store_records SET payload = ? WHERE id = 1')
        .run(JSON.stringify(payload))
      database.close()
      expectCode(
        () =>
          registerProjectSessionRuntime({
            authority: { registerCommandProvider() {} },
            dataDir,
            scope,
          }),
        'corrupt_state'
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  // Project update/archive/unbind carry a project resource binding whose
  // generation equals the record's optimistic version.
  function projectCommand(body: Record<string, unknown>, version: number): DevCommand {
    return {
      ...command(body),
      capabilities: ['dev.project.manage'],
      resource: {
        kind: 'project',
        id: (body.projectId as string) ?? project.id,
        generation: version,
      },
    } as DevCommand
  }

  test('dev.project.update patches binding fields, refuses names and groups, and fences versions', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      const runtime = seedRuntime(dataDir)
      const update = provider(runtime, 'dev.project.update')

      // The cloud owns names and grouping: the strict body decoder refuses them.
      for (const patch of [{ name: 'Renamed' }, { groupIds: [] }])
        expect(() =>
          update(
            projectCommand(
              { projectId: project.id, expectedVersion: project.version, patch },
              project.version
            )
          )
        ).toThrow('unknown key')

      // Stale version and a wrong/missing resource binding refuse.
      expectCode(
        () =>
          update(
            projectCommand(
              { projectId: project.id, expectedVersion: 99, patch: { defaultBaseRef: 'late' } },
              99
            )
          ),
        'stale_version'
      )
      expectCode(
        () =>
          update({
            ...projectCommand(
              { projectId: project.id, expectedVersion: project.version, patch: {} },
              project.version
            ),
            resource: { kind: 'repository', id: project.id, generation: project.version },
          } as DevCommand),
        'identity_mismatch'
      )

      const updated = update(
        projectCommand(
          {
            projectId: project.id,
            expectedVersion: project.version,
            patch: { defaultBaseRef: 'refs/heads/main' },
          },
          project.version
        )
      ) as Project
      expect(updated.defaultBaseRef).toBe('refs/heads/main')
      expect(updated.version).toBe(project.version + 1)
      expect(updated).not.toHaveProperty('name')
      expect(updated).not.toHaveProperty('groupIds')

      // The update persists across a restart.
      const restarted = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      const persisted = provider(
        restarted,
        'dev.project.get'
      )(command({ projectId: project.id })) as Project
      expect(persisted.defaultBaseRef).toBe('refs/heads/main')
      expect(persisted.version).toBe(updated.version)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('dev.project.archive refuses while sessions are live and flips lifecycle durably', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      const runtime = seedRuntime(dataDir)
      const archive = provider(runtime, 'dev.project.archive')
      const sessionArchive = provider(runtime, 'dev.session.archive')

      // A live (non-archived, execution-state) session blocks archiving.
      expectCode(
        () =>
          archive(
            projectCommand(
              { projectId: project.id, expectedVersion: project.version, archived: true },
              project.version
            )
          ),
        'invalid_state'
      )

      // Archive the session, then the project flips to archived.
      sessionArchive(
        command({ runtimeSessionId: session.id, expectedGeneration: session.generation })
      )
      const archived = archive(
        projectCommand(
          { projectId: project.id, expectedVersion: project.version, archived: true },
          project.version
        )
      ) as Project
      expect(archived.lifecycle).toBe('archived')
      expect(archived.version).toBe(project.version + 1)

      // Re-archiving is invalid; a stale version refuses; unarchive restores.
      expectCode(
        () =>
          archive(
            projectCommand(
              { projectId: project.id, expectedVersion: archived.version, archived: true },
              archived.version
            )
          ),
        'invalid_state'
      )
      expectCode(
        () =>
          archive(
            projectCommand({ projectId: project.id, expectedVersion: 99, archived: false }, 99)
          ),
        'stale_version'
      )
      const restored = archive(
        projectCommand(
          { projectId: project.id, expectedVersion: archived.version, archived: false },
          archived.version
        )
      ) as Project
      expect(restored.lifecycle).toBe('ready')
      expect(restored.version).toBe(archived.version + 1)

      // The flip persists across a restart.
      const restarted = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      const persisted = provider(
        restarted,
        'dev.project.get'
      )(command({ projectId: project.id })) as Project
      expect(persisted.lifecycle).toBe('ready')
      expect(persisted.version).toBe(restored.version)

      // An archived project is frozen for edits.
      const update = provider(restarted, 'dev.project.update')
      const restartedArchive = provider(restarted, 'dev.project.archive')
      const reArchived = restartedArchive(
        projectCommand(
          { projectId: project.id, expectedVersion: restored.version, archived: true },
          restored.version
        )
      ) as Project
      expectCode(
        () =>
          update(
            projectCommand(
              {
                projectId: project.id,
                expectedVersion: reArchived.version,
                patch: { defaultBaseRef: 'refs/heads/next' },
              },
              reArchived.version
            )
          ),
        'invalid_state'
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  function manageCommand(body: Record<string, unknown>): DevCommand {
    return { ...command(body), capabilities: ['dev.project.manage'] } as DevCommand
  }

  test('create and import bind the client-supplied cloud project id and refuse duplicates', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      const runtime = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
        resolveImportRoot: (rootBookmarkId) => ({ canonicalRoot: `/roots/${rootBookmarkId}` }),
      })
      const create = provider(runtime, 'dev.project.create')
      const importProject = provider(runtime, 'dev.project.import')
      const createdId = '00000000-0000-4000-8000-0000000000c1'
      const importedId = '00000000-0000-4000-8000-0000000000c2'

      const created = create(
        manageCommand({ projectId: createdId, repoIds: [], defaultBaseRef: 'main' })
      ) as Project
      expect(created).toEqual({
        id: createdId,
        scope,
        repoIds: [],
        defaultBaseRef: 'main',
        lifecycle: 'ready',
        version: 1,
      })
      const imported = importProject(
        manageCommand({ projectId: importedId, rootBookmarkId: 'bookmark-1' })
      ) as Project
      expect(imported.id).toBe(importedId)
      expect(imported.repos).toEqual([
        {
          repoId: imported.repoIds[0]!,
          rootBookmarkId: 'bookmark-1',
          canonicalRoot: '/roots/bookmark-1',
        },
      ])

      // A second binding for the same cloud project id is an identity
      // collision, whichever operation tries it.
      expectCode(
        () => create(manageCommand({ projectId: importedId, repoIds: [] })),
        'identity_mismatch'
      )
      expectCode(
        () => importProject(manageCommand({ projectId: createdId, rootBookmarkId: 'bookmark-2' })),
        'identity_mismatch'
      )
      // One authorized root binds once.
      expectCode(
        () =>
          importProject(
            manageCommand({
              projectId: '00000000-0000-4000-8000-0000000000c3',
              rootBookmarkId: 'bookmark-1',
            })
          ),
        'identity_mismatch'
      )
      // The id is an opaque lowercase UUID; anything else refuses.
      expectCode(
        () => create(manageCommand({ projectId: 'Not-A-UUID', repoIds: [] })),
        'identity_mismatch'
      )
      // Names and groups are not binding fields.
      expect(() =>
        create(manageCommand({ projectId: createdId, name: 'Adea', repoIds: [] }))
      ).toThrow('unknown key')
      expect(() =>
        importProject(
          manageCommand({ projectId: importedId, rootBookmarkId: 'bookmark-9', groupIds: [] })
        )
      ).toThrow('unknown key')
      expectCode(
        () =>
          create({
            ...manageCommand({ projectId: '00000000-0000-4000-8000-0000000000c4', repoIds: [] }),
            scope: otherScope,
          } as DevCommand),
        'unauthorized'
      )

      const restarted = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      const listed = provider(restarted, 'dev.project.list')(command({})) as { items: Project[] }
      expect(listed.items.map((entry) => entry.id)).toEqual([createdId, importedId])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('dev.project.unbind removes only the binding and refuses while sessions are live', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      const repoRoot = join(dataDir, 'repo')
      mkdirSync(repoRoot)
      writeFileSync(join(repoRoot, 'README.md'), 'kept\n')
      const events: Array<{ event: string; payload: unknown }> = []
      const runtime = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
        publish: (event, payload) => events.push({ event, payload }),
      })
      runtime.upsertProject({
        ...project,
        repos: [
          { repoId: project.repoIds[0]!, rootBookmarkId: 'bookmark-1', canonicalRoot: repoRoot },
        ],
      })
      runtime.upsertSession(session)
      const unbind = provider(runtime, 'dev.project.unbind')

      // A live session blocks unbinding, mirroring project archive.
      expectCode(
        () =>
          unbind(
            projectCommand(
              { projectId: project.id, expectedVersion: project.version },
              project.version
            )
          ),
        'invalid_state'
      )
      expectCode(
        () => unbind(projectCommand({ projectId: project.id, expectedVersion: 9 }, 9)),
        'stale_version'
      )
      expectCode(
        () =>
          unbind({
            ...projectCommand(
              { projectId: project.id, expectedVersion: project.version },
              project.version
            ),
            resource: undefined,
          } as DevCommand),
        'identity_mismatch'
      )
      expectCode(
        () =>
          unbind({
            ...projectCommand(
              { projectId: project.id, expectedVersion: project.version },
              project.version
            ),
            scope: otherScope,
          } as DevCommand),
        'unauthorized'
      )
      expectCode(
        () =>
          unbind(
            projectCommand(
              { projectId: '00000000-0000-4000-8000-0000000000ff', expectedVersion: 1 },
              1
            )
          ),
        'not_found'
      )

      provider(
        runtime,
        'dev.session.archive'
      )(command({ runtimeSessionId: session.id, expectedGeneration: session.generation }))
      const removed = unbind(
        projectCommand({ projectId: project.id, expectedVersion: project.version }, project.version)
      ) as Project
      expect(removed.id).toBe(project.id)
      expect(events.at(-1)).toMatchObject({
        event: 'dev.project.updated',
        payload: { kind: 'project.unbound', projectId: project.id },
      })
      // The repository files are never touched.
      expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toBe('kept\n')
      expect(runtime.findRepoBindings(project.repoIds[0]!)).toEqual([])

      const restarted = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      expect(
        (provider(restarted, 'dev.project.list')(command({})) as { items: Project[] }).items
      ).toEqual([])
      expectCode(
        () => provider(restarted, 'dev.project.get')(command({ projectId: project.id })),
        'not_found'
      )
      // The same cloud project can be bound again after an unbind.
      runtime.upsertProject(project)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('leaves v1 authority files byte-identical and unread', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      const directory = join(dataDir, 'dev-runtime', 'project-session')
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const v1Record = {
        scope,
        groups: [{ id: '00000000-0000-4000-8000-000000000010', name: 'Product' }],
        projects: [{ ...project, name: 'Adea', groupIds: [] }],
        sessions: [session],
        archiveRecords: [],
      }
      const v1ScopeDigest = createHash('sha256')
        .update(JSON.stringify([scope.accountId, scope.workspaceId, scope.runtimeNodeId]))
        .digest('hex')
      for (const name of [`authority-${v1ScopeDigest}.sqlite3`, 'authority.sqlite3']) {
        const v1 = createDurableSqliteStore<typeof v1Record>({
          file: join(directory, name),
          schemaVersion: 1,
          label: 'v1 fixture',
          scope,
        })
        v1.load()
        v1.save([v1Record])
      }
      const legacyEnvelope = JSON.stringify({ schemaVersion: 1, records: [v1Record] })
      writeFileSync(join(directory, 'authority.json'), legacyEnvelope, { mode: 0o600 })
      writeFileSync(join(directory, 'projection.json'), legacyEnvelope, { mode: 0o600 })
      const snapshot = () =>
        new Map(
          readdirSync(directory)
            .filter((name) => !name.startsWith('authority-v2-'))
            .map((name) => [name, readFileSync(join(directory, name)).toString('base64')])
        )
      const before = snapshot()

      const runtime = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      // Nothing from v1 is read: the v2 partition starts empty.
      expect(
        (provider(runtime, 'dev.project.list')(command({})) as { items: Project[] }).items
      ).toEqual([])
      expect(
        (provider(runtime, 'dev.session.list')(command({})) as { items: RuntimeSession[] }).items
      ).toEqual([])
      runtime.upsertProject(project)
      registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })

      expect(snapshot()).toEqual(before)
      expect(basename(authorityFile(dataDir))).toMatch(/^authority-v2-[0-9a-f]{64}\.sqlite3$/)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a v2 record that carries groups or local project names fails closed', () => {
    for (const mutate of [
      (record: Record<string, unknown>) => ({ ...record, groups: [] }),
      (record: Record<string, unknown>) => ({
        ...record,
        projects: (record.projects as Array<Record<string, unknown>>).map((entry) => ({
          ...entry,
          name: 'Adea',
        })),
      }),
    ]) {
      const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
      try {
        seedRuntime(dataDir)
        const database = new Database(authorityFile(dataDir))
        const payload = JSON.parse(
          (
            database.query('SELECT payload FROM durable_store_records WHERE id = 1').get() as {
              payload: string
            }
          ).payload
        ) as Array<Record<string, unknown>>
        database
          .query('UPDATE durable_store_records SET payload = ? WHERE id = 1')
          .run(JSON.stringify([mutate(payload[0]!)]))
        database.close()
        expectCode(
          () =>
            registerProjectSessionRuntime({
              authority: { registerCommandProvider() {} },
              dataDir,
              scope,
            }),
          'corrupt_state'
        )
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    }
  })
})

describe('workspace deletion session detachment', () => {
  test('blocks live sessions without mutating state; archives idle history and removes project bindings durably', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-delete-sessions-'))
    try {
      const runtime = seedRuntime(dataDir)
      expect(runtime.workspaceDeletionBlockers()).toEqual([session.id])
      expectCode(() => runtime.archiveWorkspaceForDeletion(), 'invalid_state')
      expect(runtime.getSession(session.id)?.archived).toBe(false)
      runtime.upsertSession({ ...session, lifecycle: 'completed', version: 2 })
      expect(runtime.workspaceDeletionBlockers()).toEqual([])
      expect(runtime.archiveWorkspaceForDeletion()).toBe(1)
      expect(runtime.getSession(session.id)).toMatchObject({
        archived: true,
        lifecycle: 'completed',
        version: 3,
      })
      expect(runtime.archiveRecords()).toHaveLength(1)
      expect(runtime.findRepoBindings(project.repoIds[0]!)).toEqual([])
      expect(runtime.archiveWorkspaceForDeletion()).toBe(0)
      const restarted = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      expect(restarted.getSession(session.id)?.archived).toBe(true)
      expect(restarted.archiveRecords()).toHaveLength(1)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('Dev-to-Chat-to-Dev transfer preserves native identity and never spawns a second session', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-project-session-transfer-'))
    try {
      const runtime = seedRuntime(dataDir)
      const transfer = provider(runtime, 'dev.session.transferInput')
      const list = provider(runtime, 'dev.session.list')

      const toChat = transfer(
        command(
          {
            runtimeSessionId: session.id,
            expectedGeneration: session.generation,
            fromView: 'dev',
            toView: 'chat',
            expectedOwnerVersion: session.version,
          },
          scope,
          {
            resource: { kind: 'runtime_session', id: session.id, generation: session.generation },
          }
        )
      ) as RuntimeSession
      expect(toChat).toMatchObject({
        id: session.id,
        projectId: session.projectId,
        repoId: session.repoId,
        worktreeId: session.worktreeId,
        projection: 'structured',
        lifecycle: 'active',
        generation: session.generation + 1,
        version: session.version + 1,
      })

      const toDev = transfer(
        command(
          {
            runtimeSessionId: session.id,
            expectedGeneration: toChat.generation,
            fromView: 'chat',
            toView: 'dev',
            expectedOwnerVersion: toChat.version,
          },
          scope,
          {
            resource: { kind: 'runtime_session', id: session.id, generation: toChat.generation },
          }
        )
      ) as RuntimeSession
      expect(toDev).toMatchObject({
        id: session.id,
        projectId: session.projectId,
        repoId: session.repoId,
        worktreeId: session.worktreeId,
        generation: session.generation + 2,
        version: session.version + 2,
      })

      // The registry still holds exactly the one native session: the view
      // round-trip transferred input ownership, it did not spawn a session.
      const items = (list(command({})) as { items: RuntimeSession[] }).items
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        id: session.id,
        projectId: session.projectId,
        repoId: session.repoId,
        worktreeId: session.worktreeId,
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('an unsupported structured projection stays one truthful fallback session', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-project-session-fallback-'))
    try {
      const runtime = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      runtime.upsertProject(project)
      runtime.upsertSession({ ...session, projection: 'terminal_fallback' })

      const items = (
        provider(runtime, 'dev.session.list')(command({})) as { items: RuntimeSession[] }
      ).items
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        id: session.id,
        projectId: session.projectId,
        worktreeId: session.worktreeId,
        projection: 'terminal_fallback',
      })

      // The Chat view resolves the same native session; no second session is
      // created for a fallback projection (the surface label is proved by the
      // chat-surface presentation tests).
      const fetched = provider(
        runtime,
        'dev.session.get'
      )(command({ runtimeSessionId: session.id })) as RuntimeSession
      expect(fetched).toMatchObject({
        id: session.id,
        projectId: session.projectId,
        worktreeId: session.worktreeId,
        projection: 'terminal_fallback',
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
