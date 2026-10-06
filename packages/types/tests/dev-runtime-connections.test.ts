import { describe, expect, test } from 'bun:test'

import {
  decodeHarnessAccountProfile,
  decodeWorkspaceConnections,
  devOperationDecoders,
} from '../src/dev-runtime'

const SCOPE = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-00000000000a',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const REF = '00000000-0000-4000-8000-0000000000c1'
const PROFILE = '00000000-0000-4000-8000-0000000000d1'

const document = {
  scope: SCOPE,
  gitHosting: [{ host: 'github.com', credentialRefId: REF }],
  harnessAccounts: [{ harnessId: 'pi', profileId: PROFILE }],
  version: 2,
  availableHarnesses: [
    { harnessId: 'pi', displayName: 'Pi', accountHosts: ['api.anthropic.com', 'api.openai.com'] },
  ],
}

describe('workspace connection contract (ADR 0012)', () => {
  test('request bodies accept null clears and refuse secret-shaped or unknown fields', () => {
    const setGit = devOperationDecoders['dev.connections.setGitHosting'].request
    expect(setGit({ host: 'github.com', credentialRefId: null, expectedVersion: 0 })).toBeDefined()
    expect(setGit({ host: 'github.com', credentialRefId: REF, expectedVersion: 3 })).toBeDefined()
    expect(() => setGit({ host: 'github.com', expectedVersion: 0 })).toThrow()
    expect(() =>
      setGit({ host: 'github.com', credentialRefId: null, expectedVersion: 0, secret: 'x' })
    ).toThrow(/unknown key/)
    expect(() => setGit({ host: 'github.com', credentialRefId: 1, expectedVersion: 0 })).toThrow()

    const setAccount = devOperationDecoders['dev.connections.setHarnessAccount'].request
    expect(setAccount({ harnessId: 'codex', profileId: null, expectedVersion: 0 })).toBeDefined()
    expect(() => setAccount({ harnessId: 'cursor', profileId: null, expectedVersion: 0 })).toThrow()

    const create = devOperationDecoders['dev.harness.accountProfiles.create'].request
    expect(() => create({ harnessId: 'pi', label: 'x'.repeat(81), credentialRefId: REF })).toThrow()
    expect(() =>
      create({ harnessId: 'pi', label: 'Work', credentialRefId: REF, apiKey: 'sk-1' })
    ).toThrow(/unknown key/)
  })

  test('replies decode strictly and fail closed on drift', () => {
    expect(decodeWorkspaceConnections(document)).toBe(document)
    expect(() => decodeWorkspaceConnections({ ...document, token: 'x' })).toThrow()
    expect(() =>
      decodeWorkspaceConnections({
        ...document,
        gitHosting: [document.gitHosting[0], document.gitHosting[0]],
      })
    ).toThrow(/duplicate/)
    expect(() =>
      decodeWorkspaceConnections({
        ...document,
        gitHosting: [{ host: 'GitHub.com', credentialRefId: REF }],
      })
    ).toThrow()
    const profile = {
      id: PROFILE,
      harnessId: 'pi',
      label: 'Work',
      credentialRefId: REF,
      version: 1,
    }
    expect(decodeHarnessAccountProfile(profile)).toBe(profile)
    expect(() => decodeHarnessAccountProfile({ ...profile, secret: 'sk' })).toThrow()
    expect(() => decodeHarnessAccountProfile({ ...profile, version: 0 })).toThrow()
    const reply = devOperationDecoders['dev.harness.accountProfiles.list'].reply({
      schemaVersion: 1,
      operation: 'dev.harness.accountProfiles.list',
      requestId: '00000000-0000-4000-8000-000000000099',
      ok: true,
      value: { items: [profile], observedAt: '2026-10-05T00:00:00.000Z' },
      observedAt: '2026-10-05T00:00:00.000Z',
    })
    expect(reply.ok).toBe(true)
  })
})
