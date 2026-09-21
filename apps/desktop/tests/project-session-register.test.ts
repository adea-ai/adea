import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DevAuthorityError } from '../shell/src/dev-runtime/authority'
import {
  registerProjectSessionRuntime,
  type ProjectSessionRuntime,
} from '../shell/src/dev-runtime/project-session/register'
import type {
  ArchiveRecord,
  DevCommand,
  Group,
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

const group: Group = {
  id: '00000000-0000-4000-8000-000000000010',
  scope,
  name: 'Product',
  projectIds: ['00000000-0000-4000-8000-000000000020'],
  sortKey: 'product',
  version: 1,
}
const project: Project = {
  id: '00000000-0000-4000-8000-000000000020',
  scope,
  name: 'Adea',
  groupIds: [group.id],
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
  runtime.upsertGroup(group)
  runtime.upsertProject(project)
  runtime.upsertSession(session)
  return runtime
}

function provider(
  runtime: ProjectSessionRuntime,
  operation: keyof ProjectSessionRuntime['providers'] & string
): (command: DevCommand) => unknown {
  const handler = runtime.providers[operation as DevCommand['operation']]
  if (!handler) throw new Error(`provider missing for ${operation}`)
  return handler
}

function command(body: unknown, commandScope: Scope = scope): DevCommand {
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
  test('projects, sessions, groups, and archive records survive a process restart without fixtures', () => {
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
      const groups = provider(restarted, 'dev.group.list')(command({})) as { items: Group[] }
      expect(groups.items.map((entry) => entry.id)).toEqual([group.id])
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

  test('group and project reorder are durable and reject foreign or stale input', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      const first = seedRuntime(dataDir)
      const projectReorder = provider(first, 'dev.project.reorder')
      expectCode(
        () =>
          projectReorder(
            command({
              groupId: group.id,
              orderedProjectIds: ['00000000-0000-4000-8000-0000000000ff'],
              expectedGroupVersion: group.version,
            })
          ),
        'not_found'
      )
      expectCode(
        () =>
          projectReorder(
            command({
              groupId: group.id,
              orderedProjectIds: [project.id],
              expectedGroupVersion: group.version + 7,
            })
          ),
        'stale_version'
      )
      const reordered = projectReorder(
        command({
          groupId: group.id,
          orderedProjectIds: [project.id],
          expectedGroupVersion: group.version,
        })
      ) as Group
      expect(reordered.version).toBe(group.version + 1)

      const groupReorder = provider(first, 'dev.group.reorder')
      expectCode(
        () => groupReorder(command({ orderedGroupIds: ['00000000-0000-4000-8000-0000000000ff'] })),
        'not_found'
      )
      const page = groupReorder(command({ orderedGroupIds: [group.id] })) as { items: Group[] }
      expect(page.items.map((entry) => entry.id)).toEqual([group.id])

      const restarted = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      const groups = provider(restarted, 'dev.group.list')(command({})) as { items: Group[] }
      expect(groups.items[0]!.version).toBe(group.version + 1)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a corrupted authority store fails closed and retains the unread file', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      seedRuntime(dataDir)
      const storeFile = join(dataDir, 'dev-runtime', 'project-session', 'authority.json')
      writeFileSync(storeFile, '{not json', { mode: 0o600 })
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
      const retained = readdirSync(join(storeFile, '..')).filter((name) =>
        name.includes('.corrupt-')
      )
      expect(retained.length).toBeGreaterThan(0)
      expect(readFileSync(join(storeFile, '..', retained[0]!), 'utf8')).toBe('{not json')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a stored record for a foreign scope fails closed instead of rendering for the wrong node', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      seedRuntime(dataDir)
      const storeFile = join(dataDir, 'dev-runtime', 'project-session', 'authority.json')
      const envelope = JSON.parse(readFileSync(storeFile, 'utf8')) as {
        records: Array<Record<string, unknown>>
      }
      envelope.records[0] = {
        ...(envelope.records[0] as { scope: Scope }),
        scope: otherScope,
      }
      writeFileSync(storeFile, JSON.stringify(envelope), { mode: 0o600 })
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

  test('a legacy projection store is seeded once into the authority store and the original is retained', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      const legacyDir = join(dataDir, 'dev-runtime', 'project-session')
      mkdirSync(legacyDir, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(legacyDir, 'projection.json'),
        JSON.stringify({
          schemaVersion: 1,
          savedAt: new Date().toISOString(),
          records: [{ scope, groups: [group], projects: [project], sessions: [session] }],
        }),
        { mode: 0o600 }
      )
      const runtime = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      const projects = provider(runtime, 'dev.project.list')(command({})) as { items: Project[] }
      expect(projects.items.map((entry) => entry.id)).toEqual([project.id])
      expect(existsSync(join(legacyDir, 'authority.json'))).toBeTrue()
      // The unread original is never deleted by the migration.
      expect(existsSync(join(legacyDir, 'projection.json'))).toBeTrue()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  // #398 follow-up: project update/archive. These carry a project resource
  // binding whose generation equals the record's optimistic version.
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

  test('dev.project.update patches mutable fields, keeps group membership consistent, and fences versions', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-ps-register-'))
    try {
      const runtime = seedRuntime(dataDir)
      const update = provider(runtime, 'dev.project.update')
      const groupB = '00000000-0000-4000-8000-000000000011'
      runtime.upsertGroup({
        id: groupB,
        scope,
        name: 'Platform',
        projectIds: [],
        sortKey: 'platform',
        version: 1,
      })

      // Unknown group in the patch refuses the whole update.
      expectCode(
        () =>
          update(
            projectCommand(
              {
                projectId: project.id,
                expectedVersion: project.version,
                patch: { groupIds: [groupB, '00000000-0000-4000-8000-0000000000ff'] },
              },
              project.version
            )
          ),
        'not_found'
      )

      // Stale version and a wrong/missing resource binding refuse.
      expectCode(
        () =>
          update(
            projectCommand(
              { projectId: project.id, expectedVersion: 99, patch: { name: 'Late' } },
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
            resource: { kind: 'group', id: project.id, generation: project.version },
          } as DevCommand),
        'identity_mismatch'
      )

      const updated = update(
        projectCommand(
          {
            projectId: project.id,
            expectedVersion: project.version,
            patch: {
              name: 'Adea Platform',
              groupIds: [groupB],
              defaultBaseRef: 'refs/heads/main',
            },
          },
          project.version
        )
      ) as Project
      expect(updated.name).toBe('Adea Platform')
      expect(updated.groupIds).toEqual([groupB])
      expect(updated.defaultBaseRef).toBe('refs/heads/main')
      expect(updated.version).toBe(project.version + 1)

      // Membership moved atomically: the old group lost the project (version
      // bump), the new one gained it.
      const groups = provider(runtime, 'dev.group.list')(command({})) as {
        items: Array<{ id: string; projectIds: string[]; version: number }>
      }
      const product = groups.items.find((entry) => entry.id === group.id)!
      const platform = groups.items.find((entry) => entry.id === groupB)!
      expect(product.projectIds).toEqual([])
      expect(product.version).toBe(group.version + 1)
      expect(platform.projectIds).toEqual([project.id])

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
      expect(persisted.name).toBe('Adea Platform')
      expect(persisted.groupIds).toEqual([groupB])
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
              { projectId: project.id, expectedVersion: reArchived.version, patch: { name: 'X' } },
              reArchived.version
            )
          ),
        'invalid_state'
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
