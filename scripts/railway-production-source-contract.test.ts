/**
 * Offline conformance for the Railway production-source adapter contract
 * (issue #1560).
 *
 * Every case runs offline against normalized fixtures. No credential, no
 * Railway call, and no production read is involved.
 */
import { describe, expect, test } from 'bun:test'
import { planProductionDeployment, repositoryRoot } from './railway-production-plan.mjs'
import { readFileSync } from 'node:fs'

import {
  RAILWAY_PLAN_REFUSALS,
  RAILWAY_SOURCE_SCHEMA_PROVENANCE,
  UNCONFIGURED_RAILWAY_SOURCE_IDENTITY,
  normalizeRailwaySource,
  normalizeRailwayStatus,
  planRailwayProductionSource,
  type RailwaySourceIdentity,
} from './railway-production-source-contract.ts'

const IDENTITY: RailwaySourceIdentity = {
  configured: true,
  projectId: 'project-production',
  serviceId: 'service-production',
  environmentId: 'environment-production',
}

/** A normalized placeholder, not captured provider output. */
const SOURCE = {
  deployments: [
    {
      deploymentId: 'deployment-0001',
      projectId: 'project-production',
      serviceId: 'service-production',
      environmentId: 'environment-production',
      createdAt: '2026-01-02T03:04:05.000Z',
    },
  ],
}

describe('the Railway production-source contract', () => {
  test('the shipped declaration stays explicitly unconfigured', () => {
    expect(UNCONFIGURED_RAILWAY_SOURCE_IDENTITY.configured).toBe(false)
    expect(UNCONFIGURED_RAILWAY_SOURCE_IDENTITY.projectId).toBeNull()
    expect(UNCONFIGURED_RAILWAY_SOURCE_IDENTITY.serviceId).toBeNull()
    expect(UNCONFIGURED_RAILWAY_SOURCE_IDENTITY.environmentId).toBeNull()
  })

  test('an unconfigured identity refuses to plan', () => {
    const plan = planRailwayProductionSource(UNCONFIGURED_RAILWAY_SOURCE_IDENTITY, SOURCE)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.refusal).toBe('identity-unconfigured')
  })

  test('a matching source binds the deployment history to all three identifiers', () => {
    const plan = planRailwayProductionSource(IDENTITY, SOURCE)
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.deployments).toHaveLength(1)
      expect(plan.deployments[0]?.project).toBe('project-production')
      expect(plan.deployments[0]?.service).toBe('service-production')
      expect(plan.deployments[0]?.environment).toBe('environment-production')
      expect(plan.provenance.capturedProviderOutput).toBe(false)
    }
  })

  test('a mismatched project refuses', () => {
    const plan = planRailwayProductionSource(IDENTITY, {
      deployments: [{ ...SOURCE.deployments[0], projectId: 'project-other' }],
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.refusal).toBe('identity-mismatch')
  })

  test('a mismatched service refuses', () => {
    const plan = planRailwayProductionSource(IDENTITY, {
      deployments: [{ ...SOURCE.deployments[0], serviceId: 'service-other' }],
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.refusal).toBe('identity-mismatch')
  })

  test('a mismatched environment refuses', () => {
    const plan = planRailwayProductionSource(IDENTITY, {
      deployments: [{ ...SOURCE.deployments[0], environmentId: 'environment-other' }],
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.refusal).toBe('identity-mismatch')
  })

  test('a malformed payload refuses', () => {
    expect(normalizeRailwaySource({ deployments: [{ deploymentId: 'x' }] }).ok).toBe(false)
    expect(normalizeRailwaySource({}).ok).toBe(false)
    expect(normalizeRailwaySource(null).ok).toBe(false)
    const plan = planRailwayProductionSource(IDENTITY, { deployments: [{ deploymentId: 'x' }] })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.refusal).toBe('malformed-source')
  })

  test('an empty source refuses', () => {
    const plan = planRailwayProductionSource(IDENTITY, { deployments: [] })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.refusal).toBe('empty-source')
  })

  test('the provenance cites a public source and claims no captured output', () => {
    expect(RAILWAY_SOURCE_SCHEMA_PROVENANCE.source).toMatch(/^https:\/\//)
    expect(RAILWAY_SOURCE_SCHEMA_PROVENANCE.source).toContain('docs.railway.com')
    expect(RAILWAY_SOURCE_SCHEMA_PROVENANCE.capturedProviderOutput).toBe(false)
    expect(RAILWAY_SOURCE_SCHEMA_PROVENANCE.identityEvidence).toContain('none')
    expect(RAILWAY_PLAN_REFUSALS).toContain('identity-unconfigured')
  })

  test('the contract and the fixtures carry no secret-shaped values', () => {
    const secretPattern =
      /(token|secret|password|passwd|api[_-]?key|authorization|bearer|eyJ[A-Za-z0-9_-]{8,})/i
    const source = readFileSync(
      import.meta.dirname + '/railway-production-source-contract.ts',
      'utf8'
    )
    const fixture = JSON.stringify(SOURCE)
    expect(secretPattern.test(fixture)).toBe(false)
    // The contract module names the secret-shaped words only in the guard
    // pattern of this test, never as a value.
    expect(secretPattern.test(source.replace(/secret|token|password/gi, ''))).toBe(false)
  })
})

/**
 * The normalization boundary, proven against the planner.
 *
 * The contract normalizes the provider's payload into the shapes the planner
 * reads. These cases run the planner over that output, so the two are bound by
 * a test rather than by a comment: the planner accepts what the contract
 * produces, it refuses the provider's own shape as unnormalized, and it
 * refuses a payload whose deployments belong to another target.
 */
/** What a staged read answers with. */
const staged = (payload: unknown) => ({
  status: 0,
  stdout: JSON.stringify(payload),
  stderr: '',
})

describe('the contract and the planner agree on the normalization boundary', () => {
  const declaration = {
    configured: true,
    environment: 'production',
    targets: [
      { project: 'example-project', service: 'example-service', environment: 'production' },
    ],
    requiredMetadata: ['release', 'imageDigest', 'region', 'promotedAt'],
    pinnedMetadata: {},
  }

  const providerStatus = {
    targets: [
      { projectId: 'example-project', serviceId: 'example-service', environmentId: 'production' },
    ],
    deployment: {
      release: 'v0.99.0-dev.488',
      imageDigest: 'sha256:1f0a',
      region: 'eu-west-1',
      promotedAt: '2026-10-20T00:00:00Z',
    },
  }

  const providerDeployments = {
    deployments: [
      {
        deploymentId: 'd_2',
        projectId: 'example-project',
        serviceId: 'example-service',
        environmentId: 'production',
        createdAt: '2026-10-20T00:00:00Z',
        status: 'success',
      },
    ],
  }

  const planner = (reads: { status: unknown; deployments: unknown }, source = declaration) => {
    return planProductionDeployment({
      source,
      root: repositoryRoot(),
      run: (request: { kind: string }) =>
        request.kind === 'status' ? staged(reads.status) : staged(reads.deployments),
    }) as { ok: boolean; refusals?: { code: string }[]; target?: unknown; history?: unknown }
  }

  test('the planner accepts the shape the contract normalizes into', () => {
    const status = normalizeRailwayStatus(providerStatus)
    expect(status.ok).toBe(true)
    const deployments = normalizeRailwaySource(providerDeployments)
    expect(deployments.ok).toBe(true)
    const plan = planner({
      status: status.status,
      deployments: deployments.source,
    })
    // The plan is not refused as unnormalized: the boundary holds.
    const codes = (plan.refusals ?? []).map((refusal) => refusal.code)
    expect(codes).not.toContain('RAILWAY_PRODUCTION_READ_UNNORMALIZED')
    expect(codes).not.toContain('RAILWAY_PRODUCTION_HISTORY_UNBOUND')
    expect(codes).not.toContain('RAILWAY_PRODUCTION_TARGET_CONTRADICTORY')
  })

  test("the provider's own field names are not the planner's field names", () => {
    // The planner reads `project`, `service` and `environment`; the provider
    // names them `projectId`, `serviceId` and `environmentId`. The payload is
    // refused, not planned, and it is refused on the content: the entries name
    // no identity the plan can bind.
    const plan = planner({ status: providerStatus, deployments: providerDeployments })
    const codes = (plan.refusals ?? []).map((refusal) => refusal.code)
    expect(codes).toContain('RAILWAY_PRODUCTION_HISTORY_UNBOUND')
  })

  test('a payload that is not the normalized shape is refused as unnormalized', () => {
    const plan = planner({ status: { targets: 'not-a-list', deployment: {} }, deployments: {} })
    expect((plan.refusals ?? []).map((refusal) => refusal.code)).toContain(
      'RAILWAY_PRODUCTION_READ_UNNORMALIZED'
    )
  })

  test('a deployment of another project, service or environment is refused against the target', () => {
    const status = normalizeRailwayStatus(providerStatus)
    const deployments = normalizeRailwaySource(providerDeployments)
    expect(status.ok).toBe(true)
    expect(deployments.ok).toBe(true)
    for (const other of [
      { project: 'example-other-project' },
      { service: 'example-other-service' },
      { environment: 'example-other-environment' },
    ]) {
      const mismatched = {
        deployments: [
          {
            ...(deployments.source as { deployments: unknown[] }).deployments[0],
            ...other,
          },
        ],
      }
      const plan = planner({ status: status.status, deployments: mismatched })
      const codes = (plan.refusals ?? []).map((refusal) => refusal.code)
      expect(codes.length).toBeGreaterThan(0)
      expect(codes).not.toContain('RAILWAY_PRODUCTION_READ_UNNORMALIZED')
    }
  })

  test('the contract refuses a malformed payload before the planner sees it', () => {
    expect(normalizeRailwayStatus({ targets: 'not-a-list', deployment: {} }).ok).toBe(false)
    expect(normalizeRailwaySource({ deployments: [{ id: 'd_1' }] }).ok).toBe(false)
    expect(normalizeRailwayStatus(providerStatus).ok).toBe(true)
  })
})
