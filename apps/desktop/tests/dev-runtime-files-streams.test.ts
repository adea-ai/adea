// #399 residue acceptance: the `file-bytes-v1` bulk stream (readStream/
// writeStream grants plus their attached byte halves) and the overwrite /
// recursive plan-commit flows, over the real M10 gate. Grants must be
// caller-bound and single-use, writes byte-exact and atomic, plans
// dry-run-enumerated with per-item identities, and every drift refused.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  statSync,
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
  type DevStreamFrame,
  type DevStreamGrant,
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

const WORKTREE_ID = 'wt-files-stream-001'
let generation = 3
let roots: { root: string; identity: ReturnType<typeof directoryIdentity> } | undefined
const scratch: string[] = []

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'adea-files-streams-'))
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

function wsPath(relativePath: string): Record<string, unknown> {
  return {
    worktreeId: WORKTREE_ID,
    rootIdentity: { ...roots!.identity.identity },
    relativePath,
  }
}

function filesResource(expected = generation) {
  return { kind: 'workspace_root', id: WORKTREE_ID, generation: expected }
}

type StreamSession = {
  grant: DevStreamGrant
  sent: DevStreamFrame[]
  closed?: { code: string; reason?: string }
  send: (frame: DevStreamFrame) => void
  close: (code: string, reason?: string) => void
  onFrame?: (frame: DevStreamFrame) => void
  onClose?: () => void
}

function harness() {
  const providers = new Map<string, (session: StreamSession) => void>()
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1',
    shellOrigin: 'https://127.0.0.1:4789',
  })
  registerFilesRuntime({
    authority,
    scope,
    gateway: {
      registerStreamHandler: (protocol, provider) => {
        providers.set(protocol, provider as (session: StreamSession) => void)
      },
    },
    resolveWorktree: (worktreeId) => {
      if (!roots || worktreeId !== WORKTREE_ID) return undefined
      return {
        canonicalRoot: roots.root,
        rootIdentity: { ...roots.identity.identity },
        generation,
        lifecycle: 'ready',
      }
    },
    rgPath: () => 'rg',
  })
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
  const channel = {
    identity: {
      channelId: handshake.channelId,
      clientCredentialId: handshake.clientCredentialId,
    },
    secret: Buffer.from(handshake.clientSecret, 'base64url'),
  }

  async function execute(command: DevCommand) {
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

  function makeCommand(operation: DevOperation, body: Record<string, unknown>): DevCommand {
    const definition = devOperationDefinitions[operation]
    return {
      schemaVersion: 1,
      operation,
      requestId: '00000000-0000-4000-8000-000000000011',
      nonce: Buffer.from(randomBytes(16)).toString('base64url'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      scope,
      capabilities: [...definition.capabilities].toSorted((left, right) =>
        left < right ? -1 : left > right ? 1 : 0
      ),
      resource: filesResource(),
      body,
    }
  }

  async function statIdentity(relativePath: string): Promise<FileIdentity> {
    const stat = await execute(
      makeCommand('dev.files.stat', { worktreeId: WORKTREE_ID, path: wsPath(relativePath) })
    )
    if (!stat.ok) throw new Error(`stat failed: ${JSON.stringify(stat.error)}`)
    return stat.value.identity
  }

  function attach(grant: DevStreamGrant): StreamSession {
    const provider = providers.get(grant.protocol)
    if (!provider) throw new Error(`no provider for ${grant.protocol}`)
    const session: StreamSession = {
      grant,
      sent: [],
      send: (frame) => session.sent.push(frame),
      close: (code, reason) => {
        session.closed = { code, ...(reason !== undefined ? { reason } : {}) }
      },
    }
    provider(session)
    return session
  }

  return { authority, execute, makeCommand, statIdentity, attach }
}

function expectGrantReply(
  reply: Awaited<ReturnType<ReturnType<typeof harness>['execute']>>,
  direction: 'read' | 'write'
): DevStreamGrant {
  expect(reply.ok).toBe(true)
  if (!reply.ok) throw new Error('grant refused')
  // The minted grant satisfies the installed reply decoder.
  devOperationDecoders['dev.files.readStream'].reply({
    schemaVersion: 1,
    operation: 'dev.files.readStream',
    requestId: reply.requestId,
    ok: true,
    value: reply.value,
    observedAt: reply.observedAt,
  })
  expect(reply.value.direction).toBe(direction)
  expect(reply.value.protocol).toBe('file-bytes-v1')
  expect(reply.value.resource.kind).toBe('workspace_root')
  expect(reply.value.resource.id).toBe(WORKTREE_ID)
  expect(reply.value.resource.generation).toBe(generation)
  return reply.value
}

async function planReply(
  reply: Awaited<ReturnType<ReturnType<typeof harness>['execute']>>,
  operation: DevOperation
) {
  expect(reply.ok).toBe(true)
  if (!reply.ok) throw new Error(`plan failed: ${JSON.stringify(reply.error)}`)
  devOperationDecoders[operation].reply({
    schemaVersion: 1,
    operation,
    requestId: reply.requestId,
    ok: true,
    value: reply.value,
    observedAt: reply.observedAt,
  })
  return reply.value
}

describe('file-bytes-v1 bulk stream', () => {
  test('readStream mints a caller-bound grant and the attached stream pumps exact bytes', async () => {
    const h = harness()
    const payload = Buffer.alloc(300 * 1024)
    for (let index = 0; index < payload.length; index += 4096)
      payload.write(`block-${index};`, index)
    writeFileSync(join(fixtureRoot(), 'bulk.bin'), payload)
    const identity = await h.statIdentity('bulk.bin')

    const reply = await h.execute(
      h.makeCommand('dev.files.readStream', {
        worktreeId: WORKTREE_ID,
        path: wsPath('bulk.bin'),
        expectedIdentity: identity,
        direction: 'read',
      })
    )
    const grant = expectGrantReply(reply, 'read')

    const session = h.attach(grant)
    expect(session.closed).toBeUndefined()
    const data = session.sent.filter(
      (frame): frame is Extract<DevStreamFrame, { type: 'data' }> => frame.type === 'data'
    )
    expect(data.length).toBeGreaterThan(1)
    const collected = Buffer.concat(data.map((frame) => Buffer.from(frame.bytes)))
    expect(collected.equals(payload)).toBe(true)
    // Sequence numbers are byte offsets.
    expect(data[0]?.sequence).toBe('0')
    expect(data[1]?.sequence).toBe(String(data[0]?.bytes.byteLength))
    // The client returns credit; with the whole file drained and acked, the
    // stream closes normally.
    session.onFrame?.({
      type: 'ack',
      throughSequence: data[data.length - 1]?.sequence ?? '0',
      availableCreditBytes: collected.byteLength,
    })
    expect(session.closed?.code).toBe('normal')
    expect(session.closed?.reason).toBe('bulk read complete')

    // Single use: re-attaching the same grant is refused.
    const replay = h.attach(grant)
    expect(replay.closed?.code).toBe('incompatible')
  })

  test('readStream honors offset windows and refuses stale identities', async () => {
    const h = harness()
    writeFileSync(join(fixtureRoot(), 'window.bin'), 'abcdefghij')
    const identity = await h.statIdentity('window.bin')

    const offsetReply = await h.execute(
      h.makeCommand('dev.files.readStream', {
        worktreeId: WORKTREE_ID,
        path: wsPath('window.bin'),
        expectedIdentity: identity,
        offset: '4',
        length: '3',
        direction: 'read',
      })
    )
    const grant = expectGrantReply(offsetReply, 'read')
    expect(grant.fromSequence).toBe('4')
    const session = h.attach(grant)
    const data = session.sent.filter((frame) => frame.type === 'data')
    expect(
      Buffer.concat(
        data.map((frame) => Buffer.from((frame as { bytes: Uint8Array }).bytes))
      ).toString()
    ).toBe('efg')
    session.onFrame?.({ type: 'ack', throughSequence: '6', availableCreditBytes: 3 })
    expect(session.closed?.code).toBe('normal')

    const stale = await h.execute(
      h.makeCommand('dev.files.readStream', {
        worktreeId: WORKTREE_ID,
        path: wsPath('window.bin'),
        expectedIdentity: { ...identity, size: String(Number(identity.size) + 1) },
        direction: 'read',
      })
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error.code).toBe('file_changed')
  })

  test('writeStream lands bytes atomically: byte-exact, temp cleaned, target replaced', async () => {
    const h = harness()
    const target = join(fixtureRoot(), 'bulk-save.bin')
    writeFileSync(target, 'previous contents')
    const identity = await h.statIdentity('bulk-save.bin')
    const payload = Buffer.alloc(200 * 1024, 0x5a)
    const digest = createHash('sha256').update(payload).digest('hex')

    const reply = await h.execute(
      h.makeCommand('dev.files.writeStream', {
        worktreeId: WORKTREE_ID,
        path: wsPath('bulk-save.bin'),
        expectedIdentity: identity,
        byteLength: String(payload.byteLength),
        contentSha256: digest,
        eolPolicy: 'preserve',
        direction: 'write',
      })
    )
    const grant = expectGrantReply(reply, 'write')

    const session = h.attach(grant)
    expect(session.closed).toBeUndefined()
    for (let offset = 0; offset < payload.byteLength; offset += 64 * 1024) {
      const chunk = payload.subarray(offset, Math.min(offset + 64 * 1024, payload.byteLength))
      session.onFrame?.({
        type: 'input',
        sequence: String(offset),
        generation,
        bytes: new Uint8Array(chunk),
      })
    }
    expect(session.closed?.code).toBe('normal')
    expect(readFileSync(target).equals(payload)).toBe(true)
    // The same-directory temp is gone after the atomic rename.
    expect(readdirSync(fixtureRoot()).filter((name) => name.startsWith('.adea-tmp-'))).toEqual([])
  })

  test('writeStream create-new replaces nothing and pins absence', async () => {
    const h = harness()
    const payload = new TextEncoder().encode('fresh bulk bytes\n')
    const reply = await h.execute(
      h.makeCommand('dev.files.writeStream', {
        worktreeId: WORKTREE_ID,
        path: wsPath('created-bulk.txt'),
        expectedIdentity: { mtimeNs: '0', size: '0' },
        byteLength: String(payload.byteLength),
        contentSha256: createHash('sha256').update(payload).digest('hex'),
        eolPolicy: 'preserve',
        direction: 'write',
      })
    )
    const grant = expectGrantReply(reply, 'write')
    const session = h.attach(grant)
    session.onFrame?.({ type: 'input', sequence: '0', generation, bytes: payload })
    expect(session.closed?.code).toBe('normal')
    expect(readFileSync(join(fixtureRoot(), 'created-bulk.txt'), 'utf8')).toBe('fresh bulk bytes\n')
  })

  test('writeStream discards mismatched digests, overruns, and post-mint drift', async () => {
    const h = harness()
    const target = join(fixtureRoot(), 'guarded.bin')
    writeFileSync(target, 'keep me')
    const identity = await h.statIdentity('guarded.bin')
    const payload = new TextEncoder().encode('replacement bulk payload')

    // Digest mismatch: the temp is discarded, the target untouched.
    const badDigest = await h.execute(
      h.makeCommand('dev.files.writeStream', {
        worktreeId: WORKTREE_ID,
        path: wsPath('guarded.bin'),
        expectedIdentity: identity,
        byteLength: String(payload.byteLength),
        contentSha256: '0'.repeat(64),
        eolPolicy: 'preserve',
        direction: 'write',
      })
    )
    const badSession = h.attach(expectGrantReply(badDigest, 'write'))
    badSession.onFrame?.({ type: 'input', sequence: '0', generation, bytes: payload })
    expect(badSession.sent.some((frame) => frame.type === 'error')).toBe(true)
    expect(badSession.sent.find((frame) => frame.type === 'error')?.error.code).toBe('file_changed')
    expect(readFileSync(target, 'utf8')).toBe('keep me')
    expect(readdirSync(fixtureRoot()).filter((name) => name.startsWith('.adea-tmp-'))).toEqual([])

    // Byte overrun over the declared length is refused mid-transfer.
    const overrun = await h.execute(
      h.makeCommand('dev.files.writeStream', {
        worktreeId: WORKTREE_ID,
        path: wsPath('guarded.bin'),
        expectedIdentity: identity,
        byteLength: '4',
        contentSha256: createHash('sha256').update(payload).digest('hex'),
        eolPolicy: 'preserve',
        direction: 'write',
      })
    )
    const overrunSession = h.attach(expectGrantReply(overrun, 'write'))
    overrunSession.onFrame?.({ type: 'input', sequence: '0', generation, bytes: payload })
    expect(readFileSync(target, 'utf8')).toBe('keep me')

    // Drift between mint and attach: the live identity no longer matches.
    const drifted = await h.execute(
      h.makeCommand('dev.files.writeStream', {
        worktreeId: WORKTREE_ID,
        path: wsPath('guarded.bin'),
        expectedIdentity: identity,
        byteLength: String(payload.byteLength),
        contentSha256: createHash('sha256').update(payload).digest('hex'),
        eolPolicy: 'preserve',
        direction: 'write',
      })
    )
    writeFileSync(target, 'changed on disk after mint')
    const driftSession = h.attach(expectGrantReply(drifted, 'write'))
    expect(driftSession.sent.some((frame) => frame.type === 'error')).toBe(true)
    driftSession.onFrame?.({ type: 'input', sequence: '0', generation, bytes: payload })
    expect(readFileSync(target, 'utf8')).toBe('changed on disk after mint')
  })

  test('writeStream refuses non-preserve eol policies and non-adjacent chunks', async () => {
    const h = harness()
    const payload = new TextEncoder().encode('text')
    const refused = await h.execute(
      h.makeCommand('dev.files.writeStream', {
        worktreeId: WORKTREE_ID,
        path: wsPath('eol-bulk.bin'),
        expectedIdentity: { mtimeNs: '0', size: '0' },
        byteLength: String(payload.byteLength),
        contentSha256: createHash('sha256').update(payload).digest('hex'),
        eolPolicy: 'crlf',
        direction: 'write',
      })
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('invalid_state')
    expect(existsSync(join(fixtureRoot(), 'eol-bulk.bin'))).toBe(false)

    const reply = await h.execute(
      h.makeCommand('dev.files.writeStream', {
        worktreeId: WORKTREE_ID,
        path: wsPath('gap-bulk.bin'),
        expectedIdentity: { mtimeNs: '0', size: '0' },
        byteLength: String(payload.byteLength),
        contentSha256: createHash('sha256').update(payload).digest('hex'),
        eolPolicy: 'preserve',
        direction: 'write',
      })
    )
    const session = h.attach(expectGrantReply(reply, 'write'))
    session.onFrame?.({ type: 'input', sequence: '5', generation, bytes: payload })
    expect(session.closed?.code).toBe('normal')
    expect(existsSync(join(fixtureRoot(), 'gap-bulk.bin'))).toBe(false)
  })
})

describe('rename overwrite plan/commit', () => {
  test('plain rename names the collision; the plan pins both identities', async () => {
    const h = harness()
    writeFileSync(join(fixtureRoot(), 'src.txt'), 'source bytes')
    writeFileSync(join(fixtureRoot(), 'dst.txt'), 'destination bytes')
    const srcIdentity = await h.statIdentity('src.txt')
    const dstIdentity = await h.statIdentity('dst.txt')

    const collision = await h.execute(
      h.makeCommand('dev.files.rename', {
        worktreeId: WORKTREE_ID,
        from: wsPath('src.txt'),
        to: wsPath('dst.txt'),
        expectedIdentity: srcIdentity,
        failIfExists: true,
      })
    )
    expect(collision.ok).toBe(false)
    if (!collision.ok) expect(collision.error.message).toContain('dst.txt')

    const plan = await planReply(
      await h.execute(
        h.makeCommand('dev.files.renameOverwritePlan', {
          worktreeId: WORKTREE_ID,
          from: wsPath('src.txt'),
          to: wsPath('dst.txt'),
          expectedFromIdentity: srcIdentity,
          expectedToIdentity: dstIdentity,
        })
      ),
      'dev.files.renameOverwritePlan'
    )
    expect(plan.steps).toEqual([
      { id: 'rename_overwrite', kind: 'file_rename_overwrite', targetId: 'dst.txt', dependsOn: [] },
    ])

    const commit = await h.execute(
      h.makeCommand('dev.files.renameOverwriteCommit', {
        planId: plan.id,
        planDigest: plan.digest,
      })
    )
    expect(commit.ok).toBe(true)
    if (commit.ok) {
      devOperationDecoders['dev.files.renameOverwriteCommit'].reply({
        schemaVersion: 1,
        operation: 'dev.files.renameOverwriteCommit',
        requestId: commit.requestId,
        ok: true,
        value: commit.value,
        observedAt: commit.observedAt,
      })
      expect(commit.value.path.relativePath).toBe('dst.txt')
    }
    expect(readFileSync(join(fixtureRoot(), 'dst.txt'), 'utf8')).toBe('source bytes')
    expect(existsSync(join(fixtureRoot(), 'src.txt'))).toBe(false)

    // Single use: replaying the consumed plan is plan_stale.
    const replay = await h.execute(
      h.makeCommand('dev.files.renameOverwriteCommit', {
        planId: plan.id,
        planDigest: plan.digest,
      })
    )
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.error.code).toBe('plan_stale')
  })

  test('overwrite plan refuses wrong destination pins; commit refuses digest and drift', async () => {
    const h = harness()
    writeFileSync(join(fixtureRoot(), 'ov-src.txt'), 'v1')
    writeFileSync(join(fixtureRoot(), 'ov-dst.txt'), 'old')
    const srcIdentity = await h.statIdentity('ov-src.txt')
    const dstIdentity = await h.statIdentity('ov-dst.txt')

    const wrongPin = await h.execute(
      h.makeCommand('dev.files.renameOverwritePlan', {
        worktreeId: WORKTREE_ID,
        from: wsPath('ov-src.txt'),
        to: wsPath('ov-dst.txt'),
        expectedFromIdentity: srcIdentity,
        expectedToIdentity: { ...dstIdentity, size: '999' },
      })
    )
    expect(wrongPin.ok).toBe(false)
    if (!wrongPin.ok) expect(wrongPin.error.code).toBe('file_changed')

    const missingTarget = await h.execute(
      h.makeCommand('dev.files.renameOverwritePlan', {
        worktreeId: WORKTREE_ID,
        from: wsPath('ov-src.txt'),
        to: wsPath('never-existed.txt'),
        expectedFromIdentity: srcIdentity,
        expectedToIdentity: { mtimeNs: '0', size: '0' },
      })
    )
    expect(missingTarget.ok).toBe(false)
    if (!missingTarget.ok) expect(missingTarget.error.code).toBe('not_found')

    const plan = await planReply(
      await h.execute(
        h.makeCommand('dev.files.renameOverwritePlan', {
          worktreeId: WORKTREE_ID,
          from: wsPath('ov-src.txt'),
          to: wsPath('ov-dst.txt'),
          expectedFromIdentity: srcIdentity,
          expectedToIdentity: dstIdentity,
        })
      ),
      'dev.files.renameOverwritePlan'
    )

    const badDigest = await h.execute(
      h.makeCommand('dev.files.renameOverwriteCommit', {
        planId: plan.id,
        planDigest: '0'.repeat(64),
      })
    )
    expect(badDigest.ok).toBe(false)
    if (!badDigest.ok) expect(badDigest.error.code).toBe('plan_stale')

    // Source moved after the plan: the commit re-proves and refuses.
    writeFileSync(join(fixtureRoot(), 'ov-src.txt'), 'v2')
    const drifted = await h.execute(
      h.makeCommand('dev.files.renameOverwriteCommit', {
        planId: plan.id,
        planDigest: plan.digest,
      })
    )
    expect(drifted.ok).toBe(false)
    if (!drifted.ok) expect(drifted.error.code).toBe('file_changed')
    expect(existsSync(join(fixtureRoot(), 'ov-dst.txt'))).toBe(true)
  })
})

describe('recursive delete plan/commit', () => {
  function buildTree(): number {
    const tree = join(fixtureRoot(), 'tree-rm')
    mkdirSync(join(tree, 'nested', 'deeper'), { recursive: true })
    writeFileSync(join(tree, 'a.txt'), 'alpha')
    writeFileSync(join(tree, 'nested', 'b.txt'), 'bravo')
    writeFileSync(join(tree, 'nested', 'deeper', 'c.txt'), 'charlie')
    return 6 // tree-rm + nested + deeper + 3 files
  }

  test('plan enumerates per-item steps; the confirmed commit deletes depth-first', async () => {
    const h = harness()
    const itemCount = buildTree()
    const identity = await h.statIdentity('tree-rm')

    const shortConfirm = await h.execute(
      h.makeCommand('dev.files.deleteTreePlan', {
        worktreeId: WORKTREE_ID,
        path: wsPath('tree-rm'),
        expectedIdentity: identity,
        confirmationId: 'ab',
      })
    )
    expect(shortConfirm.ok).toBe(false)
    if (!shortConfirm.ok) expect(shortConfirm.error.code).toBe('invalid_state')

    const plan = await planReply(
      await h.execute(
        h.makeCommand('dev.files.deleteTreePlan', {
          worktreeId: WORKTREE_ID,
          path: wsPath('tree-rm'),
          expectedIdentity: identity,
          confirmationId: 'delete-tree-rm',
        })
      ),
      'dev.files.deleteTreePlan'
    )
    expect(plan.steps.length).toBe(itemCount)
    expect(plan.steps.every((step) => step.targetId.startsWith('tree-rm'))).toBe(true)
    // The root directory depends on its direct children.
    const rootStep = plan.steps[0]
    expect(rootStep?.kind).toBe('dir_delete')
    expect(rootStep?.dependsOn?.length).toBe(2)

    const commit = await h.execute(
      h.makeCommand('dev.files.deleteTreeCommit', { planId: plan.id, planDigest: plan.digest })
    )
    expect(commit.ok).toBe(true)
    if (commit.ok) {
      devOperationDecoders['dev.files.deleteTreeCommit'].reply({
        schemaVersion: 1,
        operation: 'dev.files.deleteTreeCommit',
        requestId: commit.requestId,
        ok: true,
        value: commit.value,
        observedAt: commit.observedAt,
      })
      expect(commit.value.state).toBe('deleted')
      expect(commit.value.items).toBe(itemCount)
      expect(commit.value.path.relativePath).toBe('tree-rm')
    }
    expect(existsSync(join(fixtureRoot(), 'tree-rm'))).toBe(false)
  })

  test('symlinks inside the tree refuse the plan; post-plan drift refuses the commit', async () => {
    const h = harness()
    const outside = mkdtempSync(join(tmpdir(), 'adea-rm-outside-'))
    scratch.push(outside)
    const tree = join(fixtureRoot(), 'tree-link')
    mkdirSync(tree)
    writeFileSync(join(tree, 'keep.txt'), 'kept')
    symlinkSync(join(outside, 'secret.txt'), join(tree, 'link.txt'))
    const identity = await h.statIdentity('tree-link')

    const linked = await h.execute(
      h.makeCommand('dev.files.deleteTreePlan', {
        worktreeId: WORKTREE_ID,
        path: wsPath('tree-link'),
        expectedIdentity: identity,
        confirmationId: 'delete-tree-link',
      })
    )
    expect(linked.ok).toBe(false)
    if (!linked.ok) expect(linked.error.code).toBe('symlink_rejected')
    expect(existsSync(join(tree, 'keep.txt'))).toBe(true)

    rmSync(join(tree, 'link.txt'))
    const plan = await planReply(
      await h.execute(
        h.makeCommand('dev.files.deleteTreePlan', {
          worktreeId: WORKTREE_ID,
          path: wsPath('tree-link'),
          expectedIdentity: identity,
          confirmationId: 'delete-tree-link',
        })
      ),
      'dev.files.deleteTreePlan'
    )
    // Drift: a file appears after the plan was made.
    writeFileSync(join(tree, 'stray.txt'), 'surprise')
    const drifted = await h.execute(
      h.makeCommand('dev.files.deleteTreeCommit', { planId: plan.id, planDigest: plan.digest })
    )
    expect(drifted.ok).toBe(false)
    if (!drifted.ok) expect(drifted.error.code).toBe('plan_stale')
    expect(existsSync(join(tree, 'keep.txt'))).toBe(true)
  })
})

describe('recursive copy plan/commit', () => {
  test('plan enumerates source/destination pairs; the commit copies bytes and modes', async () => {
    const h = harness()
    const source = join(fixtureRoot(), 'tree-src')
    mkdirSync(join(source, 'sub'), { recursive: true })
    writeFileSync(join(source, 'one.txt'), 'one')
    writeFileSync(join(source, 'sub', 'two.txt'), 'two-two')

    const identity = await h.statIdentity('tree-src')
    const plan = await planReply(
      await h.execute(
        h.makeCommand('dev.files.copyTreePlan', {
          worktreeId: WORKTREE_ID,
          from: wsPath('tree-src'),
          to: wsPath('tree-dst'),
          expectedIdentity: identity,
          failIfExists: true,
        })
      ),
      'dev.files.copyTreePlan'
    )
    expect(plan.steps.map((step) => step.targetId)).toEqual([
      'tree-dst',
      'tree-dst/one.txt',
      'tree-dst/sub',
      'tree-dst/sub/two.txt',
    ])

    const commit = await h.execute(
      h.makeCommand('dev.files.copyTreeCommit', { planId: plan.id, planDigest: plan.digest })
    )
    expect(commit.ok).toBe(true)
    if (commit.ok) {
      devOperationDecoders['dev.files.copyTreeCommit'].reply({
        schemaVersion: 1,
        operation: 'dev.files.copyTreeCommit',
        requestId: commit.requestId,
        ok: true,
        value: commit.value,
        observedAt: commit.observedAt,
      })
      expect(commit.value.state).toBe('copied')
      expect(commit.value.items).toBe(4)
      expect(commit.value.totalBytes).toBe(String('one'.length + 'two-two'.length))
      expect(commit.value.path.relativePath).toBe('tree-dst')
    }
    expect(readFileSync(join(fixtureRoot(), 'tree-dst', 'one.txt'), 'utf8')).toBe('one')
    expect(readFileSync(join(fixtureRoot(), 'tree-dst', 'sub', 'two.txt'), 'utf8')).toBe('two-two')
    expect(statSync(join(fixtureRoot(), 'tree-dst', 'sub')).isDirectory()).toBe(true)
  })

  test('existing destinations refuse by name; commit refuses post-plan drift', async () => {
    const h = harness()
    const source = join(fixtureRoot(), 'tree-src2')
    mkdirSync(source)
    writeFileSync(join(source, 'one.txt'), 'one')
    writeFileSync(join(fixtureRoot(), 'occupied'), 'occupied')
    const identity = await h.statIdentity('tree-src2')

    const occupied = await h.execute(
      h.makeCommand('dev.files.copyTreePlan', {
        worktreeId: WORKTREE_ID,
        from: wsPath('tree-src2'),
        to: wsPath('occupied'),
        expectedIdentity: identity,
        failIfExists: true,
      })
    )
    expect(occupied.ok).toBe(false)
    if (!occupied.ok) expect(occupied.error.message).toContain('occupied')

    const plan = await planReply(
      await h.execute(
        h.makeCommand('dev.files.copyTreePlan', {
          worktreeId: WORKTREE_ID,
          from: wsPath('tree-src2'),
          to: wsPath('tree-dst2'),
          expectedIdentity: identity,
          failIfExists: true,
        })
      ),
      'dev.files.copyTreePlan'
    )
    writeFileSync(join(source, 'one.txt'), 'one-changed')
    const drifted = await h.execute(
      h.makeCommand('dev.files.copyTreeCommit', { planId: plan.id, planDigest: plan.digest })
    )
    expect(drifted.ok).toBe(false)
    if (!drifted.ok) expect(drifted.error.code).toBe('plan_stale')
    expect(existsSync(join(fixtureRoot(), 'tree-dst2'))).toBe(false)
  })
})
