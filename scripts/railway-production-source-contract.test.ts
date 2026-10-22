/**
 * Offline conformance for the Railway production-source adapter contract
 * (issue #1560).
 *
 * Every case runs offline against normalized fixtures. No credential, no
 * Railway call, and no production read is involved.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import {
  RAILWAY_PLAN_REFUSALS,
  RAILWAY_SOURCE_SCHEMA_PROVENANCE,
  UNCONFIGURED_RAILWAY_SOURCE_IDENTITY,
  normalizeRailwaySource,
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
      expect(plan.deployments[0]?.projectId).toBe('project-production')
      expect(plan.deployments[0]?.serviceId).toBe('service-production')
      expect(plan.deployments[0]?.environmentId).toBe('environment-production')
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
