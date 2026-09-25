// #399 files/search provider acceptance over the real M10 gate: a production
// channel authority, a disposable worktree root, and commands that ride the
// full handshake → proof → dispatch path. Path containment, symlink/special
// refusal, CAS writes, and budget search behavior fail closed here.
import { createHmac, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  devCommandProofMessage,
  devOperationDefinitions,
  devOperationDecoders,
  type DevCommand,
  type DevOperation,
  type FileIdentity,
  type Scope,
} from '../../../packages/types/src/dev-runtime'

import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import { registerFilesRuntime } from '../shell/src/dev-runtime/files/register'
import { directoryIdentity } from '../shell/src/dev-runtime/worktrees/identity'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const WORKTREE_ID = 'wt-files-fixture-0001'
let generation = 7
let roots: { root: string; identity: ReturnType<typeof directoryIdentity> } | undefined
const scratch: string[] = []

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'adea-files-'))
  scratch.push(base)
  const root = join(base, 'worktree')
  mkdirSync(root)
  roots = { root, identity: directoryIdentity(root) }
})

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

function fixtureRoot(): string {
  if (!roots) throw new Error('fixture missing')
  return roots.root
}

function rootIdentityPinned(): FileIdentity {
  if (!roots) throw new Error('fixture missing')
  return { ...roots.identity.identity }
}

type CapturedStreamProvider = (session: {
  grant: import('../../../packages/types/src/dev-runtime').DevStreamGrant
  send: (frame: unknown) => void
  close: (code: string, reason?: string) => void
  onFrame?: (frame: unknown) => void
  onClose?: () => void
}) => void

function runtime(
  options: {
    lifecycle?: string
    resolve?: (id: string) => boolean
    protectedRoots?: readonly string[]
    openPath?: (
      absolutePath: string,
      target?: Readonly<{ applicationId?: string; column?: number; line?: number }>
    ) => Promise<
      string | { label?: string; position?: { line: number; column: number } } | undefined
    >
    openApplications?: () => readonly Readonly<{ id: string; label: string }>[]
  } = {}
) {
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1',
    shellOrigin: 'https://127.0.0.1:4789',
  })
  const registered = registerFilesRuntime({
    authority,
    scope,
    ...(options.protectedRoots ? { protectedRoots: options.protectedRoots } : {}),
    ...(options.openPath ? { openPath: options.openPath } : {}),
    ...(options.openApplications ? { openApplications: options.openApplications } : {}),
    resolveWorktree: (worktreeId) => {
      if (options.resolve && !options.resolve(worktreeId)) return undefined
      if (!roots) return undefined
      return {
        canonicalRoot: roots.root,
        rootIdentity: { ...roots.identity.identity },
        generation,
        lifecycle: options.lifecycle ?? 'ready',
      }
    },
    rgPath: () => 'rg',
  })
  return { authority, registered }
}

/** A registrar wired to a capturing gateway: stream providers register on it,
 *  and `handleAttach` drives the captured provider with a scripted session. */
function runtimeWithGateway(
  options: { lifecycle?: string; resolve?: (id: string) => boolean } = {}
) {
  const providers = new Map<string, CapturedStreamProvider>()
  const gateway = {
    registerStreamHandler: (protocol: string, provider: CapturedStreamProvider) => {
      providers.set(protocol, provider)
    },
  }
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1',
    shellOrigin: 'https://127.0.0.1:4789',
  })
  const registered = registerFilesRuntime({
    authority,
    scope,
    gateway,
    resolveWorktree: (worktreeId) => {
      if (options.resolve && !options.resolve(worktreeId)) return undefined
      if (!roots) return undefined
      return {
        canonicalRoot: roots.root,
        rootIdentity: { ...roots.identity.identity },
        generation,
        lifecycle: options.lifecycle ?? 'ready',
      }
    },
    rgPath: () => 'rg',
  })
  return {
    authority,
    registered,
    streamProtocols: [...providers.keys()],
    provider: (protocol: string) => providers.get(protocol),
  }
}

function handshakeChannel(authority: ReturnType<typeof createChannelAuthority>) {
  const bootstrap = authority.issueLaunchBootstrap()
  const at = Date.now()
  const handshake = authority.handshake(
    {
      schemaVersion: 1,
      method: 'dev.runtime.handshake.v1',
      requestId: '00000000-0000-4000-8000-000000000010',
      bootstrap,
      supportedProtocolVersions: ['1'],
      nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
      issuedAt: new Date(at - 1000).toISOString(),
      expiresAt: new Date(at + 30_000).toISOString(),
    },
    { trusted: true }
  )
  if (!handshake.ok) throw new Error('handshake refused')
  const secret = Buffer.from(handshake.clientSecret, 'base64url')
  return {
    identity: {
      channelId: handshake.channelId,
      clientCredentialId: handshake.clientCredentialId,
    },
    secret,
  }
}

function makeCommand(
  operation: DevOperation,
  body: Record<string, unknown>,
  resource?: { kind: string; id: string; generation: number }
): DevCommand {
  const definition = devOperationDefinitions[operation]
  const capabilities = [...definition.capabilities].toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  )
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-000000000011',
    // Fresh nonce per command: the gate rejects replayed nonces.
    nonce: Buffer.from(randomBytes(16)).toString('base64url'),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    scope,
    capabilities,
    ...(resource ? { resource } : {}),
    body,
  }
}

async function execute(
  channel: ReturnType<typeof handshakeChannel>,
  authority: ReturnType<typeof createChannelAuthority>,
  command: DevCommand
) {
  const proof = createHmac('sha256', channel.secret)
    .update(
      devCommandProofMessage({
        channelId: channel.identity.channelId,
        clientCredentialId: channel.identity.clientCredentialId,
        command,
      }),
      'utf8'
    )
    .digest('base64url')
  return authority.execute(
    {
      channelId: channel.identity.channelId,
      clientCredentialId: channel.identity.clientCredentialId,
      command,
      proof,
    },
    { trusted: true }
  )
}

function wsPath(relativePath: string): Record<string, unknown> {
  return {
    worktreeId: WORKTREE_ID,
    rootIdentity: rootIdentityPinned(),
    relativePath,
  }
}

/** Pins one file's identity the way every other case in this suite does. */
async function identityOf(
  channel: ReturnType<typeof handshakeChannel>,
  authority: ReturnType<typeof createChannelAuthority>,
  relativePath: string
): Promise<FileIdentity> {
  const stat = await execute(
    channel,
    authority,
    makeCommand(
      'dev.files.stat',
      { worktreeId: WORKTREE_ID, path: wsPath(relativePath) },
      filesResource()
    )
  )
  if (!stat.ok) throw new Error(`stat failed for ${relativePath}`)
  return stat.value.identity as FileIdentity
}

function filesResource(expected = generation) {
  return { kind: 'workspace_root', id: WORKTREE_ID, generation: expected }
}

describe('files/search provider', () => {
  test('registers exactly the dev.files control and plan operations', () => {
    const { registered } = runtime()
    // Without a full-duplex gateway the bulk-stream halves stay unregistered
    // (composition reports them typed-unavailable).
    expect(registered.commands.toSorted()).toEqual(
      [
        'dev.files.copy',
        'dev.files.copyTreeCommit',
        'dev.files.copyTreePlan',
        'dev.files.create',
        'dev.files.delete',
        'dev.files.deleteTreeCommit',
        'dev.files.deleteTreePlan',
        'dev.files.list',
        'dev.files.openExternal',
        'dev.files.read',
        'dev.files.rename',
        'dev.files.renameOverwriteCommit',
        'dev.files.renameOverwritePlan',
        'dev.files.search',
        'dev.files.stat',
        'dev.files.write',
      ].toSorted()
    )
    expect(registered.registeredCommands).toBe(16)

    const gateway = runtimeWithGateway()
    expect(gateway.registered.commands).toContain('dev.files.readStream')
    expect(gateway.registered.commands).toContain('dev.files.writeStream')
    expect(gateway.registered.registeredCommands).toBe(18)
    expect(gateway.streamProtocols).toEqual(['file-bytes-v1'])
  })

  test('stat and list report identity, kind, and paged entries through the gate', async () => {
    mkdirSync(join(fixtureRoot(), 'tree'))
    writeFileSync(join(fixtureRoot(), 'tree', 'alpha.txt'), 'hello\n')
    mkdirSync(join(fixtureRoot(), 'tree', 'sub'))
    writeFileSync(join(fixtureRoot(), 'tree', 'sub', 'beta.txt'), 'b')
    const { authority } = runtime()
    const channel = handshakeChannel(authority)

    const stat = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.stat',
        { worktreeId: WORKTREE_ID, path: wsPath('tree/alpha.txt') },
        filesResource()
      )
    )
    expect(stat.ok).toBe(true)
    if (stat.ok) {
      expect(stat.value.kind).toBe('file')
      expect(stat.value.size).toBe('6')
      expect(stat.value.path.relativePath).toBe('tree/alpha.txt')
      // The provider output satisfies the installed reply decoder.
      devOperationDecoders['dev.files.stat'].reply({
        schemaVersion: 1,
        operation: 'dev.files.stat',
        requestId: stat.requestId,
        ok: true,
        value: stat.value,
        observedAt: stat.observedAt,
      })
    }

    const list = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.list',
        { worktreeId: WORKTREE_ID, path: wsPath('tree'), limit: 1 },
        filesResource()
      )
    )
    expect(list.ok).toBe(true)
    if (list.ok) {
      expect(list.value.items.length).toBe(1)
      expect(list.value.items[0]?.path.relativePath).toBe('tree/alpha.txt')
      expect(typeof list.value.nextCursor).toBe('string')
    }
    const rest = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.list',
        {
          worktreeId: WORKTREE_ID,
          path: wsPath('tree'),
          limit: 50,
          cursor: list.ok ? list.value.nextCursor : undefined,
        },
        filesResource()
      )
    )
    expect(rest.ok).toBe(true)
    if (rest.ok) {
      expect(rest.value.items.length).toBe(1)
      expect(rest.value.items[0]?.path.relativePath).toBe('tree/sub')
      expect(rest.value.items[0]?.kind).toBe('directory')
    }
  })

  test('read preserves BOM and reports eol/encoding; windows bound the read', async () => {
    writeFileSync(join(fixtureRoot(), 'tree/crlf.txt'), Buffer.from('﻿a\r\nb\r\n', 'utf8'))
    const { authority } = runtime()
    const channel = handshakeChannel(authority)
    const read = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.read',
        { worktreeId: WORKTREE_ID, path: wsPath('tree/crlf.txt') },
        filesResource()
      )
    )
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.value.encoding).toBe('utf8')
      expect(read.value.eol).toBe('crlf')
      expect(read.value.eof).toBe(true)
      const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(read.value.bytes)
      expect(text.charCodeAt(0)).toBe(0xfeff)
    }
    const windowed = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.read',
        { worktreeId: WORKTREE_ID, path: wsPath('tree/crlf.txt'), offset: '1', length: 2 },
        filesResource()
      )
    )
    expect(windowed.ok).toBe(true)
    if (windowed.ok) expect(windowed.value.bytes.length).toBe(2)
  })

  test('write is a compare-and-swap: stale identity refuses with file_changed and no overwrite', async () => {
    const file = join(fixtureRoot(), 'cas.txt')
    writeFileSync(file, 'v1')
    const { authority } = runtime()
    const channel = handshakeChannel(authority)
    const before = { ...rootIdentityPinned() }
    void before
    // Pin identity from a stat.
    const stat = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.stat',
        { worktreeId: WORKTREE_ID, path: wsPath('cas.txt') },
        filesResource()
      )
    )
    if (!stat.ok) throw new Error('stat failed')
    const identity = stat.ok ? stat.value.identity : undefined
    expect(identity).toBeDefined()

    const write = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.write',
        {
          worktreeId: WORKTREE_ID,
          path: wsPath('cas.txt'),
          expectedIdentity: identity,
          content: new TextEncoder().encode('v2\n'),
          eolPolicy: 'preserve',
        },
        filesResource()
      )
    )
    expect(write.ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('v2\n')

    // Replay the OLD identity: refused, content untouched.
    const stale = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.write',
        {
          worktreeId: WORKTREE_ID,
          path: wsPath('cas.txt'),
          expectedIdentity: identity,
          content: new TextEncoder().encode('clobber\n'),
          eolPolicy: 'preserve',
        },
        filesResource()
      )
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error.code).toBe('file_changed')
    expect(readFileSync(file, 'utf8')).toBe('v2\n')
  })

  test('write applies an explicit EOL policy and refuses binary content', async () => {
    const file = join(fixtureRoot(), 'eol.txt')
    writeFileSync(file, 'a\nb\n')
    const { authority } = runtime()
    const channel = handshakeChannel(authority)
    const stat = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.stat',
        { worktreeId: WORKTREE_ID, path: wsPath('eol.txt') },
        filesResource()
      )
    )
    if (!stat.ok) throw new Error('stat failed')
    const identity = stat.value.identity
    const write = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.write',
        {
          worktreeId: WORKTREE_ID,
          path: wsPath('eol.txt'),
          expectedIdentity: identity,
          content: new TextEncoder().encode('a\nb\n'),
          eolPolicy: 'crlf',
        },
        filesResource()
      )
    )
    expect(write.ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('a\r\nb\r\n')

    const binary = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.write',
        {
          worktreeId: WORKTREE_ID,
          path: wsPath('eol.txt'),
          expectedIdentity: write.ok ? write.value.entry.identity : identity,
          content: new Uint8Array([0x61, 0x00, 0x62]),
          eolPolicy: 'preserve',
        },
        filesResource()
      )
    )
    expect(binary.ok).toBe(false)
    if (!binary.ok) expect(binary.error.code).toBe('invalid_state')
  })

  test('symlink components and special files are refused; containment never escapes', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'adea-outside-'))
    scratch.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'outside')
    symlinkSync(outside, join(fixtureRoot(), 'escape-dir'))
    symlinkSync(join(outside, 'secret.txt'), join(fixtureRoot(), 'escape-file'))
    // macOS and Linux coreutils expose mkfifo(1); a FIFO proves special files
    // never open. A missing binary (restricted PATH) must degrade the probe,
    // not fail the suite: absence and spawn failure both skip the FIFO branch.
    const fifoPath = join(fixtureRoot(), 'fifo')
    let fifoIsSpecial = false
    try {
      const mkfifo = Bun.spawnSync(['mkfifo', fifoPath], { stdout: 'ignore', stderr: 'ignore' })
      fifoIsSpecial = mkfifo.exitCode === 0
    } catch {
      fifoIsSpecial = false
    }
    const { authority } = runtime()
    const channel = handshakeChannel(authority)

    const throughDir = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.stat',
        { worktreeId: WORKTREE_ID, path: wsPath('escape-dir/secret.txt') },
        filesResource()
      )
    )
    expect(throughDir.ok).toBe(false)
    if (!throughDir.ok) expect(throughDir.error.code).toBe('symlink_rejected')

    const finalSymlink = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.read',
        { worktreeId: WORKTREE_ID, path: wsPath('escape-file') },
        filesResource()
      )
    )
    expect(finalSymlink.ok).toBe(false)
    if (!finalSymlink.ok) expect(finalSymlink.error.code).toBe('symlink_rejected')

    if (fifoIsSpecial) {
      const fifo = await execute(
        channel,
        authority,
        makeCommand(
          'dev.files.read',
          { worktreeId: WORKTREE_ID, path: wsPath('fifo') },
          filesResource()
        )
      )
      expect(fifo.ok).toBe(false)
      if (!fifo.ok) expect(fifo.error.code).toBe('special_file_rejected')
    }

    // Traversal is rejected on the wire by the shared WorkspacePath decoder
    // before the provider resolves anything.
    const traversal = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.read',
        { worktreeId: WORKTREE_ID, path: wsPath('sub/../../etc/passwd') },
        filesResource()
      )
    )
    expect(traversal.ok).toBe(false)
  })

  test('create/rename/delete are fail-if-exists and CAS-guarded', async () => {
    const { authority } = runtime()
    const channel = handshakeChannel(authority)

    const created = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.create',
        {
          worktreeId: WORKTREE_ID,
          path: wsPath('created.txt'),
          kind: 'file',
          content: new TextEncoder().encode('new\n'),
          failIfExists: true,
        },
        filesResource()
      )
    )
    expect(created.ok).toBe(true)
    const collision = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.create',
        {
          worktreeId: WORKTREE_ID,
          path: wsPath('created.txt'),
          kind: 'file',
          content: new TextEncoder().encode('x'),
          failIfExists: true,
        },
        filesResource()
      )
    )
    expect(collision.ok).toBe(false)
    if (!collision.ok) expect(collision.error.code).toBe('path_collision')

    const rename = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.rename',
        {
          worktreeId: WORKTREE_ID,
          from: wsPath('created.txt'),
          to: wsPath('renamed.txt'),
          expectedIdentity: created.ok ? created.value.identity : undefined,
          failIfExists: true,
        },
        filesResource()
      )
    )
    expect(rename.ok).toBe(true)
    expect(existsSync(join(fixtureRoot(), 'created.txt'))).toBe(false)
    expect(existsSync(join(fixtureRoot(), 'renamed.txt'))).toBe(true)

    const stat = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.stat',
        { worktreeId: WORKTREE_ID, path: wsPath('renamed.txt') },
        filesResource()
      )
    )
    if (!stat.ok) throw new Error('stat failed')
    const wrongIdentity = {
      ...stat.value.identity,
      size: String(Number(stat.value.identity.size) + 5),
    }
    const deleteStale = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.delete',
        {
          worktreeId: WORKTREE_ID,
          path: wsPath('renamed.txt'),
          expectedIdentity: wrongIdentity,
          confirmationId: 'c1',
        },
        filesResource()
      )
    )
    expect(deleteStale.ok).toBe(false)
    if (!deleteStale.ok) expect(deleteStale.error.code).toBe('file_changed')
    expect(existsSync(join(fixtureRoot(), 'renamed.txt'))).toBe(true)

    const deleted = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.delete',
        {
          worktreeId: WORKTREE_ID,
          path: wsPath('renamed.txt'),
          expectedIdentity: stat.value.identity,
          confirmationId: 'c2',
        },
        filesResource()
      )
    )
    expect(deleted.ok).toBe(true)
    if (deleted.ok) expect(deleted.value.state).toBe('deleted')
    expect(existsSync(join(fixtureRoot(), 'renamed.txt'))).toBe(false)
  })

  test('search streams matches when rg exists and degrades typed when it does not', async () => {
    writeFileSync(join(fixtureRoot(), 'searchable.txt'), 'needle one\nplain\nneedle two\n')
    const { authority } = runtime()
    const channel = handshakeChannel(authority)
    // A missing rg binary makes spawnSync throw on some runners; absence and
    // spawn-failure are the same "degrades typed" condition.
    let rgPresent = false
    try {
      rgPresent =
        Bun.spawnSync(['rg', '--version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
    } catch {
      rgPresent = false
    }
    const search = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.search',
        { worktreeId: WORKTREE_ID, query: 'needle', limit: 100 },
        filesResource()
      )
    )
    if (rgPresent) {
      expect(search.ok).toBe(true)
      if (search.ok) {
        expect(search.value.items.length).toBe(2)
        const first = search.value.items[0]
        expect(first.path.relativePath).toBe('searchable.txt')
        expect(first.line).toBe(1)
        expect(first.preview).toContain('needle')
        expect(first.ranges.length).toBeGreaterThan(0)
        expect(first.path.rootIdentity.device).toBe(rootIdentityPinned().device)

        const firstPage = await execute(
          channel,
          authority,
          makeCommand(
            'dev.files.search',
            { worktreeId: WORKTREE_ID, query: 'needle', limit: 1 },
            filesResource()
          )
        )
        expect(firstPage.ok).toBe(true)
        if (!firstPage.ok) return
        expect(firstPage.value.items).toHaveLength(1)
        expect(typeof firstPage.value.nextCursor).toBe('string')
        const secondPage = await execute(
          channel,
          authority,
          makeCommand(
            'dev.files.search',
            {
              worktreeId: WORKTREE_ID,
              query: 'needle',
              limit: 1,
              cursor: firstPage.value.nextCursor,
            },
            filesResource()
          )
        )
        expect(secondPage.ok).toBe(true)
        if (secondPage.ok) expect(secondPage.value.items).toHaveLength(1)
      }
    } else {
      expect(search.ok).toBe(false)
      if (!search.ok) expect(search.error.code).toBe('capability_unavailable')
    }

    const missing = createChannelAuthority({
      shellHost: '127.0.0.1',
      shellOrigin: 'https://127.0.0.1:4789',
    })
    registerFilesRuntime({
      authority: missing,
      scope,
      resolveWorktree: () =>
        roots
          ? {
              canonicalRoot: roots.root,
              rootIdentity: { ...roots.identity.identity },
              generation,
              lifecycle: 'ready',
            }
          : undefined,
      rgPath: () => join(outsideBin(), 'definitely-not-rg'),
    })
    const missingChannel = handshakeChannel(missing)
    const degraded = await execute(
      missingChannel,
      missing,
      makeCommand('dev.files.search', { worktreeId: WORKTREE_ID, query: 'needle' }, filesResource())
    )
    expect(degraded.ok).toBe(false)
    if (!degraded.ok) expect(degraded.error.code).toBe('capability_unavailable')
  })

  test('stale generation, wrong resource kind, foreign scope, and missing context fail closed', async () => {
    const { authority } = runtime()
    const channel = handshakeChannel(authority)

    const stale = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.stat',
        { worktreeId: WORKTREE_ID, path: wsPath('alpha.txt') },
        filesResource(generation + 1)
      )
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error.code).toBe('stale_generation')

    const wrongKind = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.stat',
        { worktreeId: WORKTREE_ID, path: wsPath('alpha.txt') },
        { kind: 'worktree', id: WORKTREE_ID, generation }
      )
    )
    // The gate rejects the registry-kind mismatch before the provider runs.
    expect(wrongKind.ok).toBe(false)
    if (!wrongKind.ok) expect(wrongKind.error.code).toBe('invalid_state')

    const foreignScope: Scope = {
      ...scope,
      workspaceId: '00000000-0000-4000-8000-000000000099',
    }
    const command = makeCommand(
      'dev.files.stat',
      { worktreeId: WORKTREE_ID, path: wsPath('tree/alpha.txt') },
      filesResource()
    )
    const foreign = { ...command, scope: foreignScope }
    const foreignReply = await execute(channel, authority, foreign)
    expect(foreignReply.ok).toBe(false)
    if (!foreignReply.ok) expect(foreignReply.error.code).toBe('unauthorized')

    const noContext = runtime({ resolve: () => false })
    const noContextChannel = handshakeChannel(noContext.authority)
    const missing = await execute(
      noContextChannel,
      noContext.authority,
      makeCommand(
        'dev.files.stat',
        { worktreeId: 'wt-other', path: wsPath('tree/alpha.txt') },
        { kind: 'workspace_root', id: 'wt-other', generation }
      )
    )
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('not_found')

    const notReady = runtime({ lifecycle: 'quarantined' })
    const notReadyChannel = handshakeChannel(notReady.authority)
    const quarantined = await execute(
      notReadyChannel,
      notReady.authority,
      makeCommand(
        'dev.files.stat',
        { worktreeId: WORKTREE_ID, path: wsPath('tree/alpha.txt') },
        filesResource()
      )
    )
    expect(quarantined.ok).toBe(false)
    if (!quarantined.ok) expect(quarantined.error.code).toBe('invalid_state')

    // Cross-worktree path substitution: a path pinned to another root.
    const other = mkdtempSync(join(tmpdir(), 'adea-other-'))
    scratch.push(other)
    const otherIdentity = directoryIdentity(other)
    const cross = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.stat',
        {
          worktreeId: WORKTREE_ID,
          path: {
            worktreeId: WORKTREE_ID,
            rootIdentity: { ...otherIdentity.identity },
            relativePath: 'alpha.txt',
          },
        },
        filesResource()
      )
    )
    expect(cross.ok).toBe(false)
    if (!cross.ok) expect(cross.error.code).toBe('unauthorized_root')
  })
})

function outsideBin(): string {
  return tmpdir()
}

// #622: containment proves a path is INSIDE an approved root; the default-deny
// policy decides whether the path is one a grant should expose at all. These
// cases pin the sensitivity half on the real dispatch path.
describe('default-deny policy (#622)', () => {
  test('a credential-store path inside the root refuses with path_denied (read and write)', async () => {
    const sshDir = join(fixtureRoot(), '.ssh')
    mkdirSync(sshDir, { recursive: true })
    writeFileSync(join(sshDir, 'id_rsa'), 'PRIVATE KEY BYTES')
    const { authority } = runtime()
    const channel = handshakeChannel(authority)

    const read = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.read',
        { worktreeId: WORKTREE_ID, path: wsPath('.ssh/id_rsa') },
        filesResource()
      )
    )
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.error.code).toBe('path_denied')

    const write = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.write',
        {
          worktreeId: WORKTREE_ID,
          path: wsPath('.ssh/injected'),
          expectedIdentity: { mtimeNs: '0', size: '0' },
          content: new TextEncoder().encode('x'),
          eolPolicy: 'preserve',
        },
        filesResource()
      )
    )
    expect(write.ok).toBe(false)
    if (!write.ok) expect(write.error.code).toBe('path_denied')
    expect(existsSync(join(sshDir, 'injected'))).toBe(false)
  })

  test('key material is denied by name even before it exists, and a symlink cannot route around the rule', async () => {
    const { authority } = runtime()
    const channel = handshakeChannel(authority)

    // Create-as-write of a private key name: denied by NAME (the file may not
    // exist yet), so the policy checks the target as well as its resolution.
    // The parent must exist for resolution to reach the policy at all: a missing
    // parent fails earlier as not_found, which is also fail-closed but exercises
    // a different rule.
    mkdirSync(join(fixtureRoot(), 'certs'), { recursive: true })
    const create = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.write',
        {
          worktreeId: WORKTREE_ID,
          path: wsPath('certs/new-issuer.key'),
          expectedIdentity: { mtimeNs: '0', size: '0' },
          content: new TextEncoder().encode('x'),
          eolPolicy: 'preserve',
        },
        filesResource()
      )
    )
    expect(create.ok).toBe(false)
    if (!create.ok) expect(create.error.code).toBe('path_denied')

    // A symlink pointing at the credential store resolves into it, and the
    // resolved path is what the policy evaluates.
    mkdirSync(join(fixtureRoot(), 'aws-store'), { recursive: true })
    writeFileSync(join(fixtureRoot(), 'aws-store', '.aws-placeholder'), 'x')
    mkdirSync(join(fixtureRoot(), 'linked'), { recursive: true })
    symlinkSync(join(fixtureRoot(), 'aws-store'), join(fixtureRoot(), 'linked/aws'), 'dir')
    mkdirSync(join(fixtureRoot(), 'aws-store/.aws'), { recursive: true })
    writeFileSync(join(fixtureRoot(), 'aws-store/.aws/credentials'), 'aws creds')
    const viaSymlink = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.read',
        { worktreeId: WORKTREE_ID, path: wsPath('linked/aws/.aws/credentials') },
        filesResource()
      )
    )
    expect(viaSymlink.ok).toBe(false)
    if (!viaSymlink.ok) expect(['path_denied', 'symlink_rejected']).toContain(viaSymlink.error.code)
  })

  test('an Agent HQ authority root is never exposed, and ordinary project files are unaffected', async () => {
    const contentDir = join(fixtureRoot(), 'local-content')
    mkdirSync(contentDir, { recursive: true })
    writeFileSync(join(contentDir, 'agent-hq-content.sqlite'), 'ciphertext')
    const { authority } = runtime({ protectedRoots: [contentDir] })
    const channel = handshakeChannel(authority)

    const guarded = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.read',
        { worktreeId: WORKTREE_ID, path: wsPath('local-content/agent-hq-content.sqlite') },
        filesResource()
      )
    )
    expect(guarded.ok).toBe(false)
    if (!guarded.ok) expect(guarded.error.code).toBe('path_denied')

    // The policy must not over-block: a project's own dotfiles still read.
    writeFileSync(join(fixtureRoot(), '.env'), 'FEATURE_FLAG=1\n')
    writeFileSync(join(fixtureRoot(), 'cert.pem'), '-----BEGIN CERTIFICATE-----\n')
    const env = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.read',
        { worktreeId: WORKTREE_ID, path: wsPath('.env') },
        filesResource()
      )
    )
    expect(env.ok).toBe(true)
    const certificate = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.read',
        { worktreeId: WORKTREE_ID, path: wsPath('cert.pem') },
        filesResource()
      )
    )
    expect(certificate.ok).toBe(true)
  })

  test('an external application that is not installed is refused by name', async () => {
    writeFileSync(join(roots!.root, 'open-refusal.ts'), 'export {}\n')
    const { authority } = runtime({
      openApplications: () => [{ id: 'vscode', label: 'Visual Studio Code' }],
    })
    const channel = handshakeChannel(authority)

    const refused = await execute(
      channel,
      authority,
      makeCommand(
        'dev.files.openExternal',
        {
          applicationId: 'sublime',
          expectedIdentity: await identityOf(channel, authority, 'open-refusal.ts'),
          path: wsPath('open-refusal.ts'),
          worktreeId: WORKTREE_ID,
        },
        filesResource()
      )
    )

    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error.code).toBe('not_found')
    // The refusal names what is available instead of opening whatever the
    // platform happens to pick.
    expect(refused.error.message).toContain('vscode (Visual Studio Code)')
  })

  test('the handoff receives the position and the reply reports one only when it landed there', async () => {
    writeFileSync(join(roots!.root, 'open-target.ts'), 'export const value = 1\n')
    const seen: Array<
      Readonly<{ applicationId?: string; column?: number; line?: number }> | undefined
    > = []
    let appliedPosition: { line: number; column: number } | undefined = { column: 3, line: 12 }
    const { authority } = runtime({
      openApplications: () => [{ id: 'vscode', label: 'Visual Studio Code' }],
      openPath: async (_absolute, target) => {
        seen.push(target)
        return {
          label: 'Visual Studio Code',
          ...(appliedPosition !== undefined ? { position: appliedPosition } : {}),
        }
      },
    })
    const channel = handshakeChannel(authority)
    const command = async () =>
      makeCommand(
        'dev.files.openExternal',
        {
          applicationId: 'vscode',
          column: 3,
          expectedIdentity: await identityOf(channel, authority, 'open-target.ts'),
          line: 12,
          path: wsPath('open-target.ts'),
          worktreeId: WORKTREE_ID,
        },
        filesResource()
      )

    const opened = await execute(channel, authority, await command())
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    // The opener was handed the choice and the position, as data — never as
    // arguments assembled through a shell.
    expect(seen[0]).toEqual({ applicationId: 'vscode', column: 3, line: 12 })
    expect(opened.value).toMatchObject({
      applicationLabel: 'Visual Studio Code',
      position: { column: 3, line: 12 },
    })

    // An opener that cannot land at a position reports none, and the reply
    // stops claiming one: asking is not evidence.
    appliedPosition = undefined
    const plain = await execute(channel, authority, await command())
    expect(plain.ok).toBe(true)
    if (!plain.ok) return
    expect(plain.value.position).toBeUndefined()
    expect(plain.value.applicationLabel).toBe('Visual Studio Code')
  })
})
