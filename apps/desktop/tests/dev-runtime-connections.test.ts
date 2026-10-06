// Workspace connections (ADR 0012): per-workspace git hosting and harness
// account bindings, reusable device-wide account profiles, and resolution.
//
// Pins:
// - binding CRUD on the active scope's own partition with optimistic version
//   conflicts (0 = never written) and strict vault validation (unknown or
//   foreign refs are not_found, host mismatch is identity_mismatch, SSH keys
//   are incompatible, non-ready refs are invalid_state);
// - cross-workspace isolation: a binding made in workspace A is never seen,
//   resolved, or borrowed in workspace B, which reports `device_default`;
// - every resolution lands in the secret-free audit trail with the resolved
//   reference id or `connection: device_default`;
// - a bound connection that cannot be used fails closed, never falls back;
// - profile delete is refused while any workspace on this device binds it;
// - the git/gh/glab env builders carry the token only for the bound host;
// - the store fails closed on a tampered partition.
import { describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  devOperationDefinitions,
  type DevCommand,
  type DevOperation,
  type Scope,
} from '../../../packages/types/src/dev-runtime'
import {
  createOwnerApprovalVerifier,
  type OwnerApproval,
  type OwnerApprovalVerifier,
} from '../shell/src/dev-runtime/authority'
import type { ChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import {
  registerConnectionsRuntime,
  type ConnectionsRuntime,
} from '../shell/src/dev-runtime/connections/register'
import { scopeDigest, workspaceConnectionsFile } from '../shell/src/dev-runtime/connections/store'
import {
  ghTokenEnv,
  gitTransportEnv,
  glabTokenEnv,
  hostnameArg,
  parseRemoteTransport,
} from '../shell/src/dev-runtime/connections/transport-env'
import {
  createCredentialVault,
  createInMemoryVaultKeyStore,
  type CredentialVault,
} from '../shell/src/dev-runtime/vault'

const SCOPE_A: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-00000000000a',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const SCOPE_B: Scope = { ...SCOPE_A, workspaceId: '00000000-0000-4000-8000-00000000000b' }
const GIT_SECRET = `ghp_${randomBytes(12).toString('hex')}`
const API_SECRET = `sk-ant-${randomBytes(12).toString('hex')}`

type Handler = (command: DevCommand) => unknown | Promise<unknown>

function fakeAuthority(): { authority: ChannelAuthority; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  const authority = {
    registerCommandProvider(operation: string, handler: Handler) {
      handlers.set(operation, handler)
    },
  } as unknown as ChannelAuthority
  return { authority, handlers }
}

function commandFor(
  operation: DevOperation,
  scope: Scope,
  body: Record<string, unknown> = {}
): DevCommand {
  return {
    schemaVersion: 1,
    operation,
    requestId: randomUUID(),
    nonce: randomBytes(24).toString('base64url'),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    scope,
    capabilities: [...devOperationDefinitions[operation].capabilities],
    body,
  } as DevCommand
}

let consentSequence = 0
function approved(verifier: OwnerApprovalVerifier, scope: Scope): OwnerApproval {
  const approval: OwnerApproval = {
    method: 'owner_dialog',
    reference: `consent-${++consentSequence}`,
    scope,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  verifier.recordIssuance(approval, scope, 'enroll a credential')
  return approval
}

type Workspace = Readonly<{
  scope: Scope
  runtime: ConnectionsRuntime
  run(operation: DevOperation, body?: Record<string, unknown>): Promise<Record<string, unknown>>
  fail(operation: DevOperation, body?: Record<string, unknown>): Promise<{ code: string }>
}>

function device() {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-connections-'))
  const verifier = createOwnerApprovalVerifier({ dataDir })
  const vault: CredentialVault = createCredentialVault({
    dataDir,
    approvalVerifier: verifier,
    credentialStore: createInMemoryVaultKeyStore(),
  })
  const families = [
    { harnessId: 'pi' as const, displayName: 'Pi' },
    { harnessId: 'claude-code' as const, displayName: 'Claude Code' },
  ]
  function workspace(scope: Scope): Workspace {
    const { authority, handlers } = fakeAuthority()
    const runtime = registerConnectionsRuntime({
      authority,
      dataDir,
      scope,
      vault,
      discoveredHarnesses: () => families,
    })
    const invoke = async (operation: DevOperation, body: Record<string, unknown> = {}) => {
      const handler = handlers.get(operation)
      if (!handler) throw new Error(`no handler for ${operation}`)
      return (await handler(commandFor(operation, scope, body))) as Record<string, unknown>
    }
    return {
      scope,
      runtime,
      run: invoke,
      async fail(operation, body = {}) {
        try {
          await invoke(operation, body)
        } catch (error) {
          return error as { code: string }
        }
        throw new Error(`${operation} unexpectedly succeeded`)
      },
    }
  }
  function enroll(
    scope: Scope,
    input: { host: string; kind?: 'git_https' | 'github_token' | 'ssh_key' | 'other' } & {
      label?: string
      secret?: string
    }
  ) {
    return vault.enroll({
      scope,
      label: input.label ?? `${input.host} credential`,
      host: input.host,
      kind: input.kind ?? 'github_token',
      secret: input.secret ?? GIT_SECRET,
      approval: approved(verifier, scope),
    })
  }
  function auditLines(scope: Scope): Array<Record<string, unknown>> {
    const dir = join(dataDir, 'dev-runtime', 'connections')
    const file = `audit-${scopeDigest(scope)}.jsonl`
    if (!readdirSync(dir).includes(file)) return []
    return readFileSync(join(dir, file), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }
  /** Every byte Adea persisted under the data dir, for secret scans. */
  function persistedText(): string {
    const chunks: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else chunks.push(readFileSync(path).toString('latin1'))
      }
    }
    walk(dataDir)
    return chunks.join('\n')
  }
  return {
    dataDir,
    vault,
    workspace,
    enroll,
    auditLines,
    persistedText,
    dispose: () => rmSync(dataDir, { recursive: true, force: true }),
  }
}

describe('workspace connection bindings', () => {
  test('git hosting CRUD is versioned and validated against the active vault scope', async () => {
    const shell = device()
    try {
      const a = shell.workspace(SCOPE_A)
      const initial = await a.run('dev.connections.get')
      expect(initial).toMatchObject({ version: 0, gitHosting: [], harnessAccounts: [] })
      expect(initial.availableHarnesses).toEqual([
        {
          harnessId: 'claude-code',
          displayName: 'Claude Code',
          accountHosts: ['api.anthropic.com'],
        },
        {
          harnessId: 'pi',
          displayName: 'Pi',
          accountHosts: ['api.anthropic.com', 'api.openai.com'],
        },
      ])

      const github = shell.enroll(SCOPE_A, { host: 'github.com' })
      const bound = await a.run('dev.connections.setGitHosting', {
        host: 'github.com',
        credentialRefId: github.id,
        expectedVersion: 0,
      })
      expect(bound).toMatchObject({
        version: 1,
        gitHosting: [{ host: 'github.com', credentialRefId: github.id }],
      })

      // A stale writer loses and learns the current version.
      const stale = await a.fail('dev.connections.setGitHosting', {
        host: 'github.com',
        credentialRefId: null,
        expectedVersion: 0,
      })
      expect(stale).toMatchObject({ code: 'stale_version', currentVersion: 1 })

      // Host mismatch, unknown ids, SSH keys, and revoked refs refuse.
      const gitlab = shell.enroll(SCOPE_A, { host: 'gitlab.example.com', kind: 'git_https' })
      expect(
        (
          await a.fail('dev.connections.setGitHosting', {
            host: 'github.com',
            credentialRefId: gitlab.id,
            expectedVersion: 1,
          })
        ).code
      ).toBe('identity_mismatch')
      expect(
        (
          await a.fail('dev.connections.setGitHosting', {
            host: 'github.com',
            credentialRefId: randomUUID(),
            expectedVersion: 1,
          })
        ).code
      ).toBe('not_found')
      const sshKey = shell.enroll(SCOPE_A, { host: 'github.com', kind: 'ssh_key', label: 'ssh' })
      expect(
        (
          await a.fail('dev.connections.setGitHosting', {
            host: 'github.com',
            credentialRefId: sshKey.id,
            expectedVersion: 1,
          })
        ).code
      ).toBe('incompatible')
      expect(
        (
          await a.fail('dev.connections.setGitHosting', {
            host: 'GitHub.com',
            credentialRefId: github.id,
            expectedVersion: 1,
          })
        ).code
      ).toBe('invalid_state')

      // A second host binds alongside; clearing removes only that host.
      const withGitlab = await a.run('dev.connections.setGitHosting', {
        host: 'gitlab.example.com',
        credentialRefId: gitlab.id,
        expectedVersion: 1,
      })
      expect(withGitlab.version).toBe(2)
      const cleared = await a.run('dev.connections.setGitHosting', {
        host: 'github.com',
        credentialRefId: null,
        expectedVersion: 2,
      })
      expect(cleared).toMatchObject({
        version: 3,
        gitHosting: [{ host: 'gitlab.example.com', credentialRefId: gitlab.id }],
      })
      // Re-applying the current state is a no-op that keeps the version.
      const noop = await a.run('dev.connections.setGitHosting', {
        host: 'github.com',
        credentialRefId: null,
        expectedVersion: 3,
      })
      expect(noop.version).toBe(3)

      // The partition is owner-only and secret-free.
      const file = workspaceConnectionsFile(shell.dataDir, SCOPE_A)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(shell.persistedText()).not.toContain(GIT_SECRET)
    } finally {
      shell.dispose()
    }
  })

  test('a binding in workspace A is never visible or resolved in workspace B', async () => {
    const shell = device()
    try {
      const a = shell.workspace(SCOPE_A)
      const b = shell.workspace(SCOPE_B)
      const refA = shell.enroll(SCOPE_A, { host: 'github.com' })
      await a.run('dev.connections.setGitHosting', {
        host: 'github.com',
        credentialRefId: refA.id,
        expectedVersion: 0,
      })

      // B's partition is its own: empty, version 0.
      expect(await b.run('dev.connections.get')).toMatchObject({ version: 0, gitHosting: [] })
      expect(workspaceConnectionsFile(shell.dataDir, SCOPE_A)).not.toBe(
        workspaceConnectionsFile(shell.dataDir, SCOPE_B)
      )

      // B cannot bind A's credential: A's vault partition reads as absent.
      expect(
        (
          await b.fail('dev.connections.setGitHosting', {
            host: 'github.com',
            credentialRefId: refA.id,
            expectedVersion: 0,
          })
        ).code
      ).toBe('not_found')

      // A resolves its binding with the secret; B resolves the device default.
      const inA = a.runtime.resolveGitHosting({ host: 'github.com', operation: 'test.fetch' })
      expect(inA.connection).toBe('workspace')
      if (inA.connection === 'workspace') {
        expect(inA.credentialRefId).toBe(refA.id)
        expect(inA.secret.reveal()).toBe(GIT_SECRET)
        expect(() => JSON.stringify(inA)).toThrow()
      }
      const inB = b.runtime.resolveGitHosting({ host: 'github.com', operation: 'test.fetch' })
      expect(inB).toEqual({ connection: 'device_default', host: 'github.com' })

      // The fallback and the resolved reference are both audited, secret-free.
      const auditA = shell.auditLines(SCOPE_A)
      expect(
        auditA.some(
          (line) =>
            line.action === 'connections.git_hosting.resolved' &&
            (line.detail as Record<string, string>).connection === 'workspace' &&
            (line.detail as Record<string, string>).refId === refA.id
        )
      ).toBe(true)
      const auditB = shell.auditLines(SCOPE_B)
      expect(
        auditB.some(
          (line) =>
            line.action === 'connections.git_hosting.resolved' &&
            (line.detail as Record<string, string>).connection === 'device_default'
        )
      ).toBe(true)
      expect(shell.persistedText()).not.toContain(GIT_SECRET)
    } finally {
      shell.dispose()
    }
  })

  test('a bound connection that cannot be used fails closed instead of falling back', async () => {
    const shell = device()
    try {
      const a = shell.workspace(SCOPE_A)
      const ref = shell.enroll(SCOPE_A, { host: 'github.com' })
      await a.run('dev.connections.setGitHosting', {
        host: 'github.com',
        credentialRefId: ref.id,
        expectedVersion: 0,
      })
      shell.vault.revoke({ scope: SCOPE_A, credentialRefId: ref.id, expectedVersion: ref.version })
      expect(() =>
        a.runtime.resolveGitHosting({ host: 'github.com', operation: 'test.push' })
      ).toThrow(expect.objectContaining({ code: 'auth_required' }))
      // SSH transport keeps the device SSH agent and says so.
      expect(
        a.runtime.resolveGitHosting({ host: 'github.com', operation: 'test', transport: 'ssh' })
      ).toEqual({ connection: 'device_default', host: 'github.com' })
      expect(
        shell
          .auditLines(SCOPE_A)
          .some(
            (line) =>
              (line.detail as Record<string, string>).transport === 'ssh' &&
              (line.detail as Record<string, string>).connection === 'device_default'
          )
      ).toBe(true)
    } finally {
      shell.dispose()
    }
  })

  test('a tampered partition naming another scope fails closed', async () => {
    const shell = device()
    try {
      const a = shell.workspace(SCOPE_A)
      await a.run('dev.connections.get')
      writeFileSync(
        workspaceConnectionsFile(shell.dataDir, SCOPE_A),
        JSON.stringify({
          schemaVersion: 1,
          savedAt: new Date().toISOString(),
          records: [
            {
              scope: SCOPE_B,
              gitHosting: [],
              harnessAccounts: [],
              version: 1,
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
        { mode: 0o600 }
      )
      expect((await a.fail('dev.connections.get')).code).toBe('corrupt_state')
      expect(() => a.runtime.resolveGitHosting({ host: 'github.com', operation: 'x' })).toThrow()
    } finally {
      shell.dispose()
    }
  })
})

describe('harness account profiles', () => {
  test('profiles are reusable across workspaces and cannot be deleted while bound', async () => {
    const shell = device()
    try {
      const a = shell.workspace(SCOPE_A)
      const b = shell.workspace(SCOPE_B)
      const anthropic = shell.enroll(SCOPE_A, {
        host: 'api.anthropic.com',
        kind: 'other',
        label: 'Work Anthropic key',
        secret: API_SECRET,
      })
      const github = shell.enroll(SCOPE_A, { host: 'github.com', label: 'gh' })

      // The provider host must be one the family can use.
      expect(
        (
          await a.fail('dev.harness.accountProfiles.create', {
            harnessId: 'codex',
            label: 'Wrong provider',
            credentialRefId: anthropic.id,
          })
        ).code
      ).toBe('identity_mismatch')
      expect(
        (
          await a.fail('dev.harness.accountProfiles.create', {
            harnessId: 'claude-code',
            label: 'Not an API key',
            credentialRefId: github.id,
          })
        ).code
      ).toBe('identity_mismatch')

      const profile = await a.run('dev.harness.accountProfiles.create', {
        harnessId: 'pi',
        label: 'Work account',
        credentialRefId: anthropic.id,
      })
      expect(profile).toEqual({
        id: expect.any(String),
        harnessId: 'pi',
        label: 'Work account',
        credentialRefId: anthropic.id,
        version: 1,
      })
      // Device-wide: workspace B lists the same profile.
      const listedInB = await b.run('dev.harness.accountProfiles.list', {})
      expect((listedInB.items as unknown[]).length).toBe(1)

      // Both workspaces bind it; each binding is its own document.
      await a.run('dev.connections.setHarnessAccount', {
        harnessId: 'pi',
        profileId: profile.id,
        expectedVersion: 0,
      })
      await b.run('dev.connections.setHarnessAccount', {
        harnessId: 'pi',
        profileId: profile.id,
        expectedVersion: 0,
      })
      // Wrong family binding is refused.
      expect(
        (
          await a.fail('dev.connections.setHarnessAccount', {
            harnessId: 'claude-code',
            profileId: profile.id,
            expectedVersion: 1,
          })
        ).code
      ).toBe('identity_mismatch')

      // Delete is refused while any workspace on the device binds it.
      expect(
        (
          await a.fail('dev.harness.accountProfiles.delete', {
            profileId: profile.id,
            expectedVersion: 1,
          })
        ).code
      ).toBe('invalid_state')
      await a.run('dev.connections.setHarnessAccount', {
        harnessId: 'pi',
        profileId: null,
        expectedVersion: 1,
      })
      // Still bound by B — A's partition was never opened to decide this.
      expect(
        (
          await a.fail('dev.harness.accountProfiles.delete', {
            profileId: profile.id,
            expectedVersion: 1,
          })
        ).code
      ).toBe('invalid_state')
      await b.run('dev.connections.setHarnessAccount', {
        harnessId: 'pi',
        profileId: null,
        expectedVersion: 1,
      })
      expect(
        (
          await a.fail('dev.harness.accountProfiles.delete', {
            profileId: profile.id,
            expectedVersion: 7,
          })
        ).code
      ).toBe('stale_version')
      const deleted = await a.run('dev.harness.accountProfiles.delete', {
        profileId: profile.id,
        expectedVersion: 1,
      })
      expect(deleted.id).toBe(profile.id)
      expect((await a.run('dev.harness.accountProfiles.list', {})).items).toEqual([])
      expect(shell.persistedText()).not.toContain(API_SECRET)
    } finally {
      shell.dispose()
    }
  })

  test('harness account resolution is per workspace and reports the device default', async () => {
    const shell = device()
    try {
      const a = shell.workspace(SCOPE_A)
      const b = shell.workspace(SCOPE_B)
      const anthropic = shell.enroll(SCOPE_A, {
        host: 'api.anthropic.com',
        kind: 'other',
        secret: API_SECRET,
      })
      const profile = await a.run('dev.harness.accountProfiles.create', {
        harnessId: 'claude-code',
        label: 'Personal',
        credentialRefId: anthropic.id,
      })
      await a.run('dev.connections.setHarnessAccount', {
        harnessId: 'claude-code',
        profileId: profile.id,
        expectedVersion: 0,
      })
      const inA = a.runtime.resolveHarnessAccount({ harnessId: 'claude-code', operation: 'test' })
      expect(inA).toMatchObject({
        connection: 'workspace',
        profileId: profile.id,
        envKey: 'ANTHROPIC_API_KEY',
      })
      if (inA.connection === 'workspace') expect(inA.readSecret().reveal()).toBe(API_SECRET)
      expect(
        b.runtime.resolveHarnessAccount({ harnessId: 'claude-code', operation: 'test' })
      ).toEqual({
        connection: 'device_default',
        harnessId: 'claude-code',
      })
      shell.vault.revoke({
        scope: SCOPE_A,
        credentialRefId: anthropic.id,
        expectedVersion: anthropic.version,
      })
      expect(() =>
        a.runtime.resolveHarnessAccount({ harnessId: 'claude-code', operation: 'test' })
      ).toThrow(expect.objectContaining({ code: 'auth_required' }))
    } finally {
      shell.dispose()
    }
  })
})

describe('workspace connection deny-by-default', () => {
  test('every connection operation refuses a foreign scope and unknown body keys', async () => {
    const shell = device()
    try {
      const { authority, handlers } = fakeAuthority()
      registerConnectionsRuntime({
        authority,
        dataDir: shell.dataDir,
        scope: SCOPE_A,
        vault: shell.vault,
      })
      const bodies: Partial<Record<DevOperation, Record<string, unknown>>> = {
        'dev.connections.get': {},
        'dev.connections.setGitHosting': {
          host: 'github.com',
          credentialRefId: null,
          expectedVersion: 0,
        },
        'dev.connections.setHarnessAccount': {
          harnessId: 'pi',
          profileId: null,
          expectedVersion: 0,
        },
        'dev.harness.accountProfiles.list': {},
        'dev.harness.accountProfiles.create': {
          harnessId: 'pi',
          label: 'x',
          credentialRefId: randomUUID(),
        },
        'dev.harness.accountProfiles.delete': { profileId: randomUUID(), expectedVersion: 1 },
      }
      expect([...handlers.keys()].toSorted()).toEqual(Object.keys(bodies).toSorted())
      for (const [operation, body] of Object.entries(bodies) as [DevOperation, object][]) {
        const handler = handlers.get(operation)!
        await expect(
          Promise.resolve().then(() =>
            handler(commandFor(operation, SCOPE_B, body as Record<string, unknown>))
          )
        ).rejects.toMatchObject({ code: 'unauthorized' })
        await expect(
          Promise.resolve().then(() =>
            handler(commandFor(operation, SCOPE_A, { ...body, secret: 'key-material' }))
          )
        ).rejects.toThrow(/unknown key/)
      }
    } finally {
      shell.dispose()
    }
  })
})

describe('connection transport env', () => {
  const secretHolder = {
    reveal: () => GIT_SECRET,
  } as unknown as import('../shell/src/dev-runtime/vault').VaultSecret

  test('git children get a host-scoped inline helper and the token only when bound', () => {
    const env = gitTransportEnv({
      connection: 'workspace',
      host: 'github.com',
      credentialRefId: randomUUID(),
      credentialKind: 'github_token',
      secret: secretHolder,
    })!
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper')
    expect(env.GIT_CONFIG_VALUE_0).toBe('')
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.helper')
    expect(env.ADEA_GIT_CONNECTION_HOST).toBe('github.com')
    // The helper text itself is secret-free; the token rides one variable.
    expect(env.GIT_CONFIG_VALUE_1).not.toContain(GIT_SECRET)
    expect(env.ADEA_GIT_CONNECTION_TOKEN).toBe(GIT_SECRET)
    expect(env.ADEA_GIT_CONNECTION_USERNAME).toBe('x-access-token')
    expect(gitTransportEnv({ connection: 'device_default', host: 'github.com' })).toBeUndefined()
  })

  test('real git answers with the workspace token for the bound host only, never the device helper', async () => {
    const home = mkdtempSync(join(tmpdir(), 'adea-connections-git-home-'))
    try {
      // A device-level helper that would answer every host.
      writeFileSync(
        join(home, '.gitconfig'),
        '[credential]\n\thelper = "!f() { echo username=device; echo password=device-secret; }; f"\n'
      )
      const env = gitTransportEnv({
        connection: 'workspace',
        host: 'github.com',
        credentialRefId: randomUUID(),
        credentialKind: 'github_token',
        secret: secretHolder,
      })!
      const fill = async (host: string, extra?: Record<string, string>) => {
        const proc = Bun.spawn(['git', 'credential', 'fill'], {
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: home,
            GIT_TERMINAL_PROMPT: '0',
            GIT_CONFIG_NOSYSTEM: '1',
            ...extra,
          },
          stdin: new TextEncoder().encode(`protocol=https\nhost=${host}\n\n`),
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const out = await new Response(proc.stdout).text()
        await proc.exited
        return out
      }
      expect(await fill('github.com')).toContain('password=device-secret')
      const bound = await fill('github.com', env)
      expect(bound).toContain(`password=${GIT_SECRET}`)
      expect(bound).toContain('username=x-access-token')
      expect(bound).not.toContain('device-secret')
      // Another host gets neither the token nor the device helper.
      expect(await fill('gitlab.com', env)).not.toContain('password=')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('gh and glab children get their documented token variables', () => {
    const bound = (host: string) =>
      ({
        connection: 'workspace',
        host,
        credentialRefId: randomUUID(),
        credentialKind: 'git_https',
        secret: secretHolder,
      }) as const
    expect(ghTokenEnv(bound('github.com'))).toEqual({ GH_TOKEN: GIT_SECRET })
    expect(ghTokenEnv(bound('ghe.example.com'))).toEqual({
      GH_ENTERPRISE_TOKEN: GIT_SECRET,
      GH_HOST: 'ghe.example.com',
    })
    expect(glabTokenEnv(bound('gitlab.example.com'))).toEqual({
      GITLAB_TOKEN: GIT_SECRET,
      GITLAB_HOST: 'gitlab.example.com',
    })
    expect(ghTokenEnv({ connection: 'device_default', host: 'github.com' })).toBeUndefined()
    expect(hostnameArg(['api', 'user', '--hostname', 'GHE.example.com'])).toBe('ghe.example.com')
    expect(hostnameArg(['api', 'user'])).toBeUndefined()
  })

  test('remote URLs classify into host and transport; local paths have no host', () => {
    expect(parseRemoteTransport('https://github.com/acme/app.git')).toEqual({
      host: 'github.com',
      transport: 'https',
    })
    expect(parseRemoteTransport('https://gitlab.example.com:8443/acme/app.git')).toEqual({
      host: 'gitlab.example.com:8443',
      transport: 'https',
    })
    expect(parseRemoteTransport('git@github.com:acme/app.git')).toEqual({
      host: 'github.com',
      transport: 'ssh',
    })
    expect(parseRemoteTransport('ssh://git@gitlab.com/acme/app.git')).toEqual({
      host: 'gitlab.com',
      transport: 'ssh',
    })
    expect(parseRemoteTransport('/srv/git/app.git')).toBeUndefined()
    expect(parseRemoteTransport('file:///srv/git/app.git')).toBeUndefined()
  })
})
