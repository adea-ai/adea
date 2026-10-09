import { describe, expect, test } from 'bun:test'

import {
  isManagementOperationId,
  managementDomains,
  managementLanes,
  managementOperation,
  managementOperationIds,
  managementOperationLanes,
  managementOperations,
  managementOperationSupport,
  managementUnsupportedReasons,
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
