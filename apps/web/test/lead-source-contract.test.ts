import { expect, test } from 'bun:test'
import type { CurrentSourceLeadTurnProduct } from '@adea-ai/db'
import { createHash } from 'node:crypto'
import {
  sourceLeadProductSnapshot,
  isSourceLeadPublicationCurrent,
} from '../src/server/lead-source-contract'

// Cross-check the actual candidate shared schemas; never substitute a local
// handwritten validator. This is a consumer contract test, not a deployed SDK.
const contracts = await import('../../../../control-plane/packages/contracts/src/index.ts')
const now = Date.UTC(2026, 9, 13, 12)
const id = (kind: string, char: string) => `${kind}_${char.repeat(26)}`
const product: CurrentSourceLeadTurnProduct = {
  workspaceId: crypto.randomUUID(),
  agentWorkspaceId: crypto.randomUUID(),
  controlPlaneWorkspaceId: id('wsp', '1'),
  sourceControlPlaneWorkspaceId: id('wsp', '2'),
  intentId: crypto.randomUUID(),
  intentCreatedAt: new Date(now - 1_000).toISOString(),
  channelId: crypto.randomUUID(),
  channelVersion: 1,
  channelVisibility: 'participants',
  audience: ['user:canonical'],
  messageId: crypto.randomUUID(),
  messageVersion: 1,
  actorUserId: crypto.randomUUID(),
  agentId: crypto.randomUUID(),
  controlPlaneAgentId: id('agt', '3'),
  profileId: 'source-profile',
  profileVersion: '1.0.0',
  profileRevision: 1,
  enlistmentGrantId: 'gra_source',
  enlistmentRevision: 1,
  prompt: 'One current host turn\n',
}
const pins = {
  intentId: product.intentId,
  executionId: id('exe', '5'),
  attemptId: id('att', '6'),
  runtimeSessionId: id('ses', '7'),
  dispatchId: `dispatch_${'d'.repeat(32)}`,
  preparationRef: `prep_${'e'.repeat(32)}`,
  profileVersionId: id('pfv', '4'),
  profileContentDigest: `sha256:${'b'.repeat(64)}`,
  selectionRef: `msel_${'c'.repeat(32)}`,
  selectionRevision: 2,
}
function proof() {
  const snapshot = sourceLeadProductSnapshot(product, { contracts, lifetimeMs: 300_000, now })
  return {
    schemaVersion: 'pi-lead-source-publication/v1',
    binding: {
      schemaVersion: 'pi-lead-source-execution-binding/v1',
      authority: snapshot.authority,
      intentExpiresAt: snapshot.expiresAt,
      profileVersionId: pins.profileVersionId,
      profileContentDigest: pins.profileContentDigest,
      selectionRef: pins.selectionRef,
      selectionRevision: pins.selectionRevision,
      executionId: pins.executionId,
      attemptId: pins.attemptId,
      runtimeSessionId: pins.runtimeSessionId,
    },
    publication: {
      schemaVersion: 'pi-lead-publication/v1',
      workspaceId: product.sourceControlPlaneWorkspaceId,
      intentId: product.intentId,
      dispatchId: pins.dispatchId,
      preparationRef: pins.preparationRef,
      executionId: pins.executionId,
      attemptId: pins.attemptId,
      runtimeSessionId: pins.runtimeSessionId,
      selectionRef: pins.selectionRef,
      selectionRevision: pins.selectionRevision,
      canonicalActorPrincipalId: `user:${product.actorUserId}`,
      authorityRevision: 1,
      resultContentDigest: `sha256:${createHash('sha256').update('Exact source answer\n', 'utf8').digest('hex')}`,
      expiresAt: new Date(now + 20_000).toISOString(),
    },
  }
}
test('actual shared contracts accept canonical host/source projection with original prompt and fixed expiry', () => {
  const first = sourceLeadProductSnapshot(product, { contracts, lifetimeMs: 300_000, now })
  const later = sourceLeadProductSnapshot(product, {
    contracts,
    lifetimeMs: 300_000,
    now: now + 1_000,
  })
  expect(first).toEqual(later)
  expect(first.prompt).toBe(product.prompt)
  expect(first.authority.host.workspaceId).toBe(product.controlPlaneWorkspaceId)
  expect(first.authority.source.workspaceId).toBe(product.sourceControlPlaneWorkspaceId)
  expect(first.authority.source.profileId).toBe(product.profileId)
  expect(first.expiresAt).toBe(
    new Date(Date.parse(product.intentCreatedAt) + 300_000).toISOString()
  )
})
test('missing real candidate contracts, host substitution and expired intents fail closed', () => {
  expect(() =>
    sourceLeadProductSnapshot(product, {
      contracts: {} as typeof contracts,
      lifetimeMs: 300_000,
      now,
    })
  ).toThrow()
  expect(() =>
    sourceLeadProductSnapshot(
      { ...product, sourceControlPlaneWorkspaceId: product.controlPlaneWorkspaceId },
      { contracts, lifetimeMs: 300_000, now }
    )
  ).toThrow()
  expect(() =>
    sourceLeadProductSnapshot(product, { contracts, lifetimeMs: 300_000, now: now + 300_000 })
  ).toThrow()
})
test('qualified source publication matches locked product and all retained pins with exact UTF8 digest', () => {
  expect(
    isSourceLeadPublicationCurrent(product, pins, proof(), 'Exact source answer\n', {
      contracts,
      lifetimeMs: 300_000,
      now,
    })
  ).toBe(true)
  expect(
    isSourceLeadPublicationCurrent(product, pins, proof(), 'Exact source answer', {
      contracts,
      lifetimeMs: 300_000,
      now,
    })
  ).toBe(false)
})
test('changed host audience/enlistment, source profile, intent lifetime or session cannot publish', () => {
  for (const changed of [
    { ...product, audience: ['user:changed'] },
    { ...product, enlistmentRevision: 2 },
    { ...product, profileRevision: 2 },
    { ...product, sourceControlPlaneWorkspaceId: id('wsp', '8') },
  ])
    expect(
      isSourceLeadPublicationCurrent(changed, pins, proof(), 'Exact source answer\n', {
        contracts,
        lifetimeMs: 300_000,
        now,
      })
    ).toBe(false)
  const renewed = proof()
  renewed.binding.intentExpiresAt = new Date(now + 300_000).toISOString()
  expect(
    isSourceLeadPublicationCurrent(product, pins, renewed, 'Exact source answer\n', {
      contracts,
      lifetimeMs: 300_000,
      now,
    })
  ).toBe(false)
  expect(
    isSourceLeadPublicationCurrent(
      product,
      { ...pins, runtimeSessionId: id('ses', '8') },
      proof(),
      'Exact source answer\n',
      { contracts, lifetimeMs: 300_000, now }
    )
  ).toBe(false)
})
