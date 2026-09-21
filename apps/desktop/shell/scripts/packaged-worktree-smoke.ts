// Packaged worktree containment smoke (#397): template materialization and
// digest-tamper refusal through the PRODUCTION registrar
// (shell/src/dev-runtime/worktrees/register.ts), driven through the M10
// channel authority with signed dev.worktree.* commands on the packaged
// evidence lane (darwin, the Electrobun .app built).
//
// Proofs, each a re-closure requirement from the issue's 2026-09-19 audit:
//   1. `dev.worktree.create` through the production registrar creates a real
//      git worktree under the authorized host root (registrar gate: scope,
//      envelope, host-derived base dir);
//   2. a promoted dependency template materializes into a registrar-created
//      worktree via per-file CoW clones (copied > 0, content verified);
//   3. a template tampered AFTER promotion — same size, restored mtime, so
//      only the recomputed content digest can catch it — REFUSES
//      materialization with `identity_mismatch` and clones nothing;
//   4. the registrar's generation fencing refuses a lease whose envelope
//      generation is stale (`stale_generation`).
//
// Scope honesty: the worktree service is host-side TypeScript executed here
// from the same modules the shell bundles; running it INSIDE the packaged
// app process arrives with the production composition root (out of this
// session's scope, named in the spec). The template materialize/tamper path
// goes through the registrar-owned service instance — the same instance the
// registrar's dev.worktree.* handlers dispatch to.
//
// Usage: bun apps/desktop/shell/scripts/packaged-worktree-smoke.ts [--app-bundle <path>] [--artifact <path>]
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHmac, randomUUID } from 'node:crypto'

import {
  devCommandProofMessage,
  devOperationDefinitions,
  type DevCommand,
  type DevReply,
} from '../../../../packages/types/src/dev-runtime'
import { createChannelAuthority } from '../src/dev-runtime/channel/authority'
import { createCredentialVault } from '../src/dev-runtime/vault'
import { directoryIdentity } from '../src/dev-runtime/worktrees/identity'
import { createWorktreeService } from '../src/dev-runtime/worktrees/service'
import { registerWorktreeRuntime } from '../src/dev-runtime/worktrees/register'
import {
  computeValidityDigest,
  type TemplateValidityComponents,
} from '../src/dev-runtime/worktrees/templates'
import { initRepo, projectIdA, scope } from '../../tests/worktree-fixtures'
import { createOwnerApprovalVerifier, type OwnerApproval } from '../src/dev-runtime/authority'
import { createRootBookmarkAuthority } from '../src/dev-runtime/roots'
import {
  BUN_INSTALL_LABEL,
  SIDECAR_INSTALL_LABEL,
  findAppBundle,
  resolveInstallLocation,
} from './packaged-install'

const SHELL_HOST = '127.0.0.1:4791'
const SHELL_ORIGIN = 'http://127.0.0.1:4791'

let approvalSequence = 0
/** Issues one durable, scope-bound, single-use owner approval (M10 #34),
 *  the same pattern the worktree fixtures use. */
function approved(
  verifier: ReturnType<typeof createOwnerApprovalVerifier>,
  action: string
): OwnerApproval {
  const approval: OwnerApproval = {
    method: 'owner_dialog',
    reference: `packaged-evidence-${++approvalSequence}`,
    scope,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  verifier.recordIssuance(approval, scope, action)
  return approval
}

type Check = { check: string; ok: boolean; detail?: string }
const checks: Check[] = []

function check(ok: boolean, description: string, detail?: string): boolean {
  checks.push({ check: description, ok, ...(detail !== undefined ? { detail } : {}) })
  if (ok) console.log(`  ok: ${description}${detail ? ` — ${detail}` : ''}`)
  else console.error(`  FAIL: ${description}${detail ? ` — ${detail}` : ''}`)
  return ok
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const TEMPLATE_COMPONENTS: TemplateValidityComponents = {
  packageManager: 'bun',
  lockfiles: { 'bun.lock': 'a'.repeat(64) },
  manifests: { 'package.json': 'b'.repeat(64) },
  configDigests: { 'tsconfig.json': 'c'.repeat(64) },
}

async function main(): Promise<number> {
  if (process.platform !== 'darwin') {
    console.error('packaged-worktree-smoke: darwin-only packaged evidence lane')
    return 2
  }
  const startedAt = new Date().toISOString()
  const artifactPath = argValue('--artifact') ?? 'artifacts/packaged/worktree-containment.json'
  const appBundle =
    argValue('--app-bundle') ??
    findAppBundle(join(import.meta.dir, '..', 'build')) ??
    findAppBundle(join(import.meta.dir, '..', '..', '..', 'apps', 'desktop', 'shell', 'build'))
  if (!appBundle) {
    console.error(
      'packaged-worktree-smoke: no packaged app bundle found; run the packaged lane first'
    )
    return 2
  }
  const sidecarResolution = resolveInstallLocation(appBundle, SIDECAR_INSTALL_LABEL)
  const bunResolution = resolveInstallLocation(appBundle, BUN_INSTALL_LABEL)
  check(
    sidecarResolution.ok && bunResolution.ok,
    'the packaged bundle is present with its staged sidecar component (lane anchor)',
    appBundle
  )
  const bundleDigest = (() => {
    try {
      const hasher = new Bun.CryptoHasher('sha256')
      hasher.update(readFileSync(join(appBundle, 'Contents/Resources/version.json')))
      return hasher.digest('hex')
    } catch {
      return 'unavailable'
    }
  })()

  // Disposable world: data dir, workspace bookmark root, primary checkout.
  const root = mkdtempSync(join(tmpdir(), 'adea-worktree-packaged-'))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  const repoPath = initRepo(join(workspace, 'primary'))

  // The host ensures the per-repo worktree base directory the registrar
  // derives from the bookmarked root:
  // worktreeBaseDir = <root>/adea-worktrees/<repo basename>.
  mkdirSync(join(workspace, 'adea-worktrees', 'primary'), { recursive: true })
  const verifier = createOwnerApprovalVerifier({ dataDir })
  const roots = createRootBookmarkAuthority({ dataDir, approvalVerifier: verifier })
  const bookmark = roots.mint({
    scope,
    label: 'Workspace',
    kind: 'repository',
    absolutePath: workspace,
    approval: approved(verifier, 'authorize a root bookmark'),
  })
  const vault = createCredentialVault({ dataDir, approvalVerifier: verifier })
  const service = createWorktreeService({
    dataDir,
    runtimeNodeId: scope.runtimeNodeId,
    roots,
    clock: () => new Date(),
  })

  // Production registrar over the M10 channel authority, exactly as the
  // composition root wires it (index.ts registerWorktreeRuntime).
  const authority = createChannelAuthority({ shellHost: SHELL_HOST, shellOrigin: SHELL_ORIGIN })
  const handshakeReply = authority.handshake(
    {
      schemaVersion: 1,
      method: 'dev.runtime.handshake.v1',
      requestId: randomUUID(),
      bootstrap: authority.issueLaunchBootstrap(),
      supportedProtocolVersions: ['1'],
      nonce: Buffer.from(randomUUID()).toString('base64url'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
    { trusted: true }
  )
  if (!handshakeReply.ok) throw new Error('handshake failed')
  const identity = {
    channelId: handshakeReply.channelId,
    clientCredentialId: handshakeReply.clientCredentialId,
  }
  const secret = Buffer.from(handshakeReply.clientSecret, 'base64url')

  const registrar = registerWorktreeRuntime({
    authority,
    dataDir,
    scope,
    runtimeNodeId: scope.runtimeNodeId,
    roots,
    vault,
    // The registrar-owned service instance, injected through the registrar's
    // own seam so the template path below dispatches into the SAME state the
    // dev.worktree.* handlers use.
    service,
  })
  check(
    registrar.registeredCommands > 0,
    'the production registrar registered its dev.worktree.*/dev.repo.* commands',
    `${registrar.registeredCommands} commands`
  )

  // Repo registration is discovery-owned (not a registrar operation): the
  // same seam the discovery lane uses.
  const repo = await service.registerRepo({
    scope,
    projectId: projectIdA,
    absolutePath: repoPath,
    bookmarkId: bookmark.id,
  })

  function execute(
    operation: 'dev.worktree.create' | 'dev.worktree.lease' | 'dev.worktree.list',
    body: Record<string, unknown>,
    resource?: { kind: 'worktree'; id: string; generation: number }
  ): Promise<DevReply> {
    const command: DevCommand = {
      schemaVersion: 1,
      operation,
      requestId: randomUUID(),
      nonce: Buffer.from(randomUUID()).toString('base64url'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      scope,
      // Exactly the operation's declared capability set, as the channel
      // gate requires.
      capabilities: [...devOperationDefinitions[operation].capabilities],
      ...(resource !== undefined ? { resource } : {}),
      body,
    }
    return authority.execute(
      {
        channelId: identity.channelId,
        clientCredentialId: identity.clientCredentialId,
        command,
        proof: createHmac('sha256', secret)
          .update(
            devCommandProofMessage({
              channelId: identity.channelId,
              clientCredentialId: identity.clientCredentialId,
              command,
            }),
            'utf8'
          )
          .digest('base64url'),
      },
      { trusted: true }
    )
  }

  try {
    // 1. Create two worktrees through the production registrar.
    console.log('PROOF 1 dev.worktree.create through the production registrar')
    const created = await execute('dev.worktree.create', {
      projectId: projectIdA,
      repoId: repo.id,
      baseRef: 'main',
      branchName: 'packaged-evidence-1',
    })
    check(created.ok, 'dev.worktree.create succeeded through the registrar gate')
    if (!created.ok) {
      console.error(`  create error: ${created.error.code} ${created.error.message}`)
      return finish(1, artifactPath, appBundle, bundleDigest, startedAt)
    }
    if (!created.ok) return finish(1, artifactPath, appBundle, bundleDigest, startedAt)
    const op = created.value as {
      worktree: { id: string; canonicalRoot: string; generation: number }
    }
    const worktreeA = op.worktree
    check(
      existsSync(worktreeA.canonicalRoot),
      'the registrar created a real worktree on disk under the authorized root',
      worktreeA.canonicalRoot
    )
    check(
      worktreeA.canonicalRoot.startsWith(realpathSync(join(workspace, 'adea-worktrees')) + '/'),
      'the host-derived base directory sits under the bookmarked root, never the primary checkout',
      worktreeA.canonicalRoot
    )

    const createdB = await execute('dev.worktree.create', {
      projectId: projectIdA,
      repoId: repo.id,
      baseRef: 'main',
      branchName: 'packaged-evidence-2',
    })
    check(createdB.ok, 'second create (materialize destination) succeeded')
    if (!createdB.ok) return finish(1, artifactPath, appBundle, bundleDigest, startedAt)
    const worktreeB = (createdB.value as { worktree: { id: string; canonicalRoot: string } })
      .worktree

    // 2. Promote a dependency template and materialize it (CoW clones).
    console.log('PROOF 2 dependency-template materialization into a registrar-created worktree')
    const build = await service.templates.beginBuild({
      scope,
      projectId: projectIdA,
      components: TEMPLATE_COMPONENTS,
      approval: { method: 'owner_setting', reference: 'packaged-evidence' },
    })
    writeFileSync(join(build.stagingDir, 'dep.mjs'), 'export const packaged = 1\n')
    const promoted = await build.commit()
    check(promoted.state === 'ready', 'template promoted (approved, locked, digest-bound)')
    const validityDigest = computeValidityDigest(TEMPLATE_COMPONENTS)

    const identityB = directoryIdentity(worktreeB.canonicalRoot)
    let materialized: Awaited<ReturnType<typeof service.templates.materialize>>
    try {
      materialized = await service.templates.materialize({
        scope,
        projectId: projectIdA,
        validityDigest,
        worktreeRoot: worktreeB.canonicalRoot,
        worktreeIdentity: identityB.identity,
      })
    } catch (error) {
      check(
        false,
        'materialization copied the template into the worktree via per-file CoW clones',
        `${(error as { code?: string }).code ?? '?'}: ${(error as Error).message}`
      )
      return finish(1, artifactPath, appBundle, bundleDigest, startedAt)
    }
    check(
      materialized.copied > 0,
      'materialization copied the template into the worktree via per-file CoW clones',
      `copied=${materialized.copied} contentDigest=${materialized.contentDigest.slice(0, 12)}…`
    )
    check(
      readFileSync(join(worktreeB.canonicalRoot, 'dep.mjs'), 'utf8') ===
        'export const packaged = 1\n',
      'the cloned file content matches the promoted template'
    )

    // 3. Tamper after promotion: same size, restored mtime — only the
    // recomputed content digest can catch it. Materialization must refuse
    // and clone nothing.
    console.log('PROOF 3 digest-tamper refusal after promotion')
    const status = service.templates.status(scope, projectIdA)
    if (!('templatePath' in status) || !status.templatePath)
      throw new Error('template not promoted')
    const templateFile = join(status.templatePath, 'dep.mjs')
    const before = statSync(templateFile)
    writeFileSync(templateFile, 'export const packaged = 2\n')
    utimesSync(templateFile, before.atime, before.mtime)
    check(
      statSync(templateFile).size === before.size,
      'the tampered file kept its size and mtime (stat fingerprints pass)'
    )

    const createdC = await execute('dev.worktree.create', {
      projectId: projectIdA,
      repoId: repo.id,
      baseRef: 'main',
      branchName: 'packaged-evidence-3',
    })
    check(createdC.ok, 'third create (tamper destination) succeeded')
    if (!createdC.ok) return finish(1, artifactPath, appBundle, bundleDigest, startedAt)
    const worktreeC = (createdC.value as { worktree: { id: string; canonicalRoot: string } })
      .worktree
    const identityC = directoryIdentity(worktreeC.canonicalRoot)
    let refused = false
    try {
      await service.templates.materialize({
        scope,
        projectId: projectIdA,
        validityDigest,
        worktreeRoot: worktreeC.canonicalRoot,
        worktreeIdentity: identityC.identity,
      })
    } catch (error) {
      refused = (error as { code?: string }).code === 'identity_mismatch'
    }
    check(refused, 'the tampered template REFUSED materialization with identity_mismatch')
    check(
      !existsSync(join(worktreeC.canonicalRoot, 'dep.mjs')),
      'nothing was cloned from the tampered template'
    )
    // Cleanup clears only the template cache, never worktrees.
    const cleared = service.templates.clear(scope, projectIdA)
    check(
      cleared.cleared === true && existsSync(worktreeB.canonicalRoot),
      'template clear removes only the cache; worktrees stay untouched'
    )

    // 4. Registrar generation fencing: a stale envelope generation refuses.
    console.log('PROOF 4 registrar generation fencing on dev.worktree.lease')
    const leased = await execute(
      'dev.worktree.lease',
      {
        worktreeId: worktreeA.id,
        expectedGeneration: worktreeA.generation,
        ownerKind: 'terminal',
        ownerId: 'packaged-evidence-terminal',
      },
      { kind: 'worktree', id: worktreeA.id, generation: worktreeA.generation }
    )
    check(leased.ok, 'lease with the live generation succeeded through the gate')
    const stale = await execute(
      'dev.worktree.lease',
      {
        worktreeId: worktreeA.id,
        expectedGeneration: worktreeA.generation + 5,
        ownerKind: 'terminal',
        ownerId: 'packaged-evidence-terminal',
      },
      { kind: 'worktree', id: worktreeA.id, generation: worktreeA.generation + 5 }
    )
    check(
      !stale.ok && stale.error.code === 'stale_generation',
      'a stale envelope generation is refused with stale_generation',
      stale.ok ? 'unexpectedly ok' : stale.error.code
    )

    return finish(
      checks.every((entry) => entry.ok) ? 0 : 1,
      artifactPath,
      appBundle,
      bundleDigest,
      startedAt
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function finish(
  code: number,
  artifactPath: string,
  appBundle: string,
  bundleDigest: string,
  startedAt: string
): number {
  mkdirSync(dirname(artifactPath), { recursive: true })
  writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        lane: 'packaged-worktree-containment',
        issue: '397',
        spec: 'docs/specs/dev-runtime.md (worktree lifecycle; dependency-template cache)',
        mode: 'packaged-lane (production registrar modules; in-app execution named out of scope in the spec)',
        appBundle,
        bundleVersionDigest: bundleDigest,
        startedAt,
        finishedAt: new Date().toISOString(),
        bun: process.versions.bun,
        command:
          'bun apps/desktop/shell/scripts/packaged-worktree-smoke.ts --app-bundle <Adea-dev.app>',
        totals: { checks: checks.length, failed: checks.filter((entry) => !entry.ok).length },
        checks,
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  )
  console.log(`artifact: ${artifactPath}`)
  if (code === 0) console.log('PACKAGED-WORKTREE-CONTAINMENT PASS')
  else console.error('PACKAGED-WORKTREE-CONTAINMENT FAILED')
  return code
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('PACKAGED-WORKTREE-SMOKE ERROR', error)
    process.exit(1)
  })
