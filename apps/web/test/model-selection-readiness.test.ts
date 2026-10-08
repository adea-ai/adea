import { describe, expect, test } from 'bun:test'

import {
  MODEL_READINESS_REASON_CODES,
  modelReadiness,
} from '../src/server/model-selection-readiness'

describe('model-selection/v1 public readiness projection', () => {
  test('only an explicit consistent READY assessment reports ready', () => {
    expect(modelReadiness({ ready: true, reasonCode: 'READY' })).toEqual({
      ready: true,
      reasonCode: 'READY',
      remedy: null,
    })
    for (const value of [
      { ready: false, reasonCode: 'READY' },
      { ready: true, reasonCode: 'CREDENTIAL_REVOKED' },
      { ready: true },
      { status: 'active', provider: 'anthropic' },
      null,
      [],
    ]) {
      expect(modelReadiness(value)).toEqual(modelReadiness(undefined))
      expect(modelReadiness(value).ready).toBeFalse()
    }
  })

  test('every agreed denial reason stays denied and has a bounded remedy', () => {
    for (const reasonCode of MODEL_READINESS_REASON_CODES) {
      if (reasonCode === 'READY') continue
      const result = modelReadiness({ ready: false, reasonCode })
      expect(result.ready).toBeFalse()
      expect(result.reasonCode).toBe(reasonCode)
      expect(result.remedy?.action).toBeString()
      expect(result.remedy?.message).toBeString()
    }
  })

  test('revocation requires renewed configuration, never automatic takeover', () => {
    expect(modelReadiness({ ready: false, reasonCode: 'CREDENTIAL_REVOKED' }).remedy).toEqual({
      action: 'manage_credentials',
      message: 'Choose a model connection with a valid credential in workspace settings.',
    })
    expect(
      modelReadiness({ ready: false, reasonCode: 'WORKSPACE_GRANT_REVOKED' }).remedy?.action
    ).toBe('review_workspace_access')
    expect(modelReadiness({ ready: false, reasonCode: 'SELECTION_CHANGED' }).remedy?.action).toBe(
      'refresh_selection'
    )
    expect(
      modelReadiness({ ready: false, reasonCode: 'CREDENTIAL_REVISION_CHANGED' }).remedy
    ).toEqual({
      action: 'refresh_selection',
      message: 'Refresh the model selection to use the current credential revision.',
    })
  })

  test('unknown error text and secret-bearing fields never enter the public result', () => {
    const sensitive = 'private-provider-secret'
    for (const value of [
      { ready: false, reasonCode: sensitive, message: sensitive },
      { ready: false, reasonCode: 'CREDENTIAL_REVOKED', secret: sensitive },
      { ready: true, reasonCode: 'READY', credential: { apiKey: sensitive } },
    ]) {
      const result = modelReadiness(value)
      expect(JSON.stringify(result)).not.toContain(sensitive)
      expect(result.reasonCode).toBe('READINESS_UNAVAILABLE')
      expect(result.ready).toBeFalse()
    }
  })
})
