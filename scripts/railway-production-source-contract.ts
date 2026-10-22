/**
 * The Railway production-source adapter contract (issue #1560).
 *
 * PR #1559 adds an offline, fail-closed Railway production-source planner.
 * This module establishes the part that issue needs from the adapter side:
 * an honest, non-secret provenance of an **internal** normalized contract, the
 * normalized contract the planner binds to, and the fail-closed rules that keep
 * the shipped declaration unconfigured while the production identity is
 * unproven.
 *
 * Nothing here reads a credential, contacts Railway, or reads production.
 * The fixtures are normalized placeholders, not captured provider output.
 */

/**
 * The provenance of the contract this adapter normalizes.
 *
 * The contract is **this repository's own normalized contract**, not a
 * published provider schema. A generic API overview is not a schema citation:
 * it names the provider's API, but it does not state the fields a deployment
 * carries, and nothing here has read them. So the provenance records that
 * honestly:
 *
 * - `schemaCitation` is null, because no exact public schema or query is
 *   cited here, and no fixture in this repository matches a captured one;
 * - `referenceOverview` is a pointer to the provider's API reference, kept so
 *   a later owner can look for the exact schema - it is not evidence;
 * - `providerQualification` is pending, because qualifying the adapter against
 *   an authoritative provider schema needs a recorded provider capture, which
 *   this repository has not taken.
 */
export const RAILWAY_SOURCE_SCHEMA_PROVENANCE = {
  provider: 'Railway',
  contract:
    "this repository's own normalized adapter contract - an internal contract, not a published provider schema",
  referenceOverview: 'https://docs.railway.com/reference/public-api',
  schemaCitation: null,
  providerQualification: 'pending',
  retrievedOn: '2026-10-21',
  /**
   * The fixtures in this repository are normalized placeholders shaped like
   * this contract. They are NOT captured provider output, and nothing here may
   * be read as live provider acceptance.
   */
  capturedProviderOutput: false,
  identityEvidence:
    'none - the production project, service and environment are not established in this repository',
} as const

/**
 * The deployment statuses the normalized contract defines.
 *
 * The status is a **normalized** field: these are this repository's own
 * values, not the provider's. An adapter maps the provider's deployment status
 * onto one of them before the payload reaches this contract, so a status
 * outside the vocabulary is malformed rather than normalized - a status this
 * contract does not define cannot be read as in service.
 */
export const NORMALIZED_DEPLOYMENT_STATUSES = Object.freeze({
  inService: Object.freeze(['success', 'running', 'active'] as readonly string[]),
  notInService: Object.freeze([
    'failed',
    'error',
    'stopped',
    'building',
    'deploying',
    'removed',
    'unknown',
  ] as readonly string[]),
})

/** True when a value is one of the normalized deployment statuses. */
export function isNormalizedDeploymentStatus(value: string): boolean {
  return (
    NORMALIZED_DEPLOYMENT_STATUSES.inService.includes(value) ||
    NORMALIZED_DEPLOYMENT_STATUSES.notInService.includes(value)
  )
}

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
 *
 * The status is part of the normalized shape: the planner's in-service rule
 * reads it, so a deployment whose status is dropped would read as one that is
 * not in service.
 */
export type NormalizedRailwayDeployment = {
  id: string
  project: string
  service: string
  environment: string
  status: string
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
 * Reads a field that may be named either way.
 *
 * The contract reads the provider's field names and the planner's field names.
 * A record that carries **both** names is accepted only when the two agree: a
 * record that names two different values for one field is contradictory, and
 * choosing one of them would pick a value the record does not agree with. So a
 * contradiction is reported rather than resolved.
 */
function readAliasedField(
  record: Record<string, unknown>,
  name: string,
  alias: string
): { ok: true; value: string } | { ok: false; message: string } {
  const primary = record[name]
  const secondary = record[alias]
  if (primary !== undefined && secondary !== undefined && primary !== secondary) {
    return { ok: false, message: `the entry names ${name} and ${alias} with different values` }
  }
  const value = primary !== undefined ? primary : secondary
  if (!isText(value)) {
    return { ok: false, message: `the entry names no ${name}` }
  }
  return { ok: true, value }
}

/**
 * Reads the normalized status of a deployment.
 *
 * The status is preserved, not dropped: the planner's in-service rule reads
 * it, and a deployment whose status is dropped would read as not in service
 * even when the read said it was serving.
 */
function readStatus(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (!isText(value)) {
    return { ok: false, message: 'the entry names no status' }
  }
  if (!isNormalizedDeploymentStatus(value)) {
    return {
      ok: false,
      message: `the entry names the status '${value}', which is not one of the normalized statuses`,
    }
  }
  return { ok: true, value }
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
    // and the normalized record always carries the planner's. A record that
    // carries both names for one field is accepted only when they agree.
    const id = readAliasedField(record, 'id', 'deploymentId')
    if (!id.ok) return { ok: false, message: id.message }
    const project = readAliasedField(record, 'project', 'projectId')
    if (!project.ok) return { ok: false, message: project.message }
    const service = readAliasedField(record, 'service', 'serviceId')
    if (!service.ok) return { ok: false, message: service.message }
    const environment = readAliasedField(record, 'environment', 'environmentId')
    if (!environment.ok) return { ok: false, message: environment.message }
    const status = readStatus(record.status)
    if (!status.ok) return { ok: false, message: status.message }
    if (!isText(record.createdAt)) {
      return { ok: false, message: 'the entry names no creation timestamp' }
    }
    normalized.push({
      id: id.value,
      project: project.value,
      service: service.value,
      environment: environment.value,
      status: status.value,
      createdAt: record.createdAt,
    })
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
    const project = readAliasedField(candidate, 'project', 'projectId')
    if (!project.ok) return { ok: false, message: project.message }
    const service = readAliasedField(candidate, 'service', 'serviceId')
    if (!service.ok) return { ok: false, message: service.message }
    const environment = readAliasedField(candidate, 'environment', 'environmentId')
    if (!environment.ok) return { ok: false, message: environment.message }
    normalized.push({
      project: project.value,
      service: service.value,
      environment: environment.value,
    })
  }
  const normalizedDeployment = normalizeDeploymentMetadata(deployment as Record<string, unknown>)
  if (!normalizedDeployment.ok) return { ok: false, message: normalizedDeployment.message }
  return {
    ok: true,
    status: { targets: normalized, deployment: normalizedDeployment.value },
  }
}

/**
 * The deployment metadata a status read published, with its identity normalized.
 *
 * The published metadata is preserved as it is. The deployment it belongs to
 * is named: the id is the deployment the plan binds the metadata to, and the
 * target it names is normalized so the plan can compare it with the target that
 * was read. A status read whose deployment names no id is malformed, because
 * metadata that names no deployment cannot be bound to any history.
 */
function normalizeDeploymentMetadata(
  deployment: Record<string, unknown>
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const id = readAliasedField(deployment, 'id', 'deploymentId')
  if (!id.ok) {
    return { ok: false, message: `the deployment metadata names no deployment: ${id.message}` }
  }
  const normalized: Record<string, unknown> = { ...deployment, id: id.value }
  for (const [name, alias] of [
    ['project', 'projectId'],
    ['service', 'serviceId'],
    ['environment', 'environmentId'],
  ] as const) {
    const primary = deployment[name]
    const secondary = deployment[alias]
    if (primary !== undefined && secondary !== undefined && primary !== secondary) {
      return {
        ok: false,
        message: `the deployment metadata names ${name} and ${alias} with different values`,
      }
    }
    const value = primary !== undefined ? primary : secondary
    if (value === undefined) continue
    if (!isText(value)) {
      return { ok: false, message: `the deployment metadata names no ${name}` }
    }
    normalized[name] = value
  }
  return { ok: true, value: normalized }
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
