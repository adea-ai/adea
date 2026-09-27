import { describe, expect, test } from 'bun:test'

import { createPresentedRuntimeSession } from '../shell/src/notifications/presented-runtime-session'
import type { Scope } from '../shell/src/dev-runtime/channel/identity'

const scopeA: Scope = {
  accountId: 'account-a',
  workspaceId: 'workspace-a',
  runtimeNodeId: 'node-a',
}

const scopeB: Scope = {
  accountId: 'account-b',
  workspaceId: 'workspace-b',
  runtimeNodeId: 'node-b',
}

describe('presented runtime session', () => {
  test('revalidates and preserves the selected session across same-scope host adoption', () => {
    let scope: Scope | undefined = scopeA
    let sessions = new Map([['runtime-1', { id: 'runtime-1', archived: false }]])
    const presentation = createPresentedRuntimeSession({
      currentScope: () => scope,
      resolveSession: (id) => sessions.get(id),
    })

    presentation.set('runtime-1')
    expect(presentation.current()).toBe('runtime-1')

    // A sidecar adoption recomposes the host but does not change its authority.
    sessions = new Map([['runtime-1', { id: 'runtime-1', archived: false }]])
    presentation.revalidateAfterComposition()

    expect(presentation.current()).toBe('runtime-1')
  })

  test('clears the selected session when the new host cannot validate it', () => {
    let sessions = new Map([['runtime-1', { id: 'runtime-1', archived: false }]])
    const presentation = createPresentedRuntimeSession({
      currentScope: () => scopeA,
      resolveSession: (id) => sessions.get(id),
    })

    presentation.set('runtime-1')
    sessions = new Map([['runtime-1', { id: 'runtime-1', archived: true }]])
    presentation.revalidateAfterComposition()

    expect(presentation.current()).toBeUndefined()
  })

  test('clears rather than carrying a selected ID into a new authenticated scope', () => {
    let scope: Scope | undefined = scopeA
    const presentation = createPresentedRuntimeSession({
      currentScope: () => scope,
      resolveSession: (id) => ({ id, archived: false }),
    })

    presentation.set('runtime-1')
    scope = scopeB
    presentation.revalidateAfterComposition()

    expect(presentation.current()).toBeUndefined()
  })
})
