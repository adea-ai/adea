/**
 * Workspace catalog proxy (ADR 0013): lists the Skills and agent profiles a
 * workspace sees (its own plus read-only system items), publishes workspace
 * Skills, and deprecates or revokes workspace-owned items, all under the
 * workspace's own signed Control Plane scope. Reads ask for `catalog:read`,
 * publishing for `catalog:publish`, lifecycle changes for `catalog:manage`.
 *
 * Responses are re-shaped into Adea's API types field by field; executable
 * content (manifests, instructions, definitions) is never returned here.
 *
 * No `server-only` marker: Bun-run unit tests import this module directly.
 */
import type {
  ApiCatalogItem,
  ApiCatalogLifecycle,
  ApiCatalogLifecycleResponse,
  ApiCatalogVersion,
  ApiSkillPublishResponse,
} from '@adea-ai/api-client'

import {
  ControlPlaneProxyError,
  commandEnvelope,
  isRecord,
  mintOpaqueIdentifier,
  postControlPlane,
  readEnvelope,
  scopedAdminCredential,
  type AdminCorrelation,
  type ControlPlaneHopDependencies,
} from './control-plane-client'

export type CatalogKind = 'profile' | 'skill'
export type CatalogLifecycleAction = 'deprecate' | 'revoke'

const LIFECYCLES = new Set<ApiCatalogLifecycle>([
  'deprecated',
  'draft',
  'published',
  'revoked',
  'superseded',
])
const CATALOG_PAGE_LIMIT = 100

const paths = {
  profile: '/v1/catalog/profiles',
  skill: '/v1/catalog/skills',
} as const

export async function listWorkspaceCatalog(
  kind: CatalogKind,
  input: Readonly<{ cursor?: string }>,
  correlation: AdminCorrelation,
  dependencies: ControlPlaneHopDependencies
): Promise<Readonly<{ items: ApiCatalogItem[]; nextCursor?: string }>> {
  const credential = await scopedAdminCredential(['catalog:read'], dependencies)
  const now = dependencies.now?.() ?? Date.now()
  const operation = `catalog.${kind}.list`
  const data = await postControlPlane(
    credential,
    `${paths[kind]}/list`,
    readEnvelope(
      credential,
      correlation,
      operation,
      { limit: CATALOG_PAGE_LIMIT, ...(input.cursor ? { cursor: input.cursor } : {}) },
      now
    ),
    dependencies,
    operation
  )
  if (!isRecord(data) || !Array.isArray(data.items)) throw invalidResponse()
  const items = data.items.map((entry) => {
    if (!isRecord(entry)) throw invalidResponse()
    return catalogItem(kind, entry[kind], entry.latestVersion)
  })
  const nextCursor =
    isRecord(data.page) && typeof data.page.nextCursor === 'string'
      ? data.page.nextCursor
      : undefined
  return { items, ...(nextCursor ? { nextCursor } : {}) }
}

export async function publishWorkspaceSkill(
  input: Readonly<{
    idempotencyKey: string
    skillId?: string
    displayName: string
    manifest: Record<string, unknown>
    content: Record<string, unknown>
  }>,
  correlation: AdminCorrelation,
  dependencies: ControlPlaneHopDependencies
): Promise<ApiSkillPublishResponse> {
  const credential = await scopedAdminCredential(['catalog:publish'], dependencies)
  const now = dependencies.now?.() ?? Date.now()
  const operation = 'catalog.skill.publish'
  const data = await postControlPlane(
    credential,
    `${paths.skill}/publish`,
    commandEnvelope(credential, correlation, {
      idempotencyKey: `catalog-skill-publish:${input.idempotencyKey}`,
      now,
      operation,
      payload: {
        content: input.content,
        displayName: input.displayName,
        manifest: input.manifest,
        skillId: input.skillId ?? mintOpaqueIdentifier('skl', now),
        skillVersionId: mintOpaqueIdentifier('skv', now),
      },
    }),
    dependencies,
    operation
  )
  if (!isRecord(data)) throw invalidResponse()
  const item = catalogItem('skill', data.skill, data.version)
  if (!item.latestVersion) throw invalidResponse()
  return { item, version: item.latestVersion }
}

export async function changeWorkspaceCatalogLifecycle(
  kind: CatalogKind,
  action: CatalogLifecycleAction,
  input: Readonly<{
    id: string
    idempotencyKey: string
    reason: string
    versionId?: string
    expectedRevision?: number
  }>,
  correlation: AdminCorrelation,
  dependencies: ControlPlaneHopDependencies
): Promise<ApiCatalogLifecycleResponse> {
  const credential = await scopedAdminCredential(['catalog:manage'], dependencies)
  const now = dependencies.now?.() ?? Date.now()
  const operation = `catalog.${kind}.${action}`
  const idKey = kind === 'skill' ? 'skillId' : 'profileId'
  const versionKey = kind === 'skill' ? 'skillVersionId' : 'profileVersionId'
  const payload =
    input.versionId !== undefined && input.expectedRevision !== undefined
      ? {
          [idKey]: input.id,
          [versionKey]: input.versionId,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
        }
      : { [idKey]: input.id, reason: input.reason }
  const data = await postControlPlane(
    credential,
    `${paths[kind]}/${action}`,
    commandEnvelope(credential, correlation, {
      idempotencyKey: `catalog-${kind}-${action}:${input.idempotencyKey}`,
      now,
      operation,
      payload,
    }),
    dependencies,
    operation
  )
  if (!isRecord(data) || !Array.isArray(data.changed)) throw invalidResponse()
  return {
    changed: data.changed.map((version) => catalogVersion(kind, version)),
    item: catalogItem(kind, data[kind], undefined),
  }
}

function catalogItem(kind: CatalogKind, record: unknown, latest: unknown): ApiCatalogItem {
  if (!isRecord(record)) throw invalidResponse()
  const id = kind === 'skill' ? record.skillId : record.profileId
  const ownership = record.ownership
  if (
    typeof id !== 'string' ||
    typeof record.displayName !== 'string' ||
    typeof record.readOnly !== 'boolean' ||
    typeof record.createdAt !== 'string' ||
    !isRecord(ownership) ||
    (ownership.scope !== 'system' && ownership.scope !== 'workspace')
  )
    throw invalidResponse()
  return {
    createdAt: record.createdAt,
    displayName: record.displayName,
    id,
    kind,
    owner: ownership.scope,
    // A system item is read-only whatever the record says.
    readOnly: record.readOnly || ownership.scope === 'system',
    ...(latest === undefined ? {} : { latestVersion: catalogVersion(kind, latest) }),
  }
}

function catalogVersion(kind: CatalogKind, value: unknown): ApiCatalogVersion {
  if (!isRecord(value)) throw invalidResponse()
  const versionId = kind === 'skill' ? value.skillVersionId : value.profileVersionId
  const version =
    kind === 'skill'
      ? value.semanticVersion
      : typeof value.version === 'number'
        ? String(value.version)
        : undefined
  const metadata = isRecord(value.lifecycleMetadata) ? value.lifecycleMetadata : {}
  if (
    typeof versionId !== 'string' ||
    typeof version !== 'string' ||
    typeof value.revision !== 'number' ||
    typeof value.lifecycle !== 'string' ||
    !LIFECYCLES.has(value.lifecycle as ApiCatalogLifecycle) ||
    typeof value.contentDigest !== 'string' ||
    typeof value.createdAt !== 'string'
  )
    throw invalidResponse()
  return {
    contentDigest: value.contentDigest,
    createdAt: value.createdAt,
    lifecycle: value.lifecycle as ApiCatalogLifecycle,
    revision: value.revision,
    version,
    versionId,
    ...(typeof metadata.reason === 'string' ? { reason: metadata.reason } : {}),
  }
}

function invalidResponse() {
  return new ControlPlaneProxyError(
    'CONTROL_PLANE_UNAVAILABLE',
    'Control Plane returned an invalid response'
  )
}
