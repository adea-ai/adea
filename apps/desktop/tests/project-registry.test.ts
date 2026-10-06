import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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

async function expectReject(run: Promise<unknown> | (() => Promise<unknown>), code: string) {
  try {
    await (typeof run === 'function' ? run() : run)
  } catch (error) {
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
  options?: {
    resolveImportRoot?: (id: string) => { canonicalRoot: string }
    authorizeRoot?: (absolutePath: string, label: string) => { id: string }
    runClone?: (args: { argv: readonly string[]; cwd: string }) => Promise<{ exitCode: number }>
  }
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
    ...(options?.authorizeRoot ? { authorizeRoot: options.authorizeRoot } : {}),
    ...(options?.runClone ? { runClone: options.runClone } : {}),
  })
}

const BOOKMARK_ID = '00000000-0000-4000-8000-0000000000b0'

describe('project registry providers (#398)', () => {
  test('dev.project.import binds the authorized root to the cloud project id and refuses duplicates', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-registry-'))
    try {
      const runtime = bootRegistry(dataDir)
      const importProject = provider(runtime, 'dev.project.import')
      const projectId = randomUUID()
      const imported = importProject(
        command('dev.project.import', { projectId, rootBookmarkId: BOOKMARK_ID })
      ) as Project
      expect(imported.id).toBe(projectId)
      expect(imported.lifecycle).toBe('ready')
      expect(imported.repos).toEqual([
        {
          repoId: imported.repoIds[0],
          rootBookmarkId: BOOKMARK_ID,
          canonicalRoot: '/srv/authorized-root',
        },
      ])

      // A second import for the same authorized root is an identity collision.
      expectCode(
        () =>
          importProject(
            command('dev.project.import', { projectId: randomUUID(), rootBookmarkId: BOOKMARK_ID })
          ),
        'identity_mismatch'
      )
      // A refused root (revoked/drifted) throws before any record changes.
      expectCode(
        () =>
          importProject(
            command('dev.project.import', {
              projectId: randomUUID(),
              rootBookmarkId: randomUUID(),
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
              { projectId: randomUUID(), rootBookmarkId: BOOKMARK_ID },
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
      )(command('dev.project.get', { projectId })) as Project
      expect(persisted.repos?.[0]!.canonicalRoot).toBe('/srv/authorized-root')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('dev.project.create binds a cloud project id and persists across restart', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-registry-'))
    try {
      const runtime = bootRegistry(dataDir)
      const createProject = provider(runtime, 'dev.project.create')
      const projectId = randomUUID()
      const created = createProject(
        command('dev.project.create', { projectId, repoIds: [randomUUID()] })
      ) as Project
      expect(created.id).toBe(projectId)
      expect(created.lifecycle).toBe('ready')
      expect(() => decodeReply('dev.project.create', created)).not.toThrow()
      expectCode(
        () => createProject(command('dev.project.create', { projectId, repoIds: [] })),
        'identity_mismatch'
      )

      const restarted = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} },
        dataDir,
        scope,
      })
      const persisted = provider(
        restarted,
        'dev.project.get'
      )(command('dev.project.get', { projectId })) as Project
      expect(persisted).toEqual(created)
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
describe('dev.project.clone — the clone-URL import kind (#666)', () => {
  /** A real file:// git remote at `<base>/owner/repo`, matching the
   *  reconstructed URL shape `file://<base>/owner/repo`. */
  function fixtureRemote(): string {
    const base = mkdtempSync(join(tmpdir(), 'adea-clone-origin-'))
    const repoDir = join(base, 'owner', 'repo')
    mkdirSync(repoDir, { recursive: true })
    const run = (args: string[]) =>
      Bun.spawnSync(['git', ...args], {
        cwd: repoDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    run(['init', '-q', '--initial-branch=main'])
    writeFileSync(join(repoDir, 'README.md'), '# clone fixture\n')
    run(['add', '.'])
    run(['-c', 'user.email=t@adea.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'seed'])
    return base
  }

  test('a clone lands inside the authorized destination, mints its bookmark, and imports atomically', async () => {
    const origin = fixtureRemote()
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-registry-clone-'))
    const destinationRoot = mkdtempSync(join(tmpdir(), 'adea-clone-dest-'))
    try {
      const mintedBookmarks: string[] = []
      const runtime = bootRegistry(dataDir, {
        resolveImportRoot: (id) => {
          if (id !== BOOKMARK_ID) throw new DevAuthorityError('unauthorized_root', 'revoked')
          return { canonicalRoot: destinationRoot }
        },
        authorizeRoot: (absolutePath, label) => {
          expect(absolutePath.startsWith(destinationRoot)).toBe(true)
          // The register stores no names: the bookmark is labelled with the
          // repository name.
          expect(label).toBe('repo')
          const id = randomUUID()
          mintedBookmarks.push(id)
          return { id }
        },
      })
      const clone = provider(runtime, 'dev.project.clone')
      const projectId = randomUUID()
      const project = (await clone(
        command('dev.project.clone', {
          projectId,
          remote: {
            provider: 'other',
            host: `file://${origin}`,
            ownerPath: 'owner',
            repository: 'repo',
          },
          destinationBookmarkId: BOOKMARK_ID,
        })
      )) as Project
      // The clone binds the client-supplied cloud project id.
      expect(project.id).toBe(projectId)
      expect(project.lifecycle).toBe('ready')
      expect(project.repos?.[0]?.rootBookmarkId).toBe(mintedBookmarks[0])
      expect(project.repos?.[0]?.canonicalRoot).toBe(join(destinationRoot, 'clones', 'repo'))
      // The clone is a real working copy: git heads the file:// fixture commit.
      const head = Bun.spawnSync(
        [
          'git',
          '-C',
          join(destinationRoot, 'clones', 'repo'),
          'rev-parse',
          '--is-inside-work-tree',
        ],
        { stdout: 'pipe' }
      )
      expect(head.stdout.toString().trim()).toBe('true')
      expect(mintedBookmarks).toHaveLength(1)

      // The binding landed in the same atomic snapshot write.
      const listed = provider(runtime, 'dev.project.list')(command('dev.project.list', {})) as {
        items: Project[]
      }
      expect(listed.items.map((entry) => entry.id)).toEqual([projectId])

      // Binding the same cloud project again refuses before any clone runs.
      await expectReject(
        clone(
          command('dev.project.clone', {
            projectId,
            remote: {
              provider: 'other',
              host: `file://${origin}`,
              ownerPath: 'owner',
              repository: 'other-repo',
            },
            destinationBookmarkId: BOOKMARK_ID,
          })
        ),
        'identity_mismatch'
      )

      // A second clone into the same destination is a destination collision,
      // not a silent overwrite.
      await expectReject(
        clone(
          command('dev.project.clone', {
            projectId: randomUUID(),
            remote: {
              provider: 'other',
              host: `file://${origin}`,
              ownerPath: 'owner',
              repository: 'repo',
            },
            destinationBookmarkId: BOOKMARK_ID,
          })
        ),
        'invalid_state'
      )
    } finally {
      rmSync(origin, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(destinationRoot, { recursive: true, force: true })
    }
  })

  test('an unknown destination bookmark refuses before any clone runs', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-registry-clone2-'))
    try {
      let clones = 0
      const runtime = bootRegistry(dataDir, {
        resolveImportRoot: () => {
          throw new DevAuthorityError('unauthorized_root', 'destination bookmark revoked')
        },
        runClone: async () => {
          clones += 1
          return { exitCode: 0 }
        },
      })
      await expectReject(
        provider(
          runtime,
          'dev.project.clone'
        )(
          command('dev.project.clone', {
            projectId: randomUUID(),
            remote: {
              provider: 'github',
              host: 'github.com',
              ownerPath: 'adea-ai',
              repository: 'adea',
            },
            destinationBookmarkId: BOOKMARK_ID,
          })
        ),
        'unauthorized_root'
      )
      expect(clones).toBe(0)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a failed clone child refuses typed and leaves no destination directory claim', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-registry-clone3-'))
    const destinationRoot = mkdtempSync(join(tmpdir(), 'adea-clone-dest3-'))
    try {
      const runtime = bootRegistry(dataDir, {
        resolveImportRoot: (id) =>
          id === BOOKMARK_ID
            ? { canonicalRoot: destinationRoot }
            : (() => {
                throw new DevAuthorityError('unauthorized_root', 'revoked')
              })(),
        runClone: async () => ({ exitCode: 128 }),
      })
      await expectReject(
        provider(
          runtime,
          'dev.project.clone'
        )(
          command('dev.project.clone', {
            projectId: randomUUID(),
            remote: {
              provider: 'github',
              host: 'github.com',
              ownerPath: 'adea-ai',
              repository: 'missing',
            },
            destinationBookmarkId: BOOKMARK_ID,
          })
        ),
        'spawn_failed'
      )
      // No project, no bookmark mint, no clone directory.
      const projects = provider(runtime, 'dev.project.list')(command('dev.project.list', {})) as {
        items: Project[]
      }
      expect(projects.items).toEqual([])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(destinationRoot, { recursive: true, force: true })
    }
  })

  test('credential-backed remotes refuse typed until the vault wiring ships', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-registry-clone4-'))
    try {
      const runtime = bootRegistry(dataDir)
      await expectReject(
        provider(
          runtime,
          'dev.project.clone'
        )(
          command('dev.project.clone', {
            projectId: randomUUID(),
            remote: {
              provider: 'github',
              host: 'github.com',
              ownerPath: 'adea-ai',
              repository: 'private',
            },
            credentialRefId: randomUUID(),
            destinationBookmarkId: BOOKMARK_ID,
          })
        ),
        'unavailable'
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
