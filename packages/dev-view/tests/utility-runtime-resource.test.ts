import { describe, expect, test } from 'bun:test'
import { createRoot, createSignal } from 'solid-js'

import type { Scope } from '@adea-ai/types/dev-runtime'
import type { DevRuntimeService } from '../src/platform'
import {
  createDevUtilityResource,
  createDevUtilityResourceRequest,
} from '../src/utility/runtime-resource'

const scope = (workspaceId: string): Scope => ({
  accountId: 'account-1',
  workspaceId,
  runtimeNodeId: 'node-1',
})

function runtimeService(preferenceScope: () => Scope | undefined): DevRuntimeService {
  return {
    state: () => ({ status: 'ready' }),
    preferenceScope,
    capabilitySnapshot: async () => {
      throw new Error('capability snapshot is outside this test')
    },
    execute: async () => {
      throw new Error('execute is outside this test')
    },
  }
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 40 && !check(); attempt += 1)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(check()).toBe(true)
}

describe('cross-view utility resource identity', () => {
  test('hides and rejects late reads across selected session and workspace changes', async () => {
    const pending = new Map<string, (value: string) => void>()
    const [fixture, setFixture] = createRoot((dispose) => {
      const [currentScope, setCurrentScope] = createSignal<Scope | undefined>(scope('workspace-a'))
      const [runtimeSessionId, setRuntimeSessionId] = createSignal('session-a')
      const service = runtimeService(currentScope)
      const request = createDevUtilityResourceRequest(() => ({
        runtime: service,
        runtimeSessionId: runtimeSessionId(),
      }))
      const [snapshot] = createDevUtilityResource(request, async (key) => {
        const requestKey = `${key.scope?.workspaceId}:${key.runtimeSessionId}`
        return new Promise<string>((resolve) => pending.set(requestKey, resolve))
      })
      return [
        { dispose, request, snapshot },
        { setCurrentScope, setRuntimeSessionId },
      ] as const
    })

    try {
      await waitFor(() => pending.has('workspace-a:session-a'))
      setFixture.setRuntimeSessionId('session-b')
      await waitFor(() => pending.has('workspace-a:session-b'))
      expect(fixture.snapshot()).toBeUndefined()

      pending.get('workspace-a:session-a')?.('old session')
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(fixture.snapshot()).toBeUndefined()

      setFixture.setCurrentScope(scope('workspace-b'))
      await waitFor(() => pending.has('workspace-b:session-b'))
      pending.get('workspace-a:session-b')?.('old workspace')
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(fixture.snapshot()).toBeUndefined()

      pending.get('workspace-b:session-b')?.('current session')
      await waitFor(() => fixture.snapshot()?.value === 'current session')
      expect(fixture.snapshot()?.request.scope?.workspaceId).toBe('workspace-b')
      expect(fixture.snapshot()?.request.runtimeSessionId).toBe('session-b')
    } finally {
      fixture.dispose()
    }
  })
})
