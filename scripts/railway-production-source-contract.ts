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

/**
 * One deployment, normalized to the field names the planner reads.
 *
 * The provider's own JSON names these fields `deploymentId`, `projectId`,
 * `serviceId` and `environmentId`. The planner reads `id`, `project`,
 * `service` and `environment`. The mapping between the two is the
 * normalization boundary, and it is stated here rather than left implicit.
 */
export type NormalizedRailwayDeployment = {
  id: string
  project: string
  service: string
  environment: string
  createdAt: string
}

/** One target, normalized to the field names the planner reads. */
export type NormalizedRailwayTarget = {
  project: string
  service: string
  environment: string
}

/**
 * The two read shapes the planner reads, and the containers each one carries.
 *
 * This is the boundary in one place: an adapter that normalizes into these
 * shapes is read by the planner; anything else is refused as unnormalized.
 */
export const PLAN_READ_SHAPES = Object.freeze({
  status: Object.freeze({ containers: Object.freeze(['targets', 'deployment']) }),
  deployments: Object.freeze({ containers: Object.freeze(['deployments']) }),
})

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
    // The provider's field names and the planner's field names are both read,
    // and the normalized record always carries the planner's.
    const id = record.id ?? record.deploymentId
    const project = record.project ?? record.projectId
    const service = record.service ?? record.serviceId
    const environment = record.environment ?? record.environmentId
    if (
      !isText(id) ||
      !isText(project) ||
      !isText(service) ||
      !isText(environment) ||
      !isText(record.createdAt)
    ) {
      return {
        ok: false,
        message: 'a deployment entry does not carry the declared schema fields',
      }
    }
    normalized.push({ id, project, service, environment, createdAt: record.createdAt })
  }
  return { ok: true, source: { deployments: normalized } }
}

/**
 * Normalizes a provider status payload into the shape the planner reads.
 *
 * The status read carries the candidate targets and the deployment that is
 * live. A target that does not name a project, a service and an environment
 * cannot be told apart from another target, so it is malformed rather than
 * normalized.
 */
export function normalizeRailwayStatus(payload: unknown): {
  ok: boolean
  status?: { targets: NormalizedRailwayTarget[]; deployment: Record<string, unknown> }
  message?: string
} {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, message: 'the provider payload is not an object' }
  }
  const record = payload as Record<string, unknown>
  const targets = record.targets
  const deployment = record.deployment
  if (!Array.isArray(targets)) {
    return { ok: false, message: 'the provider payload has no targets list' }
  }
  if (deployment === null || typeof deployment !== 'object' || Array.isArray(deployment)) {
    return { ok: false, message: 'the provider payload has no deployment object' }
  }
  const normalized: NormalizedRailwayTarget[] = []
  for (const entry of targets) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, message: 'a target entry is not an object' }
    }
    const candidate = entry as Record<string, unknown>
    const project = candidate.project ?? candidate.projectId
    const service = candidate.service ?? candidate.serviceId
    const environment = candidate.environment ?? candidate.environmentId
    if (!isText(project) || !isText(service) || !isText(environment)) {
      return {
        ok: false,
        message: 'a target entry does not name a project, a service and an environment',
      }
    }
    normalized.push({ project, service, environment })
  }
  return {
    ok: true,
    status: { targets: normalized, deployment: deployment as Record<string, unknown> },
  }
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
  // The normalized deployment carries the planner's field names; the declared
  // identity carries the declaration's names. The comparison is between the two.
  const mismatched = normalized.source.deployments.filter(
    (deployment) =>
      deployment.project !== identity.projectId ||
      deployment.service !== identity.serviceId ||
      deployment.environment !== identity.environmentId
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
