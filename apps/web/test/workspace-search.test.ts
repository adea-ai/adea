import { expect, test } from 'bun:test'

import {
  legacyDirectoryIntentRouteKey,
  normalizeLegacyDirectorySearch,
  resolveLegacyDirectoryIntent,
  stripWorkspaceDeepLinkSearch,
  workspaceSearchKey,
  WORKSPACE_DEEP_LINK_KEYS,
} from '../src/lib/workspace-search'

/**
 * Regression for the stale deep-link completion (Adea #1207/#1234 task-board
 * failure): @tanstack/solid-router replaces the search with the value of
 * whichever overlapping navigate commits last (reproduced against the real
 * router in apps/web/e2e/workspace-navigation-race.spec.ts). A strip that
 * captures a value before a newer app switch would overwrite the switch and
 * drop `app=kanban`, unmounting the board. The functional updater applied by
 * consumeDeepLink strips only the deep-link keys from the latest search.
 */
test('a late deep-link completion cannot overwrite a newer app switch', () => {
  const beforeSwitch = { channel: 'c1', message: 'm1' }
  const switched = { ...beforeSwitch, app: 'kanban' }

  // The hazard: the old value snapshot, committed last, replaced the search
  // with the pre-switch state.
  const staleSnapshot = stripWorkspaceDeepLinkSearch(beforeSwitch)
  expect(staleSnapshot).not.toHaveProperty('app')

  // The fix: the strip runs against the latest search, so the switch survives
  // no matter when the completion lands.
  expect(stripWorkspaceDeepLinkSearch(switched)).toEqual({ app: 'kanban' })
})

test('the strip removes only the one-shot deep-link keys', () => {
  const stripped = stripWorkspaceDeepLinkSearch({
    app: 'kanban',
    channel: 'c1',
    directory: 'inbox',
    message: 'm1',
    task: 't1',
    thread: 'th1',
    view: 'chat',
    workspace: 'w1',
  })

  expect(stripped).toEqual({ app: 'kanban', directory: 'inbox', view: 'chat' })
  for (const key of WORKSPACE_DEEP_LINK_KEYS) expect(stripped).not.toHaveProperty(key)
})

test('legacy directory links normalize to the existing Chat surface and drop stale selections', () => {
  expect(
    normalizeLegacyDirectorySearch({
      app: 'kanban',
      channel: 'stale-channel',
      directory: 'inbox',
      message: 'stale-message',
      task: 'stale-task',
      thread: 'stale-thread',
      view: 'virtual',
      workspace: 'workspace-2',
    })
  ).toEqual({
    section: 'inbox',
    search: { view: 'chat', workspace: 'workspace-2' },
  })
  expect(normalizeLegacyDirectorySearch({ directory: 'unknown', view: 'dev' })).toEqual({
    search: { view: 'dev' },
  })
})

test('legacy Agents intent waits for a delayed switch to its explicit workspace', async () => {
  const sourceSearch = {
    channel: 'stale-channel',
    directory: 'agents',
    task: 'stale-task',
    view: 'virtual',
    workspace: 'workspace-team',
  }
  const normalized = normalizeLegacyDirectorySearch(sourceSearch)
  expect(normalized.section).toBe('agents')

  const intent = {
    accountPrincipalId: 'account-alice',
    routeKey: legacyDirectoryIntentRouteKey(normalized.search),
    section: 'agents' as const,
    sourceSearchKey: workspaceSearchKey(sourceSearch),
    workspaceId: 'workspace-team',
  }
  let activeWorkspaceId = 'workspace-home'
  let activeSurface: 'conversation' | 'agents' = 'conversation'
  let finishAuthorization!: () => void
  const authorization = new Promise<void>((resolve) => (finishAuthorization = resolve))
  const switchPromise = authorization.then(() => {
    // The workspace store resets the surface as the authorized switch lands.
    activeWorkspaceId = 'workspace-team'
    activeSurface = 'conversation'
  })
  const applyIfSettled = (search: object, principalId = 'account-alice') => {
    const result = resolveLegacyDirectoryIntent(intent, {
      accountPrincipalId: principalId,
      activeWorkspaceId,
      search,
    })
    if (result.status === 'settled') activeSurface = result.section
    return result
  }

  expect(applyIfSettled(sourceSearch)).toEqual({ status: 'pending' })
  expect(activeSurface).toBe('conversation')
  expect(applyIfSettled(normalized.search)).toEqual({ status: 'pending' })

  finishAuthorization()
  await switchPromise
  expect(applyIfSettled({ ...normalized.search, workspace: undefined, scene: 'work' })).toEqual({
    status: 'settled',
    section: 'agents',
  })
  expect(activeSurface).toBe('agents')

  expect(
    resolveLegacyDirectoryIntent(intent, {
      accountPrincipalId: 'account-bob',
      activeWorkspaceId,
      search: normalized.search,
    })
  ).toEqual({ status: 'superseded' })
  expect(
    resolveLegacyDirectoryIntent(intent, {
      accountPrincipalId: 'account-alice',
      activeWorkspaceId,
      search: { ...normalized.search, view: 'virtual' },
    })
  ).toEqual({ status: 'superseded' })
})
