// Workspace connection stores (ADR 0012 "Connections").
//
// Two owner-only, schema-versioned, fail-closed stores on the shared atomic
// JSON store (temp file + fsync + rename, `.corrupt-<time>` retention on an
// unreadable envelope):
//
// - The per-workspace binding document lives in the workspace's Dev scope
//   partition: `dev-runtime/connections/workspace-<sha256(scope)>.json`. One
//   file belongs to one `(accountId, workspaceId, runtimeNodeId)` scope, so a
//   workspace switch never opens, reads, or overwrites another workspace's
//   bindings, and a stored record that names any other scope is corrupt state.
// - Harness account profiles are reusable, so they live device-wide in
//   `dev-runtime/connections/harness-account-profiles.json`, owned by the local
//   `(accountId, runtimeNodeId)` pair. Each profile keeps a reverse index of the
//   scope digests that bind it, so a delete can be refused while any workspace
//   on this device still binds the profile — without opening any other
//   workspace's partition.
//
// Both stores hold ids only. Secret material never enters either file.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

import type {
  GitHostingBinding,
  HarnessAccountBinding,
  HarnessAccountFamily,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import {
  decodeHarnessAccountProfile,
  decodeWorkspaceConnections,
  harnessAccountFamilies,
} from '../../../../../../packages/types/src/dev-runtime-registry-dto'
import { createDurableJsonStore } from '../host-store'

export const CONNECTIONS_STORE_DIRECTORY = join('dev-runtime', 'connections')
const SCHEMA_VERSION = 1
/** Bounded like every store: profiles per device and binders per profile. */
export const MAX_ACCOUNT_PROFILES = 256
const MAX_BINDERS_PER_PROFILE = 1024
const SCOPE_DIGEST_PATTERN = /^[0-9a-f]{64}$/

export type ConnectionsStoreError = Readonly<{
  code: 'corrupt_state'
  retryable: true
  message: string
}>

function corrupt(label: string): ConnectionsStoreError {
  return { code: 'corrupt_state', retryable: true, message: `${label} failed strict decode` }
}

/** The partition key of one scope: sha256 over the canonical scope triple. */
export function scopeDigest(scope: Scope): string {
  return createHash('sha256')
    .update(JSON.stringify([scope.accountId, scope.workspaceId, scope.runtimeNodeId]))
    .digest('hex')
}

export function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function decodeStoredScope(value: unknown): Scope | undefined {
  if (!isRecord(value) || !exactKeys(value, ['accountId', 'workspaceId', 'runtimeNodeId']))
    return undefined
  const { accountId, workspaceId, runtimeNodeId } = value
  if (
    typeof accountId !== 'string' ||
    typeof workspaceId !== 'string' ||
    typeof runtimeNodeId !== 'string' ||
    accountId.length === 0 ||
    workspaceId.length === 0 ||
    runtimeNodeId.length === 0
  )
    return undefined
  return { accountId, workspaceId, runtimeNodeId }
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
}

// ── Per-workspace binding document ────────────────────────────────────────

export type StoredWorkspaceConnections = Readonly<{
  scope: Scope
  gitHosting: readonly GitHostingBinding[]
  harnessAccounts: readonly HarnessAccountBinding[]
  version: number
  updatedAt: string
}>

export type WorkspaceConnectionsStore = Readonly<{
  /** The scope's document; version 0 with no bindings when never written. */
  read(): StoredWorkspaceConnections
  write(next: StoredWorkspaceConnections): void
}>

export function workspaceConnectionsFile(dataDir: string, scope: Scope): string {
  return join(dataDir, CONNECTIONS_STORE_DIRECTORY, `workspace-${scopeDigest(scope)}.json`)
}

function decodeStoredConnections(value: unknown, scope: Scope): StoredWorkspaceConnections {
  const label = 'workspace connections'
  if (
    !isRecord(value) ||
    !exactKeys(value, ['scope', 'gitHosting', 'harnessAccounts', 'version', 'updatedAt'])
  )
    throw corrupt(label)
  const storedScope = decodeStoredScope(value.scope)
  // A partition that names another scope is never trusted, never repaired.
  if (!storedScope || !sameScope(storedScope, scope)) throw corrupt(label)
  if (!isTimestamp(value.updatedAt)) throw corrupt(label)
  try {
    decodeWorkspaceConnections({
      scope: storedScope,
      gitHosting: value.gitHosting,
      harnessAccounts: value.harnessAccounts,
      version: value.version,
      availableHarnesses: [],
    })
  } catch {
    throw corrupt(label)
  }
  if ((value.version as number) < 1) throw corrupt(label)
  return {
    scope: storedScope,
    gitHosting: (value.gitHosting as GitHostingBinding[]).map((binding) => ({
      host: binding.host,
      credentialRefId: binding.credentialRefId,
    })),
    harnessAccounts: (value.harnessAccounts as HarnessAccountBinding[]).map((binding) => ({
      harnessId: binding.harnessId,
      profileId: binding.profileId,
    })),
    version: value.version as number,
    updatedAt: value.updatedAt,
  }
}

export function createWorkspaceConnectionsStore(input: {
  dataDir: string
  scope: Scope
}): WorkspaceConnectionsStore {
  const store = createDurableJsonStore<StoredWorkspaceConnections>({
    file: workspaceConnectionsFile(input.dataDir, input.scope),
    schemaVersion: SCHEMA_VERSION,
    label: 'workspace connections',
  })
  return Object.freeze({
    read() {
      const { records } = store.load()
      if (records.length === 0) {
        return {
          scope: { ...input.scope },
          gitHosting: [],
          harnessAccounts: [],
          version: 0,
          updatedAt: new Date(0).toISOString(),
        }
      }
      if (records.length !== 1) throw corrupt('workspace connections')
      return decodeStoredConnections(records[0], input.scope)
    },
    write(next) {
      const decoded = decodeStoredConnections(next, input.scope)
      store.save([decoded])
    },
  })
}

// ── Device-wide harness account profiles ──────────────────────────────────

/** The device owner of a profile: the local account on this runtime node. */
export type ProfileOwner = Readonly<{ accountId: string; runtimeNodeId: string }>

export type StoredHarnessAccountProfile = Readonly<{
  id: string
  owner: ProfileOwner
  harnessId: HarnessAccountFamily
  label: string
  credentialRefId: string
  /** The vault partition that holds the referenced credential. */
  credentialScope: Scope
  version: number
  createdAt: string
  /** Reverse index: digests of the scopes on this device that bind it. */
  boundBy: readonly string[]
}>

export function profileOwnerOf(scope: Scope): ProfileOwner {
  return { accountId: scope.accountId, runtimeNodeId: scope.runtimeNodeId }
}

function decodeStoredProfile(value: unknown): StoredHarnessAccountProfile {
  const label = 'harness account profiles'
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'id',
      'owner',
      'harnessId',
      'label',
      'credentialRefId',
      'credentialScope',
      'version',
      'createdAt',
      'boundBy',
    ])
  )
    throw corrupt(label)
  const owner = value.owner
  if (
    !isRecord(owner) ||
    !exactKeys(owner, ['accountId', 'runtimeNodeId']) ||
    typeof owner.accountId !== 'string' ||
    typeof owner.runtimeNodeId !== 'string' ||
    owner.accountId.length === 0 ||
    owner.runtimeNodeId.length === 0
  )
    throw corrupt(label)
  const credentialScope = decodeStoredScope(value.credentialScope)
  if (
    !credentialScope ||
    credentialScope.accountId !== owner.accountId ||
    credentialScope.runtimeNodeId !== owner.runtimeNodeId
  )
    throw corrupt(label)
  try {
    decodeHarnessAccountProfile({
      id: value.id,
      harnessId: value.harnessId,
      label: value.label,
      credentialRefId: value.credentialRefId,
      version: value.version,
    })
  } catch {
    throw corrupt(label)
  }
  if (!isTimestamp(value.createdAt)) throw corrupt(label)
  const boundBy = value.boundBy
  if (
    !Array.isArray(boundBy) ||
    boundBy.length > MAX_BINDERS_PER_PROFILE ||
    !boundBy.every((digest) => typeof digest === 'string' && SCOPE_DIGEST_PATTERN.test(digest)) ||
    new Set(boundBy).size !== boundBy.length
  )
    throw corrupt(label)
  return {
    id: value.id as string,
    owner: { accountId: owner.accountId, runtimeNodeId: owner.runtimeNodeId },
    harnessId: value.harnessId as HarnessAccountFamily,
    label: value.label as string,
    credentialRefId: value.credentialRefId as string,
    credentialScope,
    version: value.version as number,
    createdAt: value.createdAt,
    boundBy: [...(boundBy as string[])].toSorted(),
  }
}

function decodeStoredProfiles(records: readonly unknown[]): StoredHarnessAccountProfile[] {
  if (records.length > MAX_ACCOUNT_PROFILES) throw corrupt('harness account profiles')
  const ids = new Set<string>()
  return records.map((record) => {
    const profile = decodeStoredProfile(record)
    if (ids.has(profile.id)) throw corrupt('harness account profiles')
    ids.add(profile.id)
    return profile
  })
}

export type HarnessAccountProfileStore = Readonly<{
  /** Every decoded profile on this device (all owners); callers filter. */
  load(): StoredHarnessAccountProfile[]
  save(records: readonly StoredHarnessAccountProfile[]): void
}>

export function createHarnessAccountProfileStore(input: {
  dataDir: string
}): HarnessAccountProfileStore {
  const store = createDurableJsonStore<StoredHarnessAccountProfile>({
    file: join(input.dataDir, CONNECTIONS_STORE_DIRECTORY, 'harness-account-profiles.json'),
    schemaVersion: SCHEMA_VERSION,
    label: 'harness account profiles',
  })
  return Object.freeze({
    load: () => decodeStoredProfiles(store.load().records),
    save: (records) => store.save(decodeStoredProfiles(records)),
  })
}

/** Removes one workspace's bindings and reverse links, never reusable
 * account profiles or their vaulted secrets. Safe to repeat after a crash. */
export function detachWorkspaceConnections(input: { dataDir: string; scope: Scope }): void {
  const bindings = createWorkspaceConnectionsStore(input)
  bindings.read() // Validate the partition before touching shared state.
  const profiles = createHarnessAccountProfileStore(input)
  const digest = scopeDigest(input.scope)
  const next = profiles.load().map((profile) =>
    profile.boundBy.includes(digest)
      ? {
          ...profile,
          boundBy: profile.boundBy.filter((id) => id !== digest),
          version: profile.version + 1,
        }
      : profile
  )
  profiles.save(next)
  rmSync(workspaceConnectionsFile(input.dataDir, input.scope), { force: true })
  rmSync(join(input.dataDir, CONNECTIONS_STORE_DIRECTORY, `audit-${digest}.jsonl`), { force: true })
}

export function isHarnessAccountFamily(value: unknown): value is HarnessAccountFamily {
  return (harnessAccountFamilies as readonly unknown[]).includes(value)
}
