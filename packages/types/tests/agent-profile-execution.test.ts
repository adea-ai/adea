import { describe, expect, test } from 'bun:test'

import {
  authorizeAgentProfileChange,
  resolveAgentProfileExecution,
  resolveAgentProfileState,
  type AgentProfileCatalogEntry,
  type AgentProfileCatalogPort,
} from '../src/agent-profile-execution'
import type { AgentExecutionIdentity, ExecutionProfilePin } from '../src/execution-location'

const checkedAt = '2026-09-25T12:00:00.000Z'

const identity: AgentExecutionIdentity = {
  controlPlaneAgentId: 'agt_01JBBCDEF0123456789ABCDEFG',
  id: 'agent_01JBBCDEF0123456789ABCDEFG',
}

const approvedPin: ExecutionProfilePin = {
  id: 'apr_01JBBCDEF0123456789ABCDEFG',
  version: '3',
  revision: 1,
}

/**
 * The deterministic profile catalog the fixture stands up. It is not a live
 * Control Plane: every version it exposes is a fixture row, and every row is
 * an exact (id, version, revision) pin.
 */
const catalogRows: readonly AgentProfileCatalogEntry[] = [
  {
    profileId: approvedPin.id,
    version: '3',
    revision: 1,
    lifecycle: 'published',
    approved: true,
    compatible: true,
  },
  {
    profileId: approvedPin.id,
    version: '4',
    revision: 1,
    lifecycle: 'published',
    approved: true,
    compatible: true,
  },
  {
    profileId: approvedPin.id,
    version: '2',
    revision: 3,
    lifecycle: 'deprecated',
    approved: true,
    compatible: true,
  },
  {
    profileId: approvedPin.id,
    version: '1',
    revision: 4,
    lifecycle: 'revoked',
    approved: true,
    compatible: true,
  },
  {
    profileId: approvedPin.id,
    version: '5',
    revision: 1,
    lifecycle: 'published',
    approved: true,
    compatible: false,
  },
  {
    profileId: approvedPin.id,
    version: '6',
    revision: 1,
    lifecycle: 'published',
    approved: false,
    compatible: true,
  },
]

function catalog(overrides: { unavailable?: boolean } = {}): AgentProfileCatalogPort {
  return {
    async readProfileVersion(input) {
      if (overrides.unavailable === true) throw new Error('CP_CATALOG_UNAVAILABLE')
      return catalogRows.find(
        (row) =>
          row.profileId === input.profileId &&
          row.version === input.version &&
          row.revision === input.revision
      )
    },
  }
}

const upgradedPin: ExecutionProfilePin = { id: approvedPin.id, version: '4', revision: 1 }
const rolledBackPin: ExecutionProfilePin = { id: approvedPin.id, version: '3', revision: 1 }

describe('CP #41 agent profile projection consumer', () => {
  test('derives the read-time state of every catalog state from the exact pin', () => {
    expect(resolveAgentProfileState(undefined)).toBe('missing')
    expect(
      resolveAgentProfileState({
        profileId: approvedPin.id,
        version: '3',
        revision: 1,
        lifecycle: 'published',
        approved: true,
        compatible: true,
      })
    ).toBe('available')
    expect(
      resolveAgentProfileState({
        profileId: approvedPin.id,
        version: '2',
        revision: 3,
        lifecycle: 'deprecated',
        approved: true,
        compatible: true,
      })
    ).toBe('deprecated')
    expect(
      resolveAgentProfileState({
        profileId: approvedPin.id,
        version: '1',
        revision: 4,
        lifecycle: 'revoked',
        approved: true,
        compatible: true,
      })
    ).toBe('revoked')
    expect(
      resolveAgentProfileState({
        profileId: approvedPin.id,
        version: '5',
        revision: 1,
        lifecycle: 'published',
        approved: true,
        compatible: false,
      })
    ).toBe('incompatible')
    expect(
      resolveAgentProfileState({
        profileId: approvedPin.id,
        version: '6',
        revision: 1,
        lifecycle: 'published',
        approved: false,
        compatible: true,
      })
    ).toBe('unapproved')
  })

  test('resolves an approved pin to an executable decision', async () => {
    const resolution = await resolveAgentProfileExecution({
      identity,
      pin: approvedPin,
      catalog: catalog(),
      checkedAt,
    })
    expect(resolution.readModel.state).toBe('available')
    expect(resolution.readModel.pin).toEqual(approvedPin)
    expect(resolution.readModel.identity).toEqual(identity)
    expect(resolution.decision).toEqual({
      action: 'execute',
      pin: approvedPin,
      reason: 'profile_available',
    })
  })

  test('never resolves a newer version in place of the saved pin', async () => {
    const resolution = await resolveAgentProfileExecution({
      identity,
      pin: approvedPin,
      catalog: catalog(),
      checkedAt,
    })
    expect(resolution.readModel.pin.version).toBe('3')
    expect(resolution.readModel.pin.revision).toBe(1)
  })

  test('blocks a missing version with a remediation', async () => {
    const resolution = await resolveAgentProfileExecution({
      identity,
      pin: { id: approvedPin.id, version: '9', revision: 1 },
      catalog: catalog(),
      checkedAt,
    })
    expect(resolution.readModel.state).toBe('missing')
    expect(resolution.decision).toEqual({
      action: 'block',
      blocker: 'profile_missing',
      pin: { id: approvedPin.id, version: '9', revision: 1 },
      remediation: { action: 'select_available_profile_version' },
    })
  })

  test('blocks a revoked version', async () => {
    const resolution = await resolveAgentProfileExecution({
      identity,
      pin: { id: approvedPin.id, version: '1', revision: 4 },
      catalog: catalog(),
      checkedAt,
    })
    expect(resolution.readModel.state).toBe('revoked')
    expect(resolution.decision).toMatchObject({
      action: 'block',
      blocker: 'profile_revoked',
      remediation: { action: 'select_available_profile_version' },
    })
  })

  test('blocks a deprecated version with an upgrade remediation', async () => {
    const resolution = await resolveAgentProfileExecution({
      identity,
      pin: { id: approvedPin.id, version: '2', revision: 3 },
      catalog: catalog(),
      checkedAt,
    })
    expect(resolution.readModel.state).toBe('deprecated')
    expect(resolution.decision).toMatchObject({
      action: 'block',
      blocker: 'profile_deprecated',
      remediation: { action: 'upgrade_profile_version' },
    })
  })

  test('blocks an unavailable catalog read with a retry remediation', async () => {
    const resolution = await resolveAgentProfileExecution({
      identity,
      pin: approvedPin,
      catalog: catalog({ unavailable: true }),
      checkedAt,
    })
    expect(resolution.readModel.state).toBe('unavailable')
    expect(resolution.decision).toMatchObject({
      action: 'block',
      blocker: 'profile_unavailable',
      remediation: { action: 'retry_profile_check' },
    })
  })

  test('applies an authorized profile upgrade and leaves an audit record', async () => {
    const outcome = await authorizeAgentProfileChange({
      identity,
      currentPin: approvedPin,
      requestedPin: upgradedPin,
      authorization: {
        authorizedBy: 'svc_agent-hq',
        authorizedAt: '2026-09-25T11:59:00.000Z',
        approvedPin: upgradedPin,
      },
      catalog: catalog(),
      decidedAt: checkedAt,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected the authorized upgrade to be applied')
    expect(outcome.pin).toEqual(upgradedPin)
    expect(outcome.audit).toEqual({
      agentId: identity.id,
      previousPin: approvedPin,
      requestedPin: upgradedPin,
      authorizedBy: 'svc_agent-hq',
      authorizedAt: '2026-09-25T11:59:00.000Z',
      decidedAt: checkedAt,
    })
  })

  test('applies an authorized rollback to the exact pinned version', async () => {
    const outcome = await authorizeAgentProfileChange({
      identity,
      currentPin: upgradedPin,
      requestedPin: rolledBackPin,
      authorization: {
        authorizedBy: 'svc_agent-hq',
        authorizedAt: '2026-09-25T11:59:00.000Z',
        approvedPin: rolledBackPin,
      },
      catalog: catalog(),
      decidedAt: checkedAt,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected the authorized rollback to be applied')
    expect(outcome.pin).toEqual(rolledBackPin)
    expect(outcome.audit.previousPin).toEqual(upgradedPin)
  })

  test('refuses an unauthorized profile change', async () => {
    const outcome = await authorizeAgentProfileChange({
      identity,
      currentPin: approvedPin,
      requestedPin: upgradedPin,
      authorization: undefined,
      catalog: catalog(),
      decidedAt: checkedAt,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected the unauthorized change to be refused')
    expect(outcome.blocker).toBe('profile_unapproved')
    expect(outcome.remediation).toEqual({ action: 'approve_profile_version' })
  })

  test('refuses a change the authorization is not bound to', async () => {
    const outcome = await authorizeAgentProfileChange({
      identity,
      currentPin: approvedPin,
      requestedPin: upgradedPin,
      authorization: {
        authorizedBy: 'svc_agent-hq',
        authorizedAt: '2026-09-25T11:59:00.000Z',
        approvedPin: approvedPin,
      },
      catalog: catalog(),
      decidedAt: checkedAt,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected the unbound authorization to be refused')
    expect(outcome.blocker).toBe('profile_unapproved')
  })

  test('refuses a change to a version that does not resolve', async () => {
    const outcome = await authorizeAgentProfileChange({
      identity,
      currentPin: approvedPin,
      requestedPin: { id: approvedPin.id, version: '1', revision: 4 },
      authorization: {
        authorizedBy: 'svc_agent-hq',
        authorizedAt: '2026-09-25T11:59:00.000Z',
        approvedPin: { id: approvedPin.id, version: '1', revision: 4 },
      },
      catalog: catalog(),
      decidedAt: checkedAt,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected the revoked target to be refused')
    expect(outcome.blocker).toBe('profile_revoked')
  })

  test('refuses an authorized change when the catalog read cannot be completed', async () => {
    const outcome = await authorizeAgentProfileChange({
      identity,
      currentPin: approvedPin,
      requestedPin: upgradedPin,
      authorization: {
        authorizedBy: 'svc_agent-hq',
        authorizedAt: '2026-09-25T11:59:00.000Z',
        approvedPin: upgradedPin,
      },
      catalog: catalog({ unavailable: true }),
      decidedAt: checkedAt,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok)
      throw new Error('expected the change to be refused when the catalog is unavailable')
    expect(outcome.blocker).toBe('profile_unavailable')
    expect(outcome.remediation).toEqual({ action: 'retry_profile_check' })
    // The unavailable read must not move the Agent. The failure carries the
    // requested pin and no audit record, so the caller retries the same pin
    // instead of having applied an unauthorized or unverified change.
    expect(outcome.requestedPin).toEqual(upgradedPin)
  })

  test('decides a later profile change against the pin the previous change applied', async () => {
    // A second change is decided against the pin the first change applied, not
    // against the pin the Agent started on. The caller keeps the saved pin under
    // a compare-and-set, so this consumer only has to bind the authorization to
    // the exact requested pin and never move the Agent on its own.
    const first = await authorizeAgentProfileChange({
      identity,
      currentPin: approvedPin,
      requestedPin: upgradedPin,
      authorization: {
        authorizedBy: 'svc_agent-hq',
        authorizedAt: '2026-09-25T11:59:00.000Z',
        approvedPin: upgradedPin,
      },
      catalog: catalog(),
      decidedAt: checkedAt,
    })
    expect(first.ok).toBe(true)
    const second = await authorizeAgentProfileChange({
      identity,
      currentPin: first.ok ? first.pin : approvedPin,
      requestedPin: { id: approvedPin.id, version: '5', revision: 1 },
      authorization: {
        authorizedBy: 'svc_agent-hq',
        authorizedAt: '2026-09-25T11:59:00.000Z',
        approvedPin: { id: approvedPin.id, version: '5', revision: 1 },
      },
      catalog: catalog(),
      decidedAt: checkedAt,
    })
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('expected the incompatible target to be refused')
    expect(second.blocker).toBe('profile_incompatible')
  })
  test('a deferred reader cannot turn an authorization for one version into a success for another', async () => {
    const requestedPin = { id: approvedPin.id, version: '4', revision: 1 }
    const mutating: AgentProfileCatalogPort = {
      async readProfileVersion(input) {
        // The caller mutates the pin it passed in while the lookup is in flight.
        requestedPin.version = '5'
        return catalogRows.find(
          (row) =>
            row.profileId === input.profileId &&
            row.version === input.version &&
            row.revision === input.revision
        )
      },
    }
    const outcome = await authorizeAgentProfileChange({
      identity,
      currentPin: approvedPin,
      requestedPin,
      authorization: {
        authorizedBy: 'svc_agent-hq',
        authorizedAt: '2026-09-25T11:59:00.000Z',
        approvedPin: { id: approvedPin.id, version: '4', revision: 1 },
      },
      catalog: mutating,
      decidedAt: checkedAt,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected the authorized version to be applied')
    // The authorization was for version 4, so version 4 is what may be applied.
    expect(outcome.pin.version).toBe('4')
    expect(outcome.audit.requestedPin.version).toBe('4')
    expect(outcome.audit.previousPin.version).toBe('3')
  })

  test('never returns a forbidden field from the caller', async () => {
    const identityWithExtras = { ...identity, secret: 'do-not-serialize' }
    const pinWithExtras = { ...approvedPin, secret: 'do-not-serialize' }
    const resolution = await resolveAgentProfileExecution({
      identity: identityWithExtras,
      pin: pinWithExtras,
      catalog: catalog(),
      checkedAt,
    })
    expect(JSON.stringify(resolution)).not.toContain('do-not-serialize')
    expect(Object.keys(resolution.readModel.identity).toSorted()).toEqual([
      'controlPlaneAgentId',
      'id',
    ])
    expect(Object.keys(resolution.readModel.pin).toSorted()).toEqual(['id', 'revision', 'version'])

    const refused = await authorizeAgentProfileChange({
      identity: identityWithExtras,
      currentPin: pinWithExtras,
      requestedPin: pinWithExtras,
      authorization: undefined,
      catalog: catalog(),
      decidedAt: checkedAt,
    })
    expect(JSON.stringify(refused)).not.toContain('do-not-serialize')
    expect(Object.keys(refused.requestedPin).toSorted()).toEqual(['id', 'revision', 'version'])

    const applied = await authorizeAgentProfileChange({
      identity: identityWithExtras,
      currentPin: pinWithExtras,
      requestedPin: { ...pinWithExtras, version: '4' },
      authorization: {
        authorizedBy: 'svc_agent-hq',
        authorizedAt: '2026-09-25T11:59:00.000Z',
        approvedPin: { id: approvedPin.id, version: '4', revision: 1 },
      },
      catalog: catalog(),
      decidedAt: checkedAt,
    })
    expect(JSON.stringify(applied)).not.toContain('do-not-serialize')
    if (!applied.ok) throw new Error('expected the authorized change to be applied')
    expect(Object.keys(applied.pin).toSorted()).toEqual(['id', 'revision', 'version'])
    expect(Object.keys(applied.audit.previousPin).toSorted()).toEqual(['id', 'revision', 'version'])
    expect(Object.keys(applied.audit.requestedPin).toSorted()).toEqual([
      'id',
      'revision',
      'version',
    ])
  })

  test('never returns a mutable alias of the caller objects', async () => {
    const pin = { id: approvedPin.id, version: '3', revision: 1 }
    const localIdentity = { controlPlaneAgentId: identity.controlPlaneAgentId, id: identity.id }
    const resolution = await resolveAgentProfileExecution({
      identity: localIdentity,
      pin,
      catalog: catalog(),
      checkedAt,
    })
    expect(resolution.readModel.pin).not.toBe(pin)
    expect(resolution.readModel.identity).not.toBe(localIdentity)
    expect(resolution.decision).not.toBe(resolution.readModel)
    expect(resolution.readModel.pin).not.toBe(resolution.decision.pin)
    pin.version = '9'
    localIdentity.id = 'mutated'
    expect(resolution.readModel.pin.version).toBe('3')
    expect(resolution.readModel.identity.id).toBe(identity.id)
  })
})
