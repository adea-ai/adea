import { describe, expect, test } from 'bun:test'

import {
  buildComposerDecisionRequest,
  composerPreferenceKey,
  loadComposerPreferences,
  resolveAndLaunchComposer,
  resolveDecisionLayer,
  resolvedLocationLabel,
  DecisionLayerUnavailableError,
  saveComposerPreferences,
  type DecisionLayerResolution,
  type DecisionResolutionRequest,
} from '../src/chat/composer'

const baseRequest = {
  caller: { servicePrincipalId: 'adea-desktop' },
  requestId: 'req_01',
  workspaceId: 'wsp_01',
  projectId: 'prj_01',
  correlation: { traceId: 'trc_01' },
  requestedAt: '2026-09-22T10:00:00.000Z',
  objective: 'Fix the login flow',
  agentProfile: { profileId: 'prf_01', profileVersionId: 'pfv_01' },
  availableRuntimes: [
    {
      runtimeDefinitionId: 'rtd_01',
      kind: 'local' as const,
      transport: 'direct-local' as const,
      harnessIds: ['pi'],
      capabilities: ['workspace.read'],
    },
  ],
  entitlements: { modelAccess: 'provisioned' as const, grantedCapabilityNames: ['workspace.read'] },
  requiredCapabilities: ['workspace.read'],
  costLatencyPreference: 'balanced' as const,
  projectDefaults: {},
  profileDefaults: {},
}

const resolution: DecisionLayerResolution = {
  schemaVersion: 1,
  requestId: 'req_01',
  workspaceId: 'wsp_01',
  contractVersion: { major: 1, minor: 0 },
  resolvedAt: '2026-09-22T10:00:01.000Z',
  resolution: {
    harness: { harnessId: 'pi' },
    model: { modelId: 'model-1' },
    skills: { skillVersionIds: [] },
    capabilities: { capabilityNames: ['workspace.read'] },
    runtime: {
      runtimeDefinitionId: 'rtd_01',
      kind: 'local',
      transport: 'direct-local',
      harnessIds: ['pi'],
      capabilities: ['workspace.read'],
    },
    sandbox: { mode: 'managed', effectiveCapabilities: ['workspace.read'] },
    contextPackage: { mode: 'none' },
    delegation: { fanOut: 'none', promotion: 'review-required' },
  },
  trace: {},
  diagnostics: [],
  resolutionDigest: `sha256:${'a'.repeat(64)}`,
}

describe('chat decision-layer consumer', () => {
  test('Auto pins no local selection and Customize forwards explicit pins', () => {
    const auto = buildComposerDecisionRequest({ ...baseRequest, mode: 'auto' })
    expect(auto.contractVersion).toEqual({ major: 1, minor: 0 })
    expect(auto.explicitPins).toEqual({})

    const customize = buildComposerDecisionRequest({
      ...baseRequest,
      mode: 'customize',
      explicitPins: { harness: { harnessId: 'pi' }, model: { modelId: 'model-1' } },
    })
    expect(customize.explicitPins).toEqual({
      harness: { harnessId: 'pi' },
      model: { modelId: 'model-1' },
    })
    expect(() =>
      buildComposerDecisionRequest({
        ...baseRequest,
        mode: 'auto',
        explicitPins: { model: { modelId: 'local-choice' } },
      })
    ).toThrow('Auto mode cannot carry explicit selection pins')

    // The location pin travels the same way (#37/#186): choosing a registered
    // runtime is an explicit selection, and it is refused in Auto mode for the
    // same reason the other pins are.
    const located = buildComposerDecisionRequest({
      ...baseRequest,
      mode: 'customize',
      explicitPins: { runtime: { runtimeDefinitionId: 'rtd_01' } },
    })
    expect(located.explicitPins).toEqual({ runtime: { runtimeDefinitionId: 'rtd_01' } })
    expect(() =>
      buildComposerDecisionRequest({
        ...baseRequest,
        mode: 'auto',
        explicitPins: { runtime: { runtimeDefinitionId: 'rtd_01' } },
      })
    ).toThrow('Auto mode cannot carry explicit selection pins')
  })

  test('the resolved location is labelled from the resolution, not from the request (#37/#186)', () => {
    const at = (
      kind: 'local' | 'self-hosted' | 'cloud',
      transport: 'direct-local' | 'remote-gateway'
    ) =>
      resolvedLocationLabel({
        ...resolution,
        resolution: {
          ...resolution.resolution,
          runtime: { ...resolution.resolution.runtime, kind, transport },
        },
      })
    expect(at('local', 'direct-local')).toBe('Local device · direct local')
    expect(at('self-hosted', 'remote-gateway')).toBe('Self-hosted host · remote gateway')
    expect(at('cloud', 'remote-gateway')).toBe('Agent HQ Cloud · remote gateway')
    // The label is derived from the runtime the resolution selected, so a
    // request that asked for one location and got another reports what ran.
    expect(resolvedLocationLabel(resolution)).toBe('Local device · direct local')
  })

  test('submits to the client and hands the validated response to the #400 launch adapter', async () => {
    const requests: DecisionResolutionRequest[] = []
    let launch: DecisionLayerResolution | undefined
    const outcome = await resolveAndLaunchComposer(
      {
        client: {
          resolve: async (request) => {
            requests.push(request)
            return resolution
          },
        },
        onResolved: (value) => {
          launch = value
        },
      },
      buildComposerDecisionRequest({ ...baseRequest, mode: 'auto' })
    )
    expect(outcome.kind).toBe('resolved')
    expect(requests).toHaveLength(1)
    expect(launch?.resolution.harness.harnessId).toBe('pi')
  })

  test('fails closed with one typed recovery when the channel or resolution is unavailable', async () => {
    await expect(
      resolveDecisionLayer(
        undefined,
        buildComposerDecisionRequest({ ...baseRequest, mode: 'auto' })
      )
    ).resolves.toMatchObject({
      kind: 'failure',
      status: 'unavailable',
      action: 'retry',
    })

    await expect(
      resolveDecisionLayer(
        {
          resolve: async () => ({ ...resolution, diagnostics: ['MODEL_ACCESS_NOT_ENTITLED'] }),
        },
        buildComposerDecisionRequest({ ...baseRequest, mode: 'auto' })
      )
    ).resolves.toMatchObject({
      kind: 'failure',
      status: 'unavailable',
      diagnostics: ['MODEL_ACCESS_NOT_ENTITLED'],
    })

    await expect(
      resolveDecisionLayer(
        {
          resolve: async () => {
            throw new DecisionLayerUnavailableError('auth_required', 'Sign in to continue.')
          },
        },
        buildComposerDecisionRequest({ ...baseRequest, mode: 'auto' })
      )
    ).resolves.toMatchObject({ kind: 'failure', status: 'auth_required', action: 'sign_in' })
  })

  test('scopes preferences per user and project and stores no credential values', () => {
    const values = new Map<string, string>()
    const store = {
      read: (key: string) => values.get(key),
      write: (key: string, value: string) => values.set(key, value),
    }
    saveComposerPreferences(store, {
      schemaVersion: 1,
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      mode: 'customize',
      agentProfileId: 'profile-1',
      favorites: ['pi'],
      recents: ['pi'],
    })
    expect(
      values.has(
        composerPreferenceKey({
          accountId: 'account-1',
          workspaceId: 'workspace-1',
          projectId: 'project-2',
        })
      )
    ).toBe(false)
    expect(
      values.get(
        composerPreferenceKey({
          accountId: 'account-1',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
        })
      )
    ).not.toContain('token')
    expect(
      loadComposerPreferences(store, {
        accountId: 'account-1',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
      })
    ).toMatchObject({ mode: 'customize', projectId: 'project-1' })
  })
})
