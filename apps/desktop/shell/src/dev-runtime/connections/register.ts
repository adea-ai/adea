// Workspace connections (ADR 0012 "Connections"): the per-workspace git
// hosting and harness account bindings, the reusable device-wide harness
// account profiles, and the resolution seams every credentialed operation
// goes through.
//
// Authority rules this module owns (everything else already passed the M10
// gate — envelope, capability set, replay, expiry, scope admission):
// - Every operation re-checks the authenticated scope. The binding document is
//   the active scope's own partition; no code path here reads another
//   workspace's partition, so a binding made in workspace A can never be
//   observed, resolved, or borrowed in workspace B.
// - Mutations are optimistic on the document `version` (0 = never written)
//   or the profile `version`; a stale writer loses with `stale_version`.
// - A git hosting binding names a vault reference the ACTIVE scope's vault
//   serves, for the same host, in `ready` state. A harness account profile
//   names a reference whose provider host is one the harness family can use.
// - Resolution with no binding is the device default and is reported as
//   `connection: 'device_default'`; resolution with a binding that cannot be
//   used (revoked, expired, unreadable) fails closed — it never falls back.
// - Every resolution is recorded in the owner-only, secret-free audit trail
//   with the resolved reference id, never the secret.
import { join } from 'node:path'

import type {
  ConnectableHarness,
  DevCommand,
  DevError,
  DevOperation,
  HarnessAccountFamily,
  HarnessAccountProfile,
  Scope,
  WorkspaceConnections,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import { createAuthorityAudit, type AuthorityAudit } from '../audit'
import { newRecordId, nowIso } from '../authority'
import type { ChannelAuthority } from '../channel/authority'
import type { CredentialRefRecord, CredentialVault, VaultSecret } from '../vault'
import {
  CONNECTIONS_STORE_DIRECTORY,
  MAX_ACCOUNT_PROFILES,
  createHarnessAccountProfileStore,
  createWorkspaceConnectionsStore,
  profileOwnerOf,
  sameScope,
  scopeDigest,
  type StoredHarnessAccountProfile,
  type StoredWorkspaceConnections,
} from './store'
import type { GitHostingResolution } from './transport-env'

/** Provider API hosts an account profile may name, and the one environment
 *  variable each delivers its key through (the harness sanitized-env
 *  allowlist admits exactly these keys). */
export const HARNESS_ACCOUNT_PROVIDER_ENV = Object.freeze({
  'api.anthropic.com': 'ANTHROPIC_API_KEY',
  'api.openai.com': 'OPENAI_API_KEY',
} as const)
export type HarnessAccountProviderHost = keyof typeof HARNESS_ACCOUNT_PROVIDER_ENV

/** The closed family table: which provider hosts each harness accepts. */
export const HARNESS_ACCOUNT_HOSTS: Readonly<
  Record<HarnessAccountFamily, readonly HarnessAccountProviderHost[]>
> = Object.freeze({
  'claude-code': ['api.anthropic.com'],
  codex: ['api.openai.com'],
  opencode: ['api.anthropic.com', 'api.openai.com'],
  pi: ['api.anthropic.com', 'api.openai.com'],
})

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/
const MAX_PAGE_LIMIT = 500
const DEFAULT_PAGE_LIMIT = 100
const AUDIT_DEDUPE_WINDOW_MS = 60_000
const AUDIT_DEDUPE_MAX_KEYS = 256

export type HarnessAccountResolution =
  | Readonly<{ connection: 'device_default'; harnessId: HarnessAccountFamily }>
  | Readonly<{
      connection: 'workspace'
      harnessId: HarnessAccountFamily
      profileId: string
      profileVersion: number
      /** The sanitized-env key the secret is delivered through. */
      envKey: string
      /** Unseals the vaulted key. Call only at the spawn seam, once. */
      readSecret(): VaultSecret
    }>

export type DiscoveredHarness = Readonly<{ harnessId: HarnessAccountFamily; displayName: string }>

export type ConnectionsRuntime = Readonly<{
  commands: readonly DevOperation[]
  /** The active workspace's git hosting resolution for one remote host. */
  resolveGitHosting(input: {
    host: string
    operation: string
    transport?: 'https' | 'ssh'
  }): GitHostingResolution
  /** The active workspace's harness account resolution for one family. */
  resolveHarnessAccount(input: { harnessId: string; operation: string }): HarnessAccountResolution
}>

function devError(code: DevError['code'], message: string, currentVersion?: number): DevError {
  return {
    code,
    retryable: false,
    message,
    ...(currentVersion !== undefined ? { currentVersion } : {}),
  } as DevError
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function toProfileDto(profile: StoredHarnessAccountProfile): HarnessAccountProfile {
  return {
    id: profile.id,
    harnessId: profile.harnessId,
    label: profile.label,
    credentialRefId: profile.credentialRefId,
    version: profile.version,
  }
}

export function registerConnectionsRuntime(input: {
  authority: ChannelAuthority
  dataDir: string
  scope: Scope
  vault: CredentialVault
  /** Families the runtime node can launch (discovery + managed Pi). */
  discoveredHarnesses?: () => readonly DiscoveredHarness[]
  audit?: AuthorityAudit
  publish?: (event: string, payload: unknown) => void
  now?: () => number
}): ConnectionsRuntime {
  const now = input.now ?? Date.now
  const documents = createWorkspaceConnectionsStore({ dataDir: input.dataDir, scope: input.scope })
  const profiles = createHarnessAccountProfileStore({ dataDir: input.dataDir })
  const owner = profileOwnerOf(input.scope)
  const digest = scopeDigest(input.scope)
  const audit =
    input.audit ??
    createAuthorityAudit({
      file: join(input.dataDir, CONNECTIONS_STORE_DIRECTORY, `audit-${digest}.jsonl`),
    })
  const recentAudit = new Map<string, number>()

  function iso(): string {
    return new Date(now()).toISOString()
  }

  function requireScope(command: DevCommand): void {
    if (!sameScope(command.scope, input.scope))
      throw devError('unauthorized', 'workspace connections scope is not authorized')
  }

  /** Secret-free audit; resolution entries for the same facts are coalesced
   *  inside a short window so read-model polling cannot grow the trail
   *  without bound. Mutations always record. */
  function record(
    action: string,
    subjectId: string,
    outcome: 'granted' | 'denied' | 'revoked' | 'failed',
    detail: Record<string, string>,
    coalesce = false
  ): void {
    if (coalesce) {
      const key = JSON.stringify([action, subjectId, outcome, detail])
      const at = now()
      const last = recentAudit.get(key)
      if (last !== undefined && at - last < AUDIT_DEDUPE_WINDOW_MS) return
      if (recentAudit.size >= AUDIT_DEDUPE_MAX_KEYS) recentAudit.clear()
      recentAudit.set(key, at)
    }
    audit.append({ action, subjectId, outcome, detail: { workspace: digest, ...detail } })
  }

  function ownProfiles(all: readonly StoredHarnessAccountProfile[]) {
    return all.filter(
      (profile) =>
        profile.owner.accountId === owner.accountId &&
        profile.owner.runtimeNodeId === owner.runtimeNodeId
    )
  }

  function availableHarnesses(): ConnectableHarness[] {
    const seen = new Set<string>()
    const harnesses: ConnectableHarness[] = []
    for (const entry of input.discoveredHarnesses?.() ?? []) {
      if (seen.has(entry.harnessId)) continue
      seen.add(entry.harnessId)
      harnesses.push({
        harnessId: entry.harnessId,
        displayName: entry.displayName.slice(0, 128) || entry.harnessId,
        accountHosts: [...HARNESS_ACCOUNT_HOSTS[entry.harnessId]],
      })
    }
    return harnesses.toSorted((left, right) => left.harnessId.localeCompare(right.harnessId))
  }

  function view(document: StoredWorkspaceConnections): WorkspaceConnections {
    return {
      scope: { ...input.scope },
      gitHosting: document.gitHosting.map((binding) => ({ ...binding })),
      harnessAccounts: document.harnessAccounts.map((binding) => ({ ...binding })),
      version: document.version,
      availableHarnesses: availableHarnesses(),
    }
  }

  function requireDocumentVersion(
    document: StoredWorkspaceConnections,
    expectedVersion: number
  ): void {
    if (document.version !== expectedVersion)
      throw devError(
        'stale_version',
        `workspace connections moved on: version ${document.version}`,
        document.version
      )
  }

  function requireHost(host: string): string {
    if (!HOST_PATTERN.test(host))
      throw devError('invalid_state', 'git hosting host must be a bare lowercase hostname')
    return host
  }

  /** A reference the ACTIVE scope's vault serves; foreign ids read as absent. */
  function credentialIn(scope: Scope, credentialRefId: string): CredentialRefRecord {
    try {
      return input.vault.get({ scope, credentialRefId })
    } catch {
      throw devError('not_found', 'credential reference not found')
    }
  }

  function requireReady(credential: CredentialRefRecord, what: string): void {
    if (credential.state !== 'ready')
      throw devError('invalid_state', `${what} credential reference is ${credential.state}`)
  }

  function nextDocument(
    document: StoredWorkspaceConnections,
    patch: Pick<StoredWorkspaceConnections, 'gitHosting' | 'harnessAccounts'>
  ): StoredWorkspaceConnections {
    return {
      scope: { ...input.scope },
      gitHosting: [...patch.gitHosting].toSorted((left, right) =>
        left.host.localeCompare(right.host)
      ),
      harnessAccounts: [...patch.harnessAccounts].toSorted((left, right) =>
        left.harnessId.localeCompare(right.harnessId)
      ),
      version: document.version + 1,
      updatedAt: iso(),
    }
  }

  function updateBinders(
    all: readonly StoredHarnessAccountProfile[],
    profileId: string,
    change: 'add' | 'remove'
  ): StoredHarnessAccountProfile[] {
    return all.map((profile) => {
      if (profile.id !== profileId) return profile
      const binders = new Set(profile.boundBy)
      if (change === 'add') binders.add(digest)
      else binders.delete(digest)
      return { ...profile, boundBy: [...binders].toSorted() }
    })
  }

  const providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>> = {
    'dev.connections.get': (command) => {
      requireScope(command)
      devOperationDecoders['dev.connections.get'].request(command.body)
      return view(documents.read())
    },

    'dev.connections.setGitHosting': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.connections.setGitHosting'].request(command.body)
      const host = requireHost(body.host as string)
      const credentialRefId = body.credentialRefId as string | null
      const document = documents.read()
      requireDocumentVersion(document, body.expectedVersion as number)
      const current = document.gitHosting.find((binding) => binding.host === host)
      if (credentialRefId !== null) {
        const credential = credentialIn(input.scope, credentialRefId)
        requireReady(credential, 'the git hosting')
        if (credential.host.toLowerCase() !== host)
          throw devError('identity_mismatch', 'the credential belongs to another host')
        if (credential.kind === 'ssh_key')
          throw devError(
            'incompatible',
            'an SSH key cannot be delivered as a token; SSH remotes use the device SSH agent'
          )
      }
      if ((current?.credentialRefId ?? null) === credentialRefId) return view(document)
      const others = document.gitHosting.filter((binding) => binding.host !== host)
      const next = nextDocument(document, {
        gitHosting: credentialRefId === null ? others : [...others, { host, credentialRefId }],
        harnessAccounts: document.harnessAccounts,
      })
      documents.write(next)
      record(
        credentialRefId === null
          ? 'connections.git_hosting.cleared'
          : 'connections.git_hosting.bound',
        `git_hosting:${host}`,
        credentialRefId === null ? 'revoked' : 'granted',
        { host, ...(credentialRefId !== null ? { refId: credentialRefId } : {}) }
      )
      input.publish?.('connections.updated', { version: next.version })
      return view(next)
    },

    'dev.connections.setHarnessAccount': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.connections.setHarnessAccount'].request(command.body)
      const harnessId = body.harnessId as HarnessAccountFamily
      const profileId = body.profileId as string | null
      const document = documents.read()
      requireDocumentVersion(document, body.expectedVersion as number)
      const current = document.harnessAccounts.find((binding) => binding.harnessId === harnessId)
      let all = profiles.load()
      if (profileId !== null) {
        const profile = ownProfiles(all).find((entry) => entry.id === profileId)
        if (!profile) throw devError('not_found', 'harness account profile not found')
        if (profile.harnessId !== harnessId)
          throw devError('identity_mismatch', 'the profile belongs to another harness')
        requireReady(credentialIn(profile.credentialScope, profile.credentialRefId), 'the account')
      }
      if ((current?.profileId ?? null) === profileId) return view(document)
      // Index first, binding second, unindex last: an interruption can only
      // leave the reverse index a superset, which refuses a delete (safe).
      if (profileId !== null) {
        all = updateBinders(all, profileId, 'add')
        profiles.save(all)
      }
      const others = document.harnessAccounts.filter((binding) => binding.harnessId !== harnessId)
      const next = nextDocument(document, {
        gitHosting: document.gitHosting,
        harnessAccounts: profileId === null ? others : [...others, { harnessId, profileId }],
      })
      documents.write(next)
      if (current) {
        const stillBound = next.harnessAccounts.some(
          (binding) => binding.profileId === current.profileId
        )
        if (!stillBound) profiles.save(updateBinders(profiles.load(), current.profileId, 'remove'))
      }
      record(
        profileId === null
          ? 'connections.harness_account.cleared'
          : 'connections.harness_account.bound',
        `harness_account:${harnessId}`,
        profileId === null ? 'revoked' : 'granted',
        { harnessId, ...(profileId !== null ? { profileId } : {}) }
      )
      input.publish?.('connections.updated', { version: next.version })
      return view(next)
    },

    'dev.harness.accountProfiles.list': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.harness.accountProfiles.list'].request(command.body)
      const pageSize = (body.limit as number | undefined) ?? DEFAULT_PAGE_LIMIT
      if (pageSize > MAX_PAGE_LIMIT) throw devError('limit_exceeded', 'limit exceeds 500')
      let start = 0
      if (typeof body.cursor === 'string') {
        const decoded = Number(Buffer.from(body.cursor, 'base64url').toString('utf8'))
        if (!Number.isSafeInteger(decoded) || decoded < 0)
          throw devError('not_found', 'unknown listing cursor')
        start = decoded
      }
      const filtered = ownProfiles(profiles.load())
        .filter((profile) => body.harnessId === undefined || profile.harnessId === body.harnessId)
        .toSorted(
          (left, right) =>
            left.harnessId.localeCompare(right.harnessId) ||
            left.label.localeCompare(right.label) ||
            left.id.localeCompare(right.id)
        )
      const items = filtered.slice(start, start + pageSize).map(toProfileDto)
      const nextCursor =
        start + pageSize < filtered.length
          ? Buffer.from(String(start + pageSize)).toString('base64url')
          : undefined
      return { items, ...(nextCursor ? { nextCursor } : {}), observedAt: iso() }
    },

    'dev.harness.accountProfiles.create': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.harness.accountProfiles.create'].request(command.body)
      const harnessId = body.harnessId as HarnessAccountFamily
      const label = (body.label as string).trim()
      if (label.length < 1 || label.length > 80 || hasControlCharacter(label))
        throw devError('invalid_state', 'profile label must be 1..80 printable characters')
      const credentialRefId = body.credentialRefId as string
      const credential = credentialIn(input.scope, credentialRefId)
      requireReady(credential, 'the account')
      const providerHost = credential.host.toLowerCase()
      if (!(HARNESS_ACCOUNT_HOSTS[harnessId] as readonly string[]).includes(providerHost))
        throw devError(
          'identity_mismatch',
          `a ${harnessId} account must name a ${HARNESS_ACCOUNT_HOSTS[harnessId].join(' or ')} credential`
        )
      if (credential.kind === 'ssh_key')
        throw devError('incompatible', 'an SSH key cannot be used as a harness account')
      const all = profiles.load()
      const mine = ownProfiles(all)
      const sameLabel = mine.find(
        (profile) => profile.harnessId === harnessId && profile.label === label
      )
      if (sameLabel) {
        if (sameLabel.credentialRefId === credentialRefId) return toProfileDto(sameLabel)
        throw devError('name_collision', 'a profile with this label already exists for the harness')
      }
      if (all.length >= MAX_ACCOUNT_PROFILES)
        throw devError('limit_exceeded', `at most ${MAX_ACCOUNT_PROFILES} account profiles`)
      const profile: StoredHarnessAccountProfile = {
        id: newRecordId(),
        owner,
        harnessId,
        label,
        credentialRefId,
        credentialScope: { ...input.scope },
        version: 1,
        createdAt: nowIso(),
        boundBy: [],
      }
      profiles.save([...all, profile])
      record('connections.account_profile.created', profile.id, 'granted', {
        harnessId,
        refId: credentialRefId,
      })
      return toProfileDto(profile)
    },

    'dev.harness.accountProfiles.delete': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.harness.accountProfiles.delete'].request(command.body)
      const all = profiles.load()
      const profile = ownProfiles(all).find((entry) => entry.id === body.profileId)
      if (!profile) throw devError('not_found', 'harness account profile not found')
      if (profile.version !== body.expectedVersion)
        throw devError(
          'stale_version',
          `harness account profile moved on: version ${profile.version}`,
          profile.version
        )
      if (profile.boundBy.length > 0)
        throw devError(
          'invalid_state',
          `the profile is bound by ${profile.boundBy.length} workspace(s) on this device; unbind it first`
        )
      profiles.save(all.filter((entry) => entry.id !== profile.id))
      record('connections.account_profile.deleted', profile.id, 'revoked', {
        harnessId: profile.harnessId,
      })
      return toProfileDto(profile)
    },
  }

  for (const [operation, provider] of Object.entries(providers)) {
    input.authority.registerCommandProvider(operation as DevOperation, async (command) =>
      provider!(command)
    )
  }

  function resolveGitHosting(request: {
    host: string
    operation: string
    transport?: 'https' | 'ssh'
  }): GitHostingResolution {
    const host = request.host.toLowerCase()
    const binding = documents.read().gitHosting.find((entry) => entry.host === host)
    if (!binding || request.transport === 'ssh') {
      record(
        'connections.git_hosting.resolved',
        `git_hosting:${host}`,
        'granted',
        {
          host,
          connection: 'device_default',
          operation: request.operation,
          ...(binding ? { transport: 'ssh' } : {}),
        },
        true
      )
      return { connection: 'device_default', host }
    }
    let credential: CredentialRefRecord
    let secret: VaultSecret
    try {
      credential = input.vault.get({ scope: input.scope, credentialRefId: binding.credentialRefId })
      if (credential.state !== 'ready')
        throw devError(
          'auth_required',
          `the workspace git hosting connection for ${host} is ${credential.state}; rebind it in Workspace settings`
        )
      secret = input.vault.resolve({
        scope: input.scope,
        credentialRefId: binding.credentialRefId,
        audience: 'runtime_driver',
      })
    } catch (error) {
      record('connections.git_hosting.resolved', `git_hosting:${host}`, 'failed', {
        host,
        connection: 'workspace',
        refId: binding.credentialRefId,
        operation: request.operation,
      })
      if (typeof error === 'object' && error !== null && 'code' in error && 'retryable' in error)
        throw error
      throw devError(
        'auth_required',
        `the workspace git hosting connection for ${host} cannot be used; rebind it in Workspace settings`
      )
    }
    record(
      'connections.git_hosting.resolved',
      `git_hosting:${host}`,
      'granted',
      {
        host,
        connection: 'workspace',
        refId: binding.credentialRefId,
        operation: request.operation,
      },
      true
    )
    return {
      connection: 'workspace',
      host,
      credentialRefId: binding.credentialRefId,
      credentialKind: credential.kind,
      secret,
    }
  }

  function resolveHarnessAccount(request: {
    harnessId: string
    operation: string
  }): HarnessAccountResolution {
    const harnessId = request.harnessId as HarnessAccountFamily
    const binding = documents.read().harnessAccounts.find((entry) => entry.harnessId === harnessId)
    if (!binding || !(harnessId in HARNESS_ACCOUNT_HOSTS)) {
      record(
        'connections.harness_account.resolved',
        `harness_account:${request.harnessId}`,
        'granted',
        {
          harnessId: request.harnessId,
          connection: 'device_default',
          operation: request.operation,
        },
        true
      )
      return { connection: 'device_default', harnessId }
    }
    const fail = (message: string): never => {
      record('connections.harness_account.resolved', `harness_account:${harnessId}`, 'failed', {
        harnessId,
        connection: 'workspace',
        profileId: binding.profileId,
        operation: request.operation,
      })
      throw devError('auth_required', message)
    }
    const profile = ownProfiles(profiles.load()).find((entry) => entry.id === binding.profileId)
    if (!profile || profile.harnessId !== harnessId)
      return fail(`the ${harnessId} account bound to this workspace no longer exists`)
    let credential: CredentialRefRecord
    try {
      credential = input.vault.get({
        scope: profile.credentialScope,
        credentialRefId: profile.credentialRefId,
      })
    } catch {
      return fail(`the ${harnessId} account credential no longer exists`)
    }
    if (credential.state !== 'ready')
      return fail(`the ${harnessId} account credential is ${credential.state}`)
    const providerHost = credential.host.toLowerCase() as HarnessAccountProviderHost
    if (!(HARNESS_ACCOUNT_HOSTS[harnessId] as readonly string[]).includes(providerHost))
      return fail(`the ${harnessId} account names a provider the harness cannot use`)
    record(
      'connections.harness_account.resolved',
      `harness_account:${harnessId}`,
      'granted',
      {
        harnessId,
        connection: 'workspace',
        profileId: profile.id,
        refId: profile.credentialRefId,
        operation: request.operation,
      },
      true
    )
    const credentialScope = profile.credentialScope
    const credentialRefId = profile.credentialRefId
    return {
      connection: 'workspace',
      harnessId,
      profileId: profile.id,
      profileVersion: profile.version,
      envKey: HARNESS_ACCOUNT_PROVIDER_ENV[providerHost],
      readSecret: () =>
        input.vault.resolve({
          scope: credentialScope,
          credentialRefId,
          audience: 'runtime_driver',
        }),
    }
  }

  return Object.freeze({
    commands: Object.keys(providers) as DevOperation[],
    resolveGitHosting,
    resolveHarnessAccount,
  })
}
