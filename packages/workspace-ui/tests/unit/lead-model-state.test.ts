import { expect, test } from 'bun:test'
import type {
  ApiModelConnectionsResponse,
  ApiModelFundingView,
  ApiWorkspaceModelDefaults,
} from '@adea-ai/api-client/model-connections'

import {
  MODEL_READINESS_REASON_CODES,
  modelReadinessRemedy,
  projectModelFunding,
  projectModelReadiness,
  projectRoleModel,
  projectSelectableModels,
  roleModelChoice,
} from '../../src/lead-model-state'

const connectionRef = `mconn_${'a'.repeat(32)}`
const choice = { connectionRef, providerModel: 'fixture-model' }
const connections: ApiModelConnectionsResponse = {
  availability: 'available',
  canManage: true,
  target: {
    location: 'remote_host',
    harness: 'pi_durable',
    harnessVersion: '1.0.0',
    providerBinding: 'pi_durable_models',
  },
  connections: [
    {
      connectionRef,
      revision: 1,
      provider: 'fixture-provider',
      accountRef: 'provider-account',
      authKind: 'api_key',
      fundingSource: 'byo_api',
      status: 'active',
      models: [
        {
          providerModel: choice.providerModel,
          readiness: { ready: true, reasonCode: 'READY', remedy: null },
        },
      ],
    },
  ],
}
const binding = {
  workspaceId: 'workspace',
  executionId: 'execution',
  attemptId: 'attempt',
  selectionRef: `msel_${'b'.repeat(32)}`,
  selectionRevision: 3,
}
const now = Date.parse('2026-10-08T12:00:00.000Z')
const funding: ApiModelFundingView = {
  schemaVersion: 'model-funding-display/v1',
  ...binding,
  state: 'ready',
  provider: 'fixture-provider',
  providerModel: 'fixture-model',
  accountRef: 'provider-account',
  authKind: 'api_key',
  fundingSource: 'byo_api',
  fundingOwner: {
    kind: 'workspace_account',
    displayName: 'Explicit funder',
    ownerRef: 'funding-owner',
    revision: 2,
  },
  authorityRevision: 4,
  expiresAt: '2026-10-08T12:01:00.000Z',
}
const projectFunding = (view: unknown = funding, current = true, at = now) =>
  projectModelFunding(view, binding, { current, now: at })

test('every bounded readiness failure has safe actionable copy and READY has no remedy', () => {
  expect(modelReadinessRemedy('READY')).toBeNull()
  for (const reason of MODEL_READINESS_REASON_CODES.filter((code) => code !== 'READY')) {
    const remedy = modelReadinessRemedy(reason)
    expect(remedy?.action).toBeTruthy()
    expect(remedy?.message).toBeTruthy()
    expect(projectModelReadiness({ ready: false, reasonCode: reason }).reasonCode).toBe(reason)
  }
  expect(modelReadinessRemedy('CREDENTIAL_REVOKED')?.action).toBe('manage_credentials')
  expect(modelReadinessRemedy('QUOTA_EXHAUSTED')?.action).toBe('review_provider_quota')
  expect(modelReadinessRemedy('WORKSPACE_GRANT_REVOKED')?.action).toBe('review_workspace_access')
})

test('unknown reasons, contradictory readiness and provider error text never qualify or leak', () => {
  const unsafe = 'secret provider failure text'
  for (const assessment of [
    null,
    { ready: true, reasonCode: unsafe },
    { ready: false, reasonCode: 'READY' },
    { ready: true, reasonCode: 'CREDENTIAL_REVOKED' },
  ]) {
    const projected = projectModelReadiness(assessment)
    expect(projected.ready).toBe(false)
    expect(projected.reasonCode).toBe('READINESS_UNAVAILABLE')
    expect(JSON.stringify(projected)).not.toContain(unsafe)
  }
  expect(
    projectModelReadiness({
      ready: false,
      reasonCode: 'CREDENTIAL_REVOKED',
      remedy: { action: unsafe, message: unsafe },
    }).remedy?.action
  ).toBe('manage_credentials')
  expect(projectModelReadiness({ ready: true, reasonCode: 'READY' })).toEqual({
    ready: true,
    reasonCode: 'READY',
    remedy: null,
  })
})

test('lead, child and direct defaults remain independent, and malformed overrides never fall back', () => {
  const defaults: ApiWorkspaceModelDefaults = { revision: 1, lead: choice }
  expect(roleModelChoice(defaults, 'lead')).toEqual(choice)
  expect(roleModelChoice(defaults, 'child')).toBeNull()
  expect(roleModelChoice(defaults, 'direct')).toBeNull()
  expect(roleModelChoice(defaults, 'direct', choice)).toEqual(choice)
  expect(roleModelChoice(defaults, 'lead', null)).toBeNull()
  expect(roleModelChoice(defaults, 'lead', { ...choice, providerModel: '' })).toBeNull()
  expect(roleModelChoice({ ...defaults, revision: -1 }, 'lead')).toBeNull()
})

test('selection requires a listed active ready model with complete model metadata', () => {
  expect(projectSelectableModels(connections)).toEqual([
    {
      choice,
      provider: 'fixture-provider',
      accountRef: 'provider-account',
      authKind: 'api_key',
      fundingSource: 'byo_api',
    },
  ])
  expect(projectRoleModel(connections, { revision: 1, lead: choice }, 'lead')?.choice).toEqual(
    choice
  )
  expect(projectRoleModel(connections, { revision: 1, lead: choice }, 'direct')).toBeNull()
  expect(projectRoleModel(connections, { revision: 1 }, 'direct', choice)?.choice).toEqual(choice)
  expect(
    projectRoleModel(connections, { revision: 1, lead: choice }, 'lead', {
      ...choice,
      providerModel: 'unlisted',
    })
  ).toBeNull()
  const original = connections.connections[0]!
  for (const change of [
    { status: 'revoked' },
    { accountRef: '' },
    { provider: '' },
    { authKind: 'unknown' },
    { fundingSource: 'unknown' },
    { revision: 0 },
    {
      models: [
        {
          providerModel: choice.providerModel,
          readiness: { ready: true, reasonCode: 'CREDENTIAL_REVOKED' },
        },
      ],
    },
  ])
    expect(
      projectSelectableModels({ ...connections, connections: [{ ...original, ...change }] })
    ).toEqual([])
  expect(projectSelectableModels({ ...connections, availability: 'unavailable' })).toEqual([])
  expect(projectSelectableModels({ ...connections, target: null })).toEqual([])
})

test('ambiguous duplicate connection or model identity cannot be selected', () => {
  const original = connections.connections[0]!
  expect(
    projectSelectableModels({
      ...connections,
      connections: [original, { ...original, accountRef: 'other-account' }],
    })
  ).toEqual([])
  expect(
    projectSelectableModels({
      ...connections,
      connections: [{ ...original, models: [...original.models, ...original.models] }],
    })
  ).toEqual([])
})

test('model projections leave frozen defaults and unrelated draft/persona state intact', () => {
  const state = Object.freeze({
    defaults: Object.freeze({ revision: 1, lead: Object.freeze({ ...choice }) }),
    draft: 'Unsent question',
    persona: Object.freeze({ name: 'My designated lead', instructions: 'Customized persona' }),
  })
  const before = JSON.stringify(state)
  roleModelChoice(state.defaults, 'direct', choice)
  projectRoleModel(connections, state.defaults, 'lead')
  expect(JSON.stringify(state)).toBe(before)
})

test('ready funding displays exact authenticated provider identity and explicit funder separately', () => {
  expect(projectFunding()).toEqual(funding)
  const projected = projectFunding()
  expect(projected.state).toBe('ready')
  if (projected.state === 'ready') {
    expect(projected.accountRef).toBe('provider-account')
    expect(projected.fundingOwner.ownerRef).toBe('funding-owner')
    expect(projected.fundingOwner.revision).toBe(2)
    expect(projected.fundingOwner.kind).toBe('workspace_account')
  }
})

test('funding mismatch in each immutable scope pin fails closed without exposing ready metadata', () => {
  for (const [key, value] of Object.entries({
    workspaceId: 'other-workspace',
    executionId: 'other-execution',
    attemptId: 'other-attempt',
    selectionRef: `msel_${'c'.repeat(32)}`,
    selectionRevision: 4,
  })) {
    const projected = projectFunding({ ...funding, [key]: value })
    expect(projected.state).toBe('blocked')
    expect(JSON.stringify(projected)).not.toContain('Explicit funder')
    expect(JSON.stringify(projected)).not.toContain('provider-account')
  }
})

test('missing explicit funding ownership is never inferred from provider account metadata', () => {
  const withoutOwner = {
    ...funding,
    fundingOwner: undefined,
    accountOwner: {
      ownerRef: 'provider-account',
      kind: 'provider_account',
      displayName: 'Account owner',
      revision: 1,
    },
  }
  expect(projectFunding(withoutOwner).state).toBe('blocked')
  for (const owner of [
    null,
    { ...funding.fundingOwner, revision: 0 },
    { ...funding.fundingOwner, ownerRef: '' },
    { ...funding.fundingOwner, kind: 'user' },
    { ...funding.fundingOwner, displayName: '' },
  ])
    expect(projectFunding({ ...funding, fundingOwner: owner }).state).toBe('blocked')
})

test('expired, stale, failed and malformed funding views cannot retain a ready label', () => {
  for (const view of [
    null,
    { ...funding, schemaVersion: 'model-funding-display/v2' },
    { ...funding, expiresAt: 'invalid' },
    { ...funding, expiresAt: new Date(now).toISOString() },
    { ...funding, authorityRevision: 0 },
    { ...funding, credentialRef: 'secret-reference' },
    { ...funding, fundingOwner: { ...funding.fundingOwner, credential: 'secret' } },
  ])
    expect(projectFunding(view).state).toBe('blocked')
  expect(projectFunding(funding, false).state).toBe('blocked')
  expect(projectFunding(funding, true, Number.NaN).state).toBe('blocked')
  expect(projectFunding(funding, true, now + 60_001).state).toBe('blocked')
})

test('blocked funding uses only the bounded reason/remedy and suppresses all ready fields', () => {
  const blocked = {
    schemaVersion: 'model-funding-display/v1',
    ...binding,
    state: 'blocked',
    reasonCode: 'CREDENTIAL_REVOKED',
  }
  expect(projectFunding(blocked)).toEqual({
    state: 'blocked',
    reasonCode: 'CREDENTIAL_REVOKED',
    remedy: modelReadinessRemedy('CREDENTIAL_REVOKED'),
  })
  expect(projectFunding({ ...blocked, reasonCode: 'secret upstream error' }).reasonCode).toBe(
    'READINESS_UNAVAILABLE'
  )
  expect(projectFunding({ ...blocked, reasonCode: 'READY' }).state).toBe('blocked')
})

test('funding scope extras cannot enter the ready projection and freshness must be explicitly true', () => {
  const extraScope = { ...binding, credentialRef: 'PRIVATE-CALLER-REF' }
  const projected = projectModelFunding(funding, extraScope, { current: true, now })
  expect(projected.state).toBe('blocked')
  expect(JSON.stringify(projected)).not.toContain('PRIVATE-CALLER-REF')
  expect(
    projectModelFunding(funding, binding, { current: 'truthy' as unknown as boolean, now }).state
  ).toBe('blocked')
})

test('a calendar-invalid future expiry is not normalized into fresh funding', () => {
  expect(projectFunding({ ...funding, expiresAt: '2027-02-31T12:00:00.000Z' }).state).toBe(
    'blocked'
  )
})
