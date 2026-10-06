import { describe, expect, test } from 'bun:test'

import type { CredentialRef, Scope } from '@adea-ai/types/dev-runtime'

import {
  DEVICE_DEFAULT_VALUE,
  connectionsNotice,
  gitHostingRows,
  harnessAccountRows,
  isConnectionsUnavailable,
} from '../../src/connections-model'
import type { WorkspaceConnectionsSnapshot } from '../../src/platform'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-00000000000a',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

function ref(id: string, host: string, overrides: Partial<CredentialRef> = {}): CredentialRef {
  return {
    id,
    scope: SCOPE,
    label: `${host} key`,
    host,
    kind: 'github_token',
    state: 'ready',
    version: 1,
    ...overrides,
  }
}

const GITHUB_REF = '00000000-0000-4000-8000-0000000000c1'
const GITLAB_REF = '00000000-0000-4000-8000-0000000000c2'
const SSH_REF = '00000000-0000-4000-8000-0000000000c3'
const ANTHROPIC_REF = '00000000-0000-4000-8000-0000000000c4'
const REVOKED_REF = '00000000-0000-4000-8000-0000000000c5'
const PROFILE_ID = '00000000-0000-4000-8000-0000000000d1'

function snapshot(overrides: Partial<WorkspaceConnectionsSnapshot['connections']> = {}) {
  return {
    connections: {
      scope: SCOPE,
      gitHosting: [],
      harnessAccounts: [],
      version: 0,
      availableHarnesses: [
        {
          harnessId: 'pi',
          displayName: 'Pi',
          accountHosts: ['api.anthropic.com', 'api.openai.com'],
        },
      ],
      ...overrides,
    },
    profiles: [
      {
        id: PROFILE_ID,
        harnessId: 'pi',
        label: 'Work',
        credentialRefId: ANTHROPIC_REF,
        version: 1,
      },
    ],
    credentialRefs: [
      ref(GITHUB_REF, 'github.com'),
      ref(GITLAB_REF, 'gitlab.example.com', { kind: 'git_https' }),
      ref(SSH_REF, 'github.com', { kind: 'ssh_key', label: 'ssh' }),
      ref(ANTHROPIC_REF, 'api.anthropic.com', { kind: 'other' }),
      ref(REVOKED_REF, 'github.com', { state: 'revoked', label: 'old token' }),
    ],
  } as WorkspaceConnectionsSnapshot
}

describe('workspace connections view model', () => {
  test('git hosting rows: one per host, device default first, usable refs only', () => {
    const rows = gitHostingRows(snapshot())
    expect(rows.map((row) => row.host)).toEqual(['github.com', 'gitlab.example.com'])
    const github = rows[0]!
    expect(github.value).toBe(DEVICE_DEFAULT_VALUE)
    expect(github.options).toEqual([
      { value: DEVICE_DEFAULT_VALUE, label: 'Use device default' },
      { value: GITHUB_REF, label: 'github.com key' },
    ])
    expect(github.detail).toContain('device default')
  })

  test('a binding to an unusable ref still renders, disabled, instead of vanishing', () => {
    const rows = gitHostingRows(
      snapshot({ gitHosting: [{ host: 'github.com', credentialRefId: REVOKED_REF }], version: 1 })
    )
    const github = rows.find((row) => row.host === 'github.com')!
    expect(github.value).toBe(REVOKED_REF)
    expect(github.options.at(-1)).toEqual({
      value: REVOKED_REF,
      label: 'old token (revoked)',
      disabled: true,
    })
    expect(github.detail).toContain('old token')
  })

  test('harness rows list profiles and the provider keys an account may name', () => {
    const [pi] = harnessAccountRows(
      snapshot({ harnessAccounts: [{ harnessId: 'pi', profileId: PROFILE_ID }], version: 1 })
    )
    expect(pi!.value).toBe(PROFILE_ID)
    expect(pi!.options.map((option) => option.value)).toEqual([DEVICE_DEFAULT_VALUE, PROFILE_ID])
    expect(pi!.accountCredentials).toEqual([
      { value: ANTHROPIC_REF, label: 'api.anthropic.com key · api.anthropic.com' },
    ])
    expect(pi!.detail).toContain('Work')
  })

  test('notices are typed and unavailable codes are recognized', () => {
    expect(connectionsNotice('Saving', { code: 'stale_version' })).toContain('changed elsewhere')
    expect(isConnectionsUnavailable({ code: 'capability_unavailable' })).toBe(true)
    expect(isConnectionsUnavailable({ code: 'stale_version' })).toBe(false)
    expect(isConnectionsUnavailable(new Error('boom'))).toBe(true)
  })
})
