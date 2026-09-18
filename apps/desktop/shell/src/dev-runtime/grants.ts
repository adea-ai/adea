// M10 #34: scoped project grant authority.
//
// A LocalProjectGrant is the durable record binding one project to one
// authorized root — optionally one vault credential reference — inside one
// account/workspace/runtime-node scope. Creation revalidates every referenced
// authority fail-closed at grant time (roots.validate marks drift, vault state
// must be ready), duplicates of a live grant are idempotent, and revocation is
// version-checked and terminal until the owner explicitly re-grants.
import { join } from 'node:path'

import {
  DevAuthorityError,
  isUuid,
  newRecordId,
  nowIso,
  requireApproval,
  sameScope,
  type DevScope,
  type OwnerApproval,
} from './authority'
import type { AuthorityAudit } from './audit'
import { createDurableJsonStore } from './host-store'
import type { RootBookmarkAuthority } from './roots'
import type { CredentialRefState, CredentialVault } from './vault'

export type ProjectGrantRecord = Readonly<{
  id: string
  scope: DevScope
  projectId: string
  rootBookmarkId: string
  credentialRefId?: string
  state: 'active' | 'revoked'
  generation: number
  version: number
  createdAt: string
  revokedAt?: string
  revokedReason?: string
}>

export type ProjectGrantPage = Readonly<{
  items: ReadonlyArray<ProjectGrantRecord>
  nextCursor?: string
  observedAt: string
}>

const MAX_PAGE_LIMIT = 500
const DEFAULT_PAGE_LIMIT = 100

export function createProjectGrantAuthority(options: {
  dataDir: string
  roots: RootBookmarkAuthority
  vault: CredentialVault
  audit?: AuthorityAudit
}) {
  const { dataDir, roots, vault, audit } = options
  const store = createDurableJsonStore<ProjectGrantRecord>({
    file: join(dataDir, 'dev-runtime', 'grants', 'grants.json'),
    schemaVersion: 1,
    label: 'project grant',
  })

  function load(): ReadonlyArray<ProjectGrantRecord> {
    return store.load().records
  }

  function log(
    action: string,
    subjectId: string,
    outcome: 'granted' | 'denied' | 'revoked',
    detail?: Record<string, string>
  ): void {
    audit?.append({ action, subjectId, outcome, ...(detail ? { detail } : {}) })
  }

  function create(input: {
    scope: DevScope
    projectId: string
    rootBookmarkId: string
    credentialRefId?: string
    approval?: OwnerApproval
  }): ProjectGrantRecord {
    const approval = requireApproval(input.approval, 'grant a project its root')
    if (!isUuid(input.projectId)) {
      throw new DevAuthorityError('not_found', 'project not found')
    }
    // Fail-closed revalidation of every referenced authority, in the caller's
    // scope. A stale or missing root throws before any record is written.
    roots.validate({ scope: input.scope, bookmarkId: input.rootBookmarkId })

    let credentialState: CredentialRefState = 'ready'
    if (input.credentialRefId !== undefined) {
      const ref = vault.get({ scope: input.scope, credentialRefId: input.credentialRefId })
      credentialState = ref.state
      if (ref.state === 'revoked') {
        log('grant.denied', input.projectId, 'denied', { reason: 'credential revoked' })
        throw new DevAuthorityError('unauthorized', 'credential reference has been revoked')
      }
      if (ref.state !== 'ready') {
        throw new DevAuthorityError('auth_required', 'credential reference is not ready')
      }
    }

    const all = [...load()]
    const existing = all.find(
      (entry) =>
        sameScope(entry.scope, input.scope) &&
        entry.projectId === input.projectId &&
        entry.rootBookmarkId === input.rootBookmarkId &&
        entry.state === 'active'
    )
    if (existing) {
      // Durable mutations are idempotent: re-granting a live pair is a no-op.
      return existing
    }

    const record: ProjectGrantRecord = {
      id: newRecordId(),
      scope: { ...input.scope },
      projectId: input.projectId,
      rootBookmarkId: input.rootBookmarkId,
      ...(input.credentialRefId !== undefined ? { credentialRefId: input.credentialRefId } : {}),
      state: 'active',
      generation: 1,
      version: 1,
      createdAt: nowIso(),
    }
    all.push(record)
    store.save(all)
    log('grant.created', record.id, 'granted', {
      approvalMethod: approval.method,
      credentialState,
    })
    return record
  }

  function revoke(input: {
    scope: DevScope
    grantId: string
    expectedVersion: number
    reason?: string
  }): ProjectGrantRecord {
    const all = [...load()]
    const record = all.find((entry) => entry.id === input.grantId)
    if (!record || !isUuid(input.grantId) || !sameScope(record.scope, input.scope)) {
      throw new DevAuthorityError('not_found', 'project grant not found')
    }
    if (record.state === 'revoked') return record
    if (record.version !== input.expectedVersion) {
      throw new DevAuthorityError('stale_version', 'project grant version conflict', record.version)
    }
    const revoked: ProjectGrantRecord = {
      ...record,
      state: 'revoked',
      generation: record.generation + 1,
      version: record.version + 1,
      revokedAt: nowIso(),
      ...(input.reason ? { revokedReason: input.reason.slice(0, 256) } : {}),
    }
    store.save(all.map((entry) => (entry.id === record.id ? revoked : entry)))
    log('grant.revoked', record.id, 'revoked')
    return revoked
  }

  function list(input: {
    scope: DevScope
    projectId?: string
    cursor?: string
    limit?: number
  }): ProjectGrantPage {
    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_LIMIT)
    ) {
      throw new DevAuthorityError('limit_exceeded', `limit must be an integer 1..${MAX_PAGE_LIMIT}`)
    }
    const pageSize = input.limit ?? DEFAULT_PAGE_LIMIT
    let start = 0
    if (input.cursor !== undefined) {
      const decoded = Number(Buffer.from(input.cursor, 'base64url').toString('utf8'))
      if (!Number.isSafeInteger(decoded) || decoded < 0) {
        throw new DevAuthorityError('not_found', 'unknown listing cursor')
      }
      start = decoded
    }
    const filtered = load().filter(
      (entry) =>
        sameScope(entry.scope, input.scope) &&
        (input.projectId === undefined || entry.projectId === input.projectId)
    )
    const items = filtered.slice(start, start + pageSize)
    const nextCursor =
      start + pageSize < filtered.length
        ? Buffer.from(String(start + pageSize)).toString('base64url')
        : undefined
    return { items, ...(nextCursor ? { nextCursor } : {}), observedAt: nowIso() }
  }

  return Object.freeze({ create, revoke, list })
}

export type ProjectGrantAuthority = ReturnType<typeof createProjectGrantAuthority>
