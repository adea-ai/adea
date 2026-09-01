import { describe, expect, test } from 'bun:test'

import type { CloudContentRefAuthority, PrivateContentAuthority } from '../../src/private-content'
import { persistPrivateContent, resolveFutureExecutionInput } from '../../src/private-content'

describe('private content reconciliation', () => {
  test('keeps plaintext out of cloud calls and resolves a deterministic execution fixture', async () => {
    const canary = 'PRIVATE-FUTURE-EXECUTION-CANARY-91824'
    const workspaceId = '10000000-0000-4000-8000-000000000001'
    const contentId = '20000000-0000-4000-8000-000000000002'
    const taskId = '30000000-0000-4000-8000-000000000003'
    const cloudCalls: unknown[] = []
    let stored = ''
    const localRef = {
      availability: 'available' as const,
      contentType: 'task_input' as const,
      createdAt: '2026-08-30T00:00:00.000Z',
      digestSha256: 'c'.repeat(64),
      id: contentId,
      keyVersion: 1,
      revision: 1,
      schemaVersion: 1,
      sensitivity: 'restricted' as const,
      storagePolicy: 'local_authority' as const,
      synchronizationPolicy: 'local_only' as const,
      taskId,
      updatedAt: '2026-08-30T00:00:00.000Z',
      workspaceId,
    }
    const cloud: CloudContentRefAuthority = {
      async createContentRef(_workspaceId, input) {
        cloudCalls.push(input)
        return { contentRef: { ...localRef, availability: input.availability } }
      },
      async updateContentRef(_workspaceId, _contentId, input) {
        cloudCalls.push(input)
        return { contentRef: localRef }
      },
    }
    const local: PrivateContentAuthority = {
      async create(input) {
        stored = input.plaintext
        return localRef
      },
      async read() {
        return { contentRef: localRef, plaintext: stored }
      },
    }

    await persistPrivateContent(
      cloud,
      {
        contentId,
        contentType: 'task_input',
        plaintext: canary,
        sensitivity: 'restricted',
        storagePolicy: 'local_authority',
        synchronizationPolicy: 'local_only',
        taskId,
        workspaceId,
      },
      local
    )

    expect(JSON.stringify(cloudCalls)).not.toContain(canary)
    expect(await resolveFutureExecutionInput(workspaceId, contentId, local)).toBe(canary)
  })
})
