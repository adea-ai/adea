/**
 * The Railway production-source adapter contract (issue #1560).
 *
 * PR #1559 adds an offline, fail-closed Railway production-source planner.
 * This module establishes the part that issue needs from the adapter side:
 * an authoritative, non-secret schema provenance, the normalized contract the
 * planner binds to, and the fail-closed rules that keep the shipped
 * declaration unconfigured while the production identity is unproven.
 *
 * Nothing here reads a credential, contacts Railway, or reads production.
 * The fixtures are normalized placeholders, not captured provider output.
 */

/** The public, non-secret provenance of the contract this adapter normalizes. */
export const RAILWAY_SOURCE_SCHEMA_PROVENANCE = {
  provider: 'Railway',
  contract: 'the public API reference: the deployments query and the Deployment type',
  source: 'https://docs.railway.com/reference/public-api',
  retrievedOn: '2026-10-21',
  /**
   * The fixtures in this repository are normalized placeholders shaped like
   * the published schema. They are NOT captured provider output, and nothing
   * here may be read as live provider acceptance.
   */
  capturedProviderOutput: false,
  identityEvidence:
    'none - the production project, service and environment are not established in this repository',
} as const

/** The three-part identity a production plan has to bind to. */
export type RailwaySourceIdentity = {
  configured: boolean
  projectId: string | null
  serviceId: string | null
  environmentId: string | null
}

/**
 * The shipped declaration.
 *
 * The production identity is not established by any authorized, non-secret
 * source available to this repository, so the declaration stays explicitly
 * unconfigured and every plan refuses.
 */
export const UNCONFIGURED_RAILWAY_SOURCE_IDENTITY: RailwaySourceIdentity = {
  configured: false,
  projectId: null,
  serviceId: null,
  environmentId: null,
}

/** One deployment, normalized to the published schema's fields. */
export type NormalizedRailwayDeployment = {
  deploymentId: string
  projectId: string
  serviceId: string
  environmentId: string
  createdAt: string
}

/** The normalized source the adapter produces. */
export type NormalizedRailwaySource = {
  deployments: NormalizedRailwayDeployment[]
}

/** The named reasons a plan refuses. */
export const RAILWAY_PLAN_REFUSALS = [
  'identity-unconfigured',
  'identity-mismatch',
  'malformed-source',
  'empty-source',
] as const
export type RailwayPlanRefusal = (typeof RAILWAY_PLAN_REFUSALS)[number]

export type RailwayProductionPlan =
  | {
      ok: true
      identity: RailwaySourceIdentity
      deployments: NormalizedRailwayDeployment[]
      provenance: typeof RAILWAY_SOURCE_SCHEMA_PROVENANCE
    }
  | { ok: false; refusal: RailwayPlanRefusal; message: string }

/** True when a value is a non-empty string. */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Normalizes a provider payload into the contract.
 *
 * The payload shape follows the published schema; a payload that does not
 * carry the declared fields is malformed and is reported as such. The
 * normalization never invents a field.
 */
export function normalizeRailwaySource(payload: unknown): {
  ok: boolean
  source?: NormalizedRailwaySource
  message?: string
} {
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, message: 'the provider payload is not an object' }
  }
  const deployments = (payload as { deployments?: unknown }).deployments
  if (!Array.isArray(deployments)) {
    return { ok: false, message: 'the provider payload has no deployments list' }
  }
  const normalized: NormalizedRailwayDeployment[] = []
  for (const entry of deployments) {
    if (entry === null || typeof entry !== 'object') {
      return { ok: false, message: 'a deployment entry is not an object' }
    }
    const record = entry as Record<string, unknown>
    const deploymentId = record.deploymentId ?? record.id
    if (
      !isText(deploymentId) ||
      !isText(record.projectId) ||
      !isText(record.serviceId) ||
      !isText(record.environmentId) ||
      !isText(record.createdAt)
    ) {
      return {
        ok: false,
        message: 'a deployment entry does not carry the declared schema fields',
      }
    }
    normalized.push({
      deploymentId,
      projectId: record.projectId,
      serviceId: record.serviceId,
      environmentId: record.environmentId,
      createdAt: record.createdAt,
    })
  }
  return { ok: true, source: { deployments: normalized } }
}

/**
 * Plans the production source against a declared identity.
 *
 * The plan fails closed: an unconfigured identity refuses, and a source whose
 * deployments do not all bind the declared project, service and environment
 * refuses. A partially matching source never yields a plan.
 */
export function planRailwayProductionSource(
  identity: RailwaySourceIdentity,
  payload: unknown
): RailwayProductionPlan {
  if (!identity.configured) {
    return {
      ok: false,
      refusal: 'identity-unconfigured',
      message:
        'the Railway production identity is not configured in this repository, so no plan is produced',
    }
  }
  if (
    !isText(identity.projectId) ||
    !isText(identity.serviceId) ||
    !isText(identity.environmentId)
  ) {
    return {
      ok: false,
      refusal: 'identity-unconfigured',
      message: 'the declared identity does not name a project, service and environment',
    }
  }
  const normalized = normalizeRailwaySource(payload)
  if (!normalized.ok || normalized.source === undefined) {
    return {
      ok: false,
      refusal: 'malformed-source',
      message: normalized.message ?? 'the provider payload could not be normalized',
    }
  }
  if (normalized.source.deployments.length === 0) {
    return {
      ok: false,
      refusal: 'empty-source',
      message: 'the provider payload carries no deployments',
    }
  }
  const mismatched = normalized.source.deployments.filter(
    (deployment) =>
      deployment.projectId !== identity.projectId ||
      deployment.serviceId !== identity.serviceId ||
      deployment.environmentId !== identity.environmentId
  )
  if (mismatched.length > 0) {
    return {
      ok: false,
      refusal: 'identity-mismatch',
      message: `${mismatched.length} deployment(s) do not bind the declared project, service and environment`,
    }
  }
  return {
    ok: true,
    identity,
    deployments: normalized.source.deployments,
    provenance: RAILWAY_SOURCE_SCHEMA_PROVENANCE,
  }
}
