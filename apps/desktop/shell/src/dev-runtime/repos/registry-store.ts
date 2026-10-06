// The one repository registry store (ADR 0011, "The primary checkout is a
// worktree record"). `dev-runtime/repos/registry.json` is the single durable
// authority for repository records: the `dev.repo.*` providers prove and
// persist records here, and the worktree service reads (and, for the
// test/script `registerRepo` seam, writes) the same file. The former
// worktree-private `dev-runtime/worktrees/repos.json` is left unread on disk.
import { join } from 'node:path'

import type {
  RedactedRemote,
  Repo,
  RepoLayout,
} from '../../../../../../packages/types/src/dev-runtime'
import { DevAuthorityError, type DevScope } from '../authority'
import { createDurableJsonStore } from '../host-store'
import type { FileIdentityValue } from '../worktrees/identity'

/**
 * The registry store record. `remote` keeps the raw configured origin URL so
 * canonical identity can be re-proven later; every DTO redacts it
 * (`redactRemoteUrl`) and the secret never enters a reply, event, or log.
 * `fetchRemote` is the configured remote NAME the worktree service fetches
 * the base from (`origin` for adopted repositories). `lifecycle` is durable
 * repo truth: `ready` (proven), `stale` (the remote could not be re-proven at
 * the last refresh), `unavailable` (the canonical root was missing on disk at
 * the last refresh). `layout: 'bare_managed'` marks a remote-only project's
 * managed bare clone (ADR 0011): its `canonicalRoot` is the bare repository
 * under the owner-only managed root (and also its git common dir), it has no
 * primary working tree, and it carries no `rootBookmarkId` — every other
 * record names the bookmark that proves it.
 */
export type RepoRegistryRecord = Readonly<{
  id: string
  scope: DevScope
  kind: 'git' | 'folder'
  lifecycle: 'ready' | 'stale' | 'unavailable'
  canonicalRoot: string
  layout?: RepoLayout
  rootIdentity: FileIdentityValue
  gitCommonDirIdentity?: FileIdentityValue
  rootBookmarkId?: string
  remote?: string
  fetchRemote?: string
  defaultRef?: string
  credentialRefId?: string
  projectIds: readonly string[]
  version: number
  updatedAt: string
}>

export const REPO_REGISTRY_STORE_FILE = join('dev-runtime', 'repos', 'registry.json')
const REPO_REGISTRY_SCHEMA_VERSION = 1

const corruptRecord = () =>
  new DevAuthorityError('corrupt_state', 'repository registry record failed to decode')

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/** Structural decode of a stored record; anything else is `corrupt_state`. */
function validateStoredRecord(record: RepoRegistryRecord): void {
  if (
    typeof record !== 'object' ||
    record === null ||
    typeof record.id !== 'string' ||
    (record.kind !== 'git' && record.kind !== 'folder') ||
    (record.lifecycle !== 'ready' &&
      record.lifecycle !== 'stale' &&
      record.lifecycle !== 'unavailable') ||
    typeof record.canonicalRoot !== 'string' ||
    record.canonicalRoot.length < 1 ||
    (record.layout !== undefined && record.layout !== 'bare_managed') ||
    (record.layout === 'bare_managed'
      ? record.kind !== 'git' || record.rootBookmarkId !== undefined
      : typeof record.rootBookmarkId !== 'string') ||
    (record.fetchRemote !== undefined && typeof record.fetchRemote !== 'string') ||
    !Array.isArray(record.projectIds) ||
    record.projectIds.some((id) => typeof id !== 'string') ||
    !isPositiveInteger(record.version) ||
    typeof record.updatedAt !== 'string' ||
    typeof record.rootIdentity?.mtimeNs !== 'string' ||
    typeof record.rootIdentity?.size !== 'string'
  )
    throw corruptRecord()
}

export function createRepoRegistryStore(dataDir: string) {
  const store = createDurableJsonStore<RepoRegistryRecord>({
    file: join(dataDir, REPO_REGISTRY_STORE_FILE),
    schemaVersion: REPO_REGISTRY_SCHEMA_VERSION,
    label: 'repository registry',
  })

  function load(): RepoRegistryRecord[] {
    const records = [...store.load().records]
    for (const record of records) validateStoredRecord(record)
    return records
  }

  function save(records: readonly RepoRegistryRecord[]): void {
    store.save([...records])
  }

  function find(repoId: string): RepoRegistryRecord | undefined {
    return load().find((entry) => entry.id === repoId)
  }

  /** Drop one record (a managed clone after its proven deletion). */
  function remove(repoId: string): void {
    save(load().filter((entry) => entry.id !== repoId))
  }

  function upsert(next: RepoRegistryRecord): void {
    const records = load()
    const index = records.findIndex((entry) => entry.id === next.id)
    if (index >= 0) records[index] = next
    else records.push(next)
    save(records)
  }

  return Object.freeze({ load, save, find, upsert, remove })
}

export type RepoRegistryStore = ReturnType<typeof createRepoRegistryStore>

/** Remote URLs are redacted before any DTO: embedded user-info is removed
 *  while full nested namespace paths are preserved. SCP-like remotes
 *  (`git@host:owner/repo.git`) are parsed structurally, never with a shell;
 *  an unparseable remote redacts to an `unknown` host rather than guessing. */
export function redactRemoteUrl(remote: string): RedactedRemote {
  const trimmed = remote.trim()
  const scpLike = /^([^@\s]+)@([^@\s:]+):(.+)$/.exec(trimmed)
  let host: string
  let ownerPath: string
  let displayUrl: string
  if (scpLike) {
    host = (scpLike[2] ?? '').toLowerCase()
    ownerPath = (scpLike[3] ?? '').replace(/\.git$/, '')
    displayUrl = `${scpLike[2] ?? ''}:${ownerPath}`
  } else {
    try {
      const parsed = new URL(trimmed)
      host = parsed.host !== '' ? parsed.host.toLowerCase() : 'unknown'
      ownerPath = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '')
      displayUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\.git$/, '')
    } catch {
      host = 'unknown'
      ownerPath = ''
      displayUrl = ''
    }
  }
  const provider =
    host === 'github.com' || host.endsWith('.github.com')
      ? 'github'
      : host === 'gitlab.com' || host.endsWith('.gitlab.com')
        ? 'gitlab'
        : 'other'
  return { provider, host, ownerPath, displayUrl }
}

/** The strict `Repo` DTO for a registry record (remote redacted). */
export function toRepoDto(record: RepoRegistryRecord): Repo {
  const remote = record.remote !== undefined ? redactRemoteUrl(record.remote) : undefined
  return {
    id: record.id,
    scope: record.scope,
    kind: record.kind,
    lifecycle: record.lifecycle,
    canonicalRoot: record.canonicalRoot,
    ...(record.layout !== undefined ? { layout: record.layout } : {}),
    ...(record.gitCommonDirIdentity !== undefined
      ? { gitCommonDirIdentity: record.gitCommonDirIdentity }
      : {}),
    ...(remote !== undefined ? { remote } : {}),
    ...(record.defaultRef !== undefined ? { defaultRef: record.defaultRef } : {}),
    projectIds: [...record.projectIds],
    version: record.version,
  }
}
