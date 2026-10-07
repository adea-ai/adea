import { expect, test } from 'bun:test'
import type { ApiRuntimeConnection } from '@adea-ai/api-client'
import {
  connectionFreshness,
  conservativeNodeProof,
  nodeProofState,
  runtimeInventoryLoadNotice,
  runtimeInspectionState,
} from '../../src/runtime-inventory-model'

const now = Date.parse('2026-10-07T12:00:00.000Z')
const freshness = { state: 'fresh', observedAt: new Date(now).toISOString() } as const
const connection = {
  freshness,
  observedAt: freshness.observedAt,
  eligibility: { state: 'eligible' },
} as ApiRuntimeConnection

test('an aging inventory never continues to present fresh eligibility', () => {
  expect(connectionFreshness(connection, now)).toBe('fresh')
  expect(connectionFreshness(connection, now + 300_001)).toBe('stale')
  expect(
    runtimeInspectionState(
      connection,
      { pairingState: 'paired', health: 'healthy', lastProofAt: freshness.observedAt },
      now + 300_001
    )
  ).toBe('Refresh required')
  expect(
    connectionFreshness({ ...connection, freshness: { ...freshness, state: 'stale' } }, now)
  ).toBe('stale')
  expect(
    connectionFreshness(
      { ...connection, freshness: { ...freshness, expiresAt: freshness.observedAt } },
      now
    )
  ).toBe('expired')
  for (const observedAt of ['invalid', new Date(now + 1).toISOString()])
    expect(
      connectionFreshness({ ...connection, freshness: { ...freshness, observedAt } }, now)
    ).toBe('unknown')
})

test('registration, proof and reported connection eligibility remain separate', () => {
  const node = {
    pairingState: 'paired',
    health: 'healthy',
    lastProofAt: freshness.observedAt,
  } as const
  expect(nodeProofState(node, now)).toBe('Recent proof')
  expect(nodeProofState(node, now + 300_001)).toBe('Stale proof')
  expect(nodeProofState({ ...node, lastProofAt: null }, now)).toBe('Proof unknown')
  expect(nodeProofState({ ...node, lastProofAt: new Date(now + 1).toISOString() }, now)).toBe(
    'Proof unknown'
  )
  expect(runtimeInspectionState(connection, node, now)).toBe('Reported eligible')
  expect(
    runtimeInspectionState(
      connection,
      conservativeNodeProof(node, { ...node, pairingState: 'revoked' }, now),
      now
    )
  ).toBe('Host revoked')
  expect(nodeProofState(conservativeNodeProof(node, { ...node, health: 'stale' }, now), now)).toBe(
    'Stale proof'
  )
  expect(runtimeInspectionState(connection, { ...node, pairingState: 'revoked' }, now)).toBe(
    'Host revoked'
  )
  expect(
    runtimeInspectionState(
      {
        ...connection,
        eligibility: { state: 'ineligible', reasons: [], degradations: [], remediation: [] },
      },
      node,
      now
    )
  ).toBe('Reported ineligible')
})

test('either future-dated registration proof keeps the combined observation unknown', () => {
  const recent = {
    pairingState: 'paired',
    health: 'healthy',
    lastProofAt: freshness.observedAt,
  } as const
  const future = { ...recent, lastProofAt: new Date(now + 1).toISOString() }
  for (const [first, second] of [
    [recent, future],
    [future, recent],
  ]) {
    expect(nodeProofState(conservativeNodeProof(first!, second!, now), now)).toBe('Proof unknown')
  }
})

test('inventory errors use fixed actionable text without exposing server content', () => {
  expect(runtimeInventoryLoadNotice({ status: 403, message: 'secret canary' })).toContain(
    'owners and admins'
  )
  expect(runtimeInventoryLoadNotice({ status: 401 })).toContain('Sign in')
  expect(runtimeInventoryLoadNotice({ status: 503 })).toContain('unavailable')
  expect(runtimeInventoryLoadNotice({ status: 500, message: 'secret canary' })).not.toContain(
    'canary'
  )
})
