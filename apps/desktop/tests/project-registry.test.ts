import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { DevAuthorityError } from '../shell/src/dev-runtime/authority'
import {
  registerProjectSessionRuntime,
  type ProjectSessionRuntime,
} from '../shell/src/dev-runtime/project-session/register'
import { registerProjectScanRuntime } from '../shell/src/dev-runtime/projects/register'
import { devOperationDecoders } from '../../../packages/types/src/dev-runtime'
import type {
  DevCommand,
  DevOperation,
  Group,
  Project,
  ProjectScanEntry,
  ProjectScanPage,
  Scope,
} from '../../../packages/types/src/dev-runtime'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const otherScope: Scope = { ...scope, workspaceId: '00000000-0000-4000-8000-000000000099' }

function command(
  operation: DevOperation,
  body: unknown,
  commandScope: Scope = scope,
  resource?: { kind: string; id: string; generation: number }
): DevCommand {
  return {
    schemaVersion: 1,
    operation,
    requestId: 'test-request',
    nonce: 'test-nonce',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    scope: commandScope,
    capabilities: [],
    ...(resource ? { resource } : {}),
    body,
  } as DevCommand
}

function provider(
  runtime: ProjectSessionRuntime,
  operation: string
): (command: DevCommand) => unknown {
  const handler = runtime.providers[operation as DevOperation]
  if (!handler) throw new Error(`provider missing for ${operation}`)
  return handler
}

function expectCode(run: () => unknown, code: string) {
  try {
    run()
  } catch (error) {
    // The register throws both DevAuthorityError instances and plain DevError
    // objects (the session.create convention); both carry `code`.
    if (
      error instanceof DevAuthorityError ||
      (typeof error === 'object' && error !== null && 'code' in error && 'retryable' in error)
    ) {
      expect((error as { code: string }).code).toBe(code)
      return
    }
    throw error
  }
  throw new Error(`expected DevAuthorityError ${code}`)
}

/** Wrap a provider value in a success envelope and run the strict decoder. */
function decodeReply(operation: DevOperation, value: unknown) {
  return devOperationDecoders[operation].reply({
    schemaVersion: 1,
    operation,
    requestId: randomUUID(),
    ok: true,
    value,
    observedAt: new Date().toISOString(),
  })
}

function bootRegistry(
  dataDir: string,
  options?: { resolveImportRoot?: (id: string) => { canonicalRoot: string } }
) {
  return registerProjectSessionRuntime({
    authority: { registerCommandProvider() {} },
    dataDir,
    scope,
    resolveImportRoot:
      options?.resolveImportRoot ??
      ((rootBookmarkId) => {
        if (rootBookmarkId !== BOOKMARK_ID)
          throw new DevAuthorityError('unauthorized_root', 'root bookmark has been revoked')
        return { canonicalRoot: '/srv/authorized-root' }
      }),
  })
}

const BOOKMARK_ID = '00000000-0000-4000-8000-0000000000b0'

describe('project registry providers (#398)', () => {
  test('dev.group.create places groups with sort keys, shifting later groups with version bumps', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-registry-'))
    try {
      const runtime = bootRegistry(dataDir)
      const create = provider(runtime, 'dev.group.create')
      const first = create(command('dev.group.create', { name: 'Product' })) as Group
      const second = create(command('dev.group.create', { name: 'Ops' })) as Group
      expect(first.sortKey < second.sortKey).toBe(true)
      // Placing a new group after `first` moves `second`: its version bumps.
      const third = create(
        command('dev.group.create', { name: 'Infra', afterGroupId: first.id })
      ) as Group
      expect(third.version).toBe(1)
      const groups = provider(runtime, 'dev.group.list')(command('dev.group.list', {})) as {
        items: Group[]
      }
      expect(groups.items.map((group) => group.id)).toEqual([first.id, third.id, second.id])
      const shifted = groups.items.find((group) => group.id === second.id)!
      expect(shifted.version).toBe(2)

      expectCode(
        () => create(command('dev.group.create', { name: 'X', afterGroupId: randomUUID() })),
        'not_found'
      )
      // The reply decodes through the strict provider-owned decoder.
      expect(() => decodeReply('dev.group.create', first)).not.toThrow()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('dev.group.update and delete fence on version, resource binding, and empty-group state', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-registry-'))
    try {
      const runtime = bootRegistry(dataDir)
      const create = provider(runtime, 'dev.group.create')
      const group = create(command('dev.group.create', { name: 'Product' })) as Group
      const update = provider(runtime, 'dev.group.update')
      const remove = provider(runtime, 'dev.group.delete')

      expectCode(
        () =>
          update(
            command(
              'dev.group.update',
              { groupId: group.id, expectedVersion: 99, patch: { name: 'Renamed' } },
              scope,
              { kind: 'group', id: group.id, generation: 0 }
            )
          ),
        'stale_version'
      )
      expectCode(
        () =>
          update(
            command(
              'dev.group.update',
              { groupId: group.id, expectedVersion: group.version, patch: { name: 'Renamed' } },
              scope,
              { kind: 'project', id: group.id, generation: 0 }
            )
          ),
        'identity_mismatch'
      )
      const updated = update(
        command(
          'dev.group.update',
          { groupId: group.id, expectedVersion: group.version, patch: { name: 'Renamed' } },
          scope,
          { kind: 'group', id: group.id, generation: 0 }
        )
      ) as Group
      expect(updated.name).toBe('Renamed')
      expect(updated.version).toBe(group.version + 1)
      expect(() => decodeReply('dev.group.update', updated)).not.toThrow()

      // A non-empty group cannot be deleted (membership append moved the
      // group's version, so re-read it first).
      const project = provider(
        runtime,
        'dev.project.create'
      )(
        command('dev.project.create', {
          name: 'Adea',
          groupIds: [group.id],
          repoIds: [randomUUID()],
        })
      ) as Project
      const populatedVersion = (
        provider(runtime, 'dev.group.list')(command('dev.group.list', {})) as { items: Group[] }
      ).items.find((entry) => entry.id === group.id)!.version
      expectCode(
        () =>
          remove(
            command(
              'dev.group.delete',
              { groupId: group.id, expectedVersion: populatedVersion, confirmationId: 'confirm' },
              scope,
              { kind: 'group', id: group.id, generation: 0 }
            )
          ),
        'invalid_state'
      )
      // Detach the project first (fresh register), then delete succeeds.
      const empty = create(command('dev.group.create', { name: 'Empty' })) as Group
      const removed = remove(
        command(
          'dev.group.delete',
          { groupId: empty.id, expectedVersion: empty.version, confirmationId: 'confirm' },
          scope,
          { kind: 'group', id: empty.id, generation: 0 }
        )
      ) as Group
      expect(removed.id).toBe(empty.id)
      expect(
        (
          provider(runtime, 'dev.group.list')(command('dev.group.list', {})) as { items: Group[] }
        ).items.map((entry) => entry.id)
      ).not.toContain(empty.id)
      expect(project.id).toBeTypeOf('string')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('dev.project.import binds the authorized root, updates group membership atomically, and refuses duplicates', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-registry-'))
    try {
      const runtime = bootRegistry(dataDir)
      const group = provider(
        runtime,
        'dev.group.create'
      )(command('dev.group.create', { name: 'Product' })) as Group
      const importProject = provider(runtime, 'dev.project.import')

      // Unknown groups refuse before any record exists.
      expectCode(
        () =>
          importProject(
            command('dev.project.import', {
              name: 'Nope',
              rootBookmarkId: BOOKMARK_ID,
              groupIds: [randomUUID()],
            })
          ),
        'not_found'
      )
      const imported = importProject(
        command('dev.project.import', {
          name: 'Monorepo',
          rootBookmarkId: BOOKMARK_ID,
          groupIds: [group.id],
        })
      ) as Project
      expect(imported.lifecycle).toBe('ready')
      expect(imported.repos).toEqual([
        {
          repoId: imported.repoIds[0],
          rootBookmarkId: BOOKMARK_ID,
          canonicalRoot: '/srv/authorized-root',
        },
      ])
      expect(imported.groupIds).toEqual([group.id])

      // Group membership moved in the same snapshot: the group lists the
      // project and its version advanced.
      const groups = provider(runtime, 'dev.group.list')(command('dev.group.list', {})) as {
        items: Group[]
      }
      expect(groups.items[0]!.projectIds).toEqual([imported.id])
      expect(groups.items[0]!.version).toBe(group.version + 1)

      // A second import for the same authorized root is an identity collision.
      expectCode(
        () =>
          importProject(
            command('dev.project.import', {
              name: 'Again',
              rootBookmarkId: BOOKMARK_ID,
              groupIds: [group.id],
            })
          ),
        'identity_mismatch'
      )
      // A refused root (revoked/drifted) throws before any record changes.
      expectCode(
        () =>
          importProject(
            command('dev.project.import', {
              name: 'Revoked',
              rootBookmarkId: randomUUID(),
              groupIds: [group.id],
            })
          ),
        'unauthorized_root'
      )
      // Foreign scopes are unauthorized, never silently accepted.
      expectCode(
        () =>
          importProject(
            command(
              'dev.project.import',
              { name: 'Foreign', rootBookmarkId: BOOKMARK_ID, groupIds: [group.id] },
              otherScope
            )
          ),
        'unauthorized'
      )
      expect(() => decodeReply('dev.project.import', imported)).not.toThrow()

      // Everything survives a restart, including the repo binding.
      const restarted = bootRegistry(dataDir)
      const persisted = provider(
        restarted,
        'dev.project.get'
      )(command('dev.project.get', { projectId: imported.id })) as Project
      expect(persisted.repos?.[0]!.canonicalRoot).toBe('/srv/authorized-root')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('dev.project.create validates groups and persists across restart', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-registry-'))
    try {
      const runtime = bootRegistry(dataDir)
      const group = provider(
        runtime,
        'dev.group.create'
      )(command('dev.group.create', { name: 'Tools' })) as Group
      const createProject = provider(runtime, 'dev.project.create')
      expectCode(
        () =>
          createProject(
            command('dev.project.create', {
              name: 'X',
              groupIds: [randomUUID()],
              repoIds: [randomUUID()],
            })
          ),
        'not_found'
      )
      const created = createProject(
        command('dev.project.create', {
          name: 'Tools app',
          groupIds: [group.id],
          repoIds: [randomUUID()],
        })
      ) as Project
      expect(created.lifecycle).toBe('ready')
      expect(() => decodeReply('dev.project.create', created)).not.toThrow()

      const restarted = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      const persisted = provider(
        restarted,
        'dev.project.get'
      )(command('dev.project.get', { projectId: created.id })) as Project
      expect(persisted.name).toBe('Tools app')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('dev.project.scan provider (#398)', () => {
  function bootScan(options?: {
    scan?: (canonicalRoot: string) => {
      entries: Record<string, unknown>[]
      partial?: boolean
      diagnostics?: string[]
    }
  }) {
    const root = mkdtempSync(join(tmpdir(), 'adea-scan-root-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root' }))
    let invocations = 0
    const runtime = registerProjectScanRuntime({
      authority: { registerCommandProvider() {} },
      scope,
      resolveScanRoot: (id) => {
        if (id !== BOOKMARK_ID) throw new DevAuthorityError('unauthorized_root', 'revoked root')
        return { canonicalRoot: root }
      },
      scan:
        options?.scan ??
        (() => {
          invocations += 1
          return {
            entries: [],
            partial: false,
            diagnostics: [],
            examinedEntries: 0,
            cancelled: false,
          }
        }),
    })
    const scan = runtime.providers['dev.project.scan'] as (command: DevCommand) => ProjectScanPage
    return {
      scan: (body: unknown, commandScope: Scope = scope) =>
        scan(command('dev.project.scan', body, commandScope)),
      invocations: () => invocations,
      root,
    }
  }

  test('scope enforcement and refused roots', () => {
    const harness = bootScan()
    try {
      expectCode(() => harness.scan({ rootBookmarkId: BOOKMARK_ID }, otherScope), 'unauthorized')
      expectCode(() => harness.scan({ rootBookmarkId: randomUUID() }), 'unauthorized_root')
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  test('results are cached by fingerprint, force rescans, and changed manifests invalidate', () => {
    const harness = bootScan()
    try {
      const first = harness.scan({ rootBookmarkId: BOOKMARK_ID })
      expect(first.items).toEqual([])
      expect(first.partial).toBe(false)
      expect(harness.invocations()).toBe(1)
      harness.scan({ rootBookmarkId: BOOKMARK_ID })
      expect(harness.invocations()).toBe(1)
      harness.scan({ rootBookmarkId: BOOKMARK_ID, force: true })
      expect(harness.invocations()).toBe(2)
      // A manifest change moves the fingerprint and forces a fresh scan.
      utimesSync(join(harness.root, 'package.json'), new Date(), new Date(Date.now() + 3000))
      harness.scan({ rootBookmarkId: BOOKMARK_ID })
      expect(harness.invocations()).toBe(3)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  test('pagination binds the cached fingerprint; a moved scan refuses stale cursors', () => {
    const entries: ProjectScanEntry[] = Array.from({ length: 201 }, (_, index) => ({
      name: `pkg-${index}`,
      relativeDir: `pkgs/pkg-${index}`,
      manifestPath: `pkgs/pkg-${index}/package.json`,
      packageManager: 'npm',
      languages: [],
      suggestedScripts: [],
      diagnostics: [],
    }))
    const harness = bootScan({
      scan: () => ({ entries, partial: false, diagnostics: [] }),
    })
    try {
      const page1 = harness.scan({ rootBookmarkId: BOOKMARK_ID })
      expect(page1.items.length).toBe(200)
      expect(page1.nextCursor).toBeString()
      const page2 = harness.scan({
        rootBookmarkId: BOOKMARK_ID,
        cursor: page1.nextCursor as string,
      })
      expect(page2.items.length).toBe(1)
      expect(page2.nextCursor).toBeUndefined()
      // A cursor from another scan (fingerprint mismatch) refuses wholesale.
      const otherFingerprint = Buffer.from(
        JSON.stringify({ fingerprint: 'stale-fingerprint', offset: 200 }),
        'utf8'
      ).toString('base64url')
      expectCode(
        () => harness.scan({ rootBookmarkId: BOOKMARK_ID, cursor: otherFingerprint }),
        'stale_version'
      )
      // A malformed cursor is not_found, never a crash.
      expectCode(
        () => harness.scan({ rootBookmarkId: BOOKMARK_ID, cursor: 'not-a-cursor' }),
        'not_found'
      )
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  test('partial scans stay successful and carry their diagnostics', () => {
    const harness = bootScan({
      scan: () => ({
        entries: [],
        partial: true,
        diagnostics: ['budget_exhausted'],
      }),
    })
    try {
      const page = harness.scan({ rootBookmarkId: BOOKMARK_ID })
      expect(page.partial).toBe(true)
      expect(page.diagnostics).toContain('budget_exhausted')
      // The strict reply decoder accepts a partial page as a success.
      expect(() => decodeReply('dev.project.scan', page)).not.toThrow()
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  test('a well-formed page decodes; a malformed one fails closed', () => {
    const page: ProjectScanPage = {
      rootBookmarkId: BOOKMARK_ID,
      items: [
        {
          name: 'app',
          relativeDir: 'apps/app',
          manifestPath: 'apps/app/package.json',
          packageManager: 'pnpm',
          languages: ['typescript'],
          suggestedScripts: ['build'],
          diagnostics: [],
        },
      ],
      partial: false,
      diagnostics: [],
      observedAt: new Date().toISOString(),
    }
    expect(() => decodeReply('dev.project.scan', page)).not.toThrow()
    expect(() =>
      decodeReply('dev.project.scan', {
        ...page,
        items: [{ ...page.items[0]!, surprise: true }],
      })
    ).toThrow()
    expect(() => decodeReply('dev.project.scan', { ...page, extra: true })).toThrow()
  })
})
