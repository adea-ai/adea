import { describe, expect, test } from 'bun:test'

import {
  isManagementOperationId,
  assertManagementAuthorityCurrent,
  ManagementAuthorityError,
  managementAuthorityReasonCodes,
  managementBindingsEqual,
  managementCallBinding,
  managementCanonicalInput,
  managementDomains,
  managementInputDigest,
  managementLanes,
  managementOperation,
  managementOperationIds,
  managementOperationLanes,
  managementOperations,
  managementOperationSupport,
  managementUnsupportedReasons,
  parseManagementAuthorityDecision,
  validateManagementAuthorityDecision,
} from '../src/management'
import { devOperationDefinitions } from '../src/dev-runtime-registry'

describe('management operation inventory (#1215)', () => {
  test('names every domain and keeps operation ids unique', () => {
    expect(new Set(managementOperationIds).size).toBe(managementOperationIds.length)
    for (const domain of managementDomains) {
      expect(
        managementOperationIds.filter((id) => managementOperations[id].domain === domain).length
      ).toBeGreaterThan(0)
    }
    for (const id of managementOperationIds) expect(managementOperations[id]).toBeDefined()
    expect(Object.keys(managementOperations).toSorted()).toEqual(
      [...managementOperationIds].toSorted()
    )
  })

  test('every cloud operation carries a permission and a web/desktop binding', () => {
    for (const id of managementOperationIds) {
      const operation = managementOperations[id]
      if (operation.surface !== 'cloud') continue
      expect(operation.permission).not.toBeNull()
      expect(operation.capability).toBeNull()
      expect(operation.api.kind === 'web' || operation.api.kind === 'desktop').toBe(true)
      if (operation.api.kind === 'device') throw new Error('unreachable')
    }
  })

  test('every device operation binds an existing dev registry operation and capability', () => {
    for (const id of managementOperationIds) {
      const operation = managementOperations[id]
      if (operation.surface !== 'device') continue
      expect(operation.permission).toBeNull()
      expect(operation.api.kind === 'device' || operation.api.kind === 'desktop').toBe(true)
      // Dev Runtime operations must exist in the generated registry and name
      // a capability the registry actually grants; desktop-bridge operations
      // carry the desktop surface's own authority instead.
      if (operation.api.kind !== 'device') {
        expect(operation.capability).toBeNull()
        continue
      }
      const definition =
        devOperationDefinitions[operation.api.operation as keyof typeof devOperationDefinitions]
      expect(definition).toBeDefined()
      expect(operation.capability).not.toBeNull()
      expect(definition.capabilities).toContain(operation.capability)
    }
  })

  test('classifies unsupported lanes with typed reasons only', () => {
    for (const id of managementOperationIds) {
      for (const lane of managementLanes) {
        const state = managementOperations[id].lanes[lane]
        if (state === 'supported') continue
        expect(managementUnsupportedReasons).toContain(state)
      }
    }
  })

  test('keeps device-local management off the lead and web lanes with a typed reason', () => {
    for (const id of managementOperationIds) {
      const operation = managementOperations[id]
      if (operation.surface !== 'device') continue
      expect(managementOperationSupport(id, 'lead')).toEqual({
        reason: 'device_required',
        state: 'unsupported',
      })
      expect(managementOperationSupport(id, 'web')).toEqual({
        reason: 'device_required',
        state: 'unsupported',
      })
      expect(managementOperationSupport(id, 'desktop')).toEqual({ state: 'supported' })
    }
  })

  test('keeps shared cloud project operations callable on all lanes', () => {
    expect(managementOperationLanes('project.update')).toEqual(['web', 'desktop', 'lead'])
    expect(managementOperationLanes('config.workspace.update')).toEqual(['web', 'desktop', 'lead'])
    expect(managementOperationSupport('project.delete', 'lead')).toEqual({ state: 'supported' })
  })

  test('classifies the per-user workspace order and unused dedicated flows as typed gaps', () => {
    expect(managementOperationSupport('config.workspace.reorder', 'lead')).toEqual({
      reason: 'not_implemented',
      state: 'unsupported',
    })
    expect(managementOperationSupport('config.workspace.archive', 'web')).toEqual({
      reason: 'not_implemented',
      state: 'unsupported',
    })
    expect(managementOperationSupport('config.workspace.delete', 'lead')).toEqual({
      reason: 'device_required',
      state: 'unsupported',
    })
  })

  test('records the exact revision, confirmation, audit and recovery contract', () => {
    expect(managementOperation('memory.entry.update')).toMatchObject({
      confirmation: 'none',
      recovery: 'version_conflict',
      revision: 'memory_revision',
    })
    expect(managementOperation('worktree.cleanup.commit')).toMatchObject({
      confirmation: 'plan_commit',
      recovery: 'resumable',
      revision: 'plan_digest',
    })
    expect(managementOperation('project.delete')).toMatchObject({
      confirmation: 'explicit',
      permission: 'workspace.update',
      revision: 'none',
    })
    expect(managementOperation('config.workspace.update')).toMatchObject({
      permission: 'workspace.update',
      revision: 'workspace_version',
      recovery: 'version_conflict',
    })
  })

  test('only accepts known operation ids and freezes the catalog', () => {
    expect(isManagementOperationId('project.update')).toBe(true)
    expect(isManagementOperationId('project.unknown')).toBe(false)
    expect(isManagementOperationId(undefined)).toBe(false)
    expect(Object.isFrozen(managementOperations)).toBe(true)
    expect(JSON.parse(JSON.stringify(managementOperations))).toEqual(managementOperations)
  })
})

const NOW = Date.parse('2026-10-09T00:00:00.000Z')
const TARGET = '0f3a2e1c-0000-4000-8000-000000000002'
const WORKSPACE = '0f3a2e1c-0000-4000-8000-000000000001'

async function decisionFor(overrides: Partial<Record<string, unknown>> = {}) {
  const binding = await managementCallBinding({
    input: { name: 'Renamed' },
    operation: 'project.update',
    targetId: TARGET,
    workspaceId: WORKSPACE,
  })
  if (!binding) throw new Error('unreachable')
  return {
    approval: {
      audienceRef: 'audience:fixture',
      expiresAt: new Date(NOW + 120_000).toISOString(),
      interactionId: 'interaction-1',
    },
    audienceRef: 'audience:fixture',
    authorityRef: 'authority-1',
    authorityRevision: 7,
    binding,
    decision: 'allowed' as const,
    decisionId: 'decision-1',
    expiresAt: new Date(NOW + 60_000).toISOString(),
    intentId: 'intent-1',
    issuedAt: new Date(NOW - 1_000).toISOString(),
    leadAgentId: 'agent-lead-1',
    planRef: 'plan:fixture',
    planRevision: 3,
    principal: { kind: 'user' as const, userId: 'user-1' },
    schemaVersion: 'adea-management-authority/v1' as const,
    ...overrides,
  }
}

describe('management authority binding (#1215)', () => {
  test('canonical input is order-stable and rejects non-JSON values', () => {
    expect(managementCanonicalInput({ b: 1, a: [true, null, 'x'] })).toBe(
      '{"a":[true,null,"x"],"b":1}'
    )
    expect(managementCanonicalInput({ a: { d: 2, c: 1 }, b: 0 })).toBe('{"a":{"c":1,"d":2},"b":0}')
    for (const invalid of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { a: undefined },
      { a: 1n },
      { a: () => undefined },
      new Date(),
    ])
      expect(managementCanonicalInput(invalid)).toBeNull()
  })

  test('input digests are stable and change with any bound field', async () => {
    const first = await managementInputDigest({ a: 1, b: [2, 3] })
    const reordered = await managementInputDigest({ b: [2, 3], a: 1 })
    expect(first).toBe(reordered)
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(await managementInputDigest({ a: 1, b: [2, 4] })).not.toBe(first)
  })

  test('call bindings carry canonical action, input and target digests plus cleartext', async () => {
    const binding = await managementCallBinding({
      input: { name: 'Renamed' },
      operation: 'project.update',
      targetId: TARGET,
      workspaceId: WORKSPACE,
    })
    expect(binding).not.toBeNull()
    if (!binding) throw new Error('unreachable')
    expect(binding.actionDigest).toBe(await managementInputDigest({ operation: 'project.update' }))
    expect(binding.inputDigest).toBe(await managementInputDigest({ name: 'Renamed' }))
    expect(binding.targetDigest).toBe(await managementInputDigest({ targetId: TARGET }))
    expect(binding).toMatchObject({
      operation: 'project.update',
      targetId: TARGET,
      workspaceId: WORKSPACE,
    })
    expect(managementBindingsEqual(binding, { ...binding })).toBe(true)
    for (const changed of [
      { ...binding, workspaceId: '0f3a2e1c-0000-4000-8000-00000000aaaa' },
      { ...binding, operation: 'project.delete' as const },
      { ...binding, targetId: null },
      { ...binding, actionDigest: `sha256:${'0'.repeat(64)}` as const },
      { ...binding, inputDigest: `sha256:${'0'.repeat(64)}` as const },
      { ...binding, targetDigest: `sha256:${'0'.repeat(64)}` as const },
    ])
      expect(managementBindingsEqual(binding, changed)).toBe(false)
    expect(
      await managementCallBinding({
        input: { name: 'Renamed' },
        operation: 'project.update',
        targetId: TARGET,
        workspaceId: '',
      })
    ).toBeNull()
  })

  test('the decision parser rejects unknown keys, wrong versions and malformed fields', async () => {
    const valid = await decisionFor()
    expect(parseManagementAuthorityDecision(valid)).toEqual(valid)
    for (const invalid of [
      null,
      {},
      { ...valid, extra: true },
      { ...valid, schemaVersion: 'adea-management-authority/v2' },
      { ...valid, authorityRef: '' },
      { ...valid, decision: 'maybe' },
      { ...valid, authorityRevision: 0 },
      { ...valid, planRef: '' },
      { ...valid, planRevision: 0 },
      { ...valid, audienceRef: '' },
      { ...valid, approval: { ...valid.approval, interactionId: '' } },
      { ...valid, approval: { ...valid.approval, audienceRef: '' } },
      { ...valid, approval: { ...valid.approval, expiresAt: '' } },
      { ...valid, approval: { ...valid.approval, extra: true } },
      { ...valid, binding: { ...valid.binding, inputDigest: 'sha256:abc' } },
      { ...valid, binding: { ...valid.binding, actionDigest: 'not-a-digest' } },
      { ...valid, binding: { ...valid.binding, targetDigest: 'not-a-digest' } },
      { ...valid, binding: { ...valid.binding, operation: 'project.unknown' } },
      { ...valid, principal: { kind: 'service', serviceId: 'svc-1' } },
      { ...valid, issuedAt: 1 },
    ])
      expect(parseManagementAuthorityDecision(invalid)).toBeNull()
  })

  test('the decision validator enforces currentness and exact-call identity', async () => {
    const decision = parseManagementAuthorityDecision(await decisionFor())
    if (!decision) throw new Error('unreachable')
    const expected = {
      authorityRef: decision.authorityRef,
      binding: decision.binding,
      intentId: decision.intentId,
      leadAgentId: decision.leadAgentId,
      now: NOW,
    }
    expect(validateManagementAuthorityDecision(decision, expected)).toBeNull()
    for (const changed of [
      { ...decision.binding, actionDigest: `sha256:${'0'.repeat(64)}` as const },
      { ...decision.binding, inputDigest: `sha256:${'0'.repeat(64)}` as const },
      { ...decision.binding, targetDigest: `sha256:${'0'.repeat(64)}` as const },
      { ...decision.binding, targetId: 'other' },
    ])
      expect(validateManagementAuthorityDecision(decision, { ...expected, binding: changed })).toBe(
        'authority_binding_mismatch'
      )
    expect(validateManagementAuthorityDecision(decision, { ...expected, intentId: 'other' })).toBe(
      'authority_binding_mismatch'
    )
    expect(validateManagementAuthorityDecision({ ...decision, decision: 'denied' }, expected)).toBe(
      'authority_denied'
    )
    expect(validateManagementAuthorityDecision(decision, { ...expected, now: NOW + 60_000 })).toBe(
      'authority_expired'
    )
    expect(validateManagementAuthorityDecision(decision, { ...expected, now: NOW - 2_000 })).toBe(
      'authority_not_yet_valid'
    )
    expect(
      validateManagementAuthorityDecision(
        {
          ...decision,
          approval: { ...decision.approval, expiresAt: new Date(NOW - 1).toISOString() },
        },
        expected
      )
    ).toBe('authority_approval_expired')
  })

  test('the server-only assertCurrent equivalent throws typed refusals and returns void on success', async () => {
    const decision = parseManagementAuthorityDecision(await decisionFor())
    if (!decision) throw new Error('unreachable')
    const expected = {
      authorityRef: decision.authorityRef,
      binding: decision.binding,
      intentId: decision.intentId,
      leadAgentId: decision.leadAgentId,
      now: NOW,
    }
    expect(assertManagementAuthorityCurrent(decision, expected)).toBeUndefined()
    expect(() =>
      assertManagementAuthorityCurrent(decision, {
        ...expected,
        binding: { ...decision.binding, targetId: 'other' },
      })
    ).toThrow(ManagementAuthorityError)
    try {
      assertManagementAuthorityCurrent(decision, { ...expected, now: NOW + 60_000 })
      throw new Error('unreachable')
    } catch (error) {
      expect(error).toBeInstanceOf(ManagementAuthorityError)
      expect((error as ManagementAuthorityError).reason).toBe('authority_expired')
    }
  })

  test('the authority reason vocabulary is closed', () => {
    expect(managementAuthorityReasonCodes).toEqual([
      'authority_unavailable',
      'authority_malformed',
      'authority_binding_mismatch',
      'authority_denied',
      'authority_expired',
      'authority_not_yet_valid',
      'authority_approval_expired',
      'authority_replay',
    ])
    expect(Object.isFrozen(managementAuthorityReasonCodes)).toBe(true)
  })
})
