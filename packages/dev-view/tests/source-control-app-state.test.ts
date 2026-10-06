import { describe, expect, test } from 'bun:test'
import type { GitHubAccount } from '@adea-ai/types/dev-runtime'

import type { ScmClient } from '../src/source-control-app/client'
import { defaultPreferences } from '../src/source-control-app/model/persistence'
import type { ScmProvider } from '../src/source-control-app/model/types'
import { createSourceControlState } from '../src/source-control-app/state'

const ACCOUNT: GitHubAccount = {
  provider: 'github',
  host: 'github.com',
  login: 'octocat',
  observedAt: '2026-10-03T12:00:00.000Z',
}

/**
 * A client whose `account` waits for the test to release it, so the state's
 * loading window is observable. Every other operation is unused here.
 */
function gatedAccountClient(): {
  client: ScmClient
  release(result: () => GitHubAccount): void
} {
  let settle: (result: () => GitHubAccount) => void = noRelease
  const client = {
    account: (_provider: ScmProvider = 'github') =>
      new Promise<GitHubAccount>((resolve, reject) => {
        settle = (result) => {
          try {
            resolve(result())
          } catch (error) {
            reject(error)
          }
        }
      }),
  }
  return { client: client as unknown as ScmClient, release: (result) => settle(result) }
}

function noRelease(): GitHubAccount {
  throw new Error('the account check was never released')
}

function createState(client: ScmClient) {
  return createSourceControlState({
    client,
    storage: {
      loadPreferences: () => ({ ...defaultPreferences }),
      savePreferences: () => undefined,
    } as never,
    now: () => 0,
  })
}

describe('source control app provider accounts', () => {
  test('a check reports loading while the last settled account stays readable', async () => {
    const { client, release } = gatedAccountClient()
    const state = createState(client)

    // Nothing has settled yet: the dialog row renders "not checked".
    expect(state.account('github').status).toBe('loading')
    expect(state.settledAccount('github')).toBeUndefined()

    const first = state.checkProvider('github')
    expect(state.account('github').status).toBe('loading')
    release(() => ACCOUNT)
    const result = await first
    expect(result.status).toBe('connected')
    expect(state.settledAccount('github')).toEqual({ status: 'connected', account: ACCOUNT })

    // A re-check flips the live account to loading first — the chip and
    // caption must announce it — but the settled account keeps the previous
    // verdict so the affected row renders through the check in place instead
    // of collapsing.
    const second = state.checkProvider('github')
    expect(state.account('github').status).toBe('loading')
    expect(state.settledAccount('github')).toEqual({ status: 'connected', account: ACCOUNT })
    release(() => {
      const error = new Error('gh is not authenticated') as Error & { code?: string }
      error.code = 'unauthenticated'
      throw error
    })
    const settled = await second
    expect(settled.status).toBe('disconnected')
    expect(state.account('github').status).toBe('disconnected')
    expect(state.settledAccount('github')?.status).toBe('disconnected')
  })

  test('providers settle independently', async () => {
    const { client, release } = gatedAccountClient()
    const state = createState(client)
    const github = state.checkProvider('github')
    release(() => ACCOUNT)
    await github
    expect(state.settledAccount('gitlab')).toBeUndefined()
    expect(state.settledAccount('github')?.status).toBe('connected')
  })
})
