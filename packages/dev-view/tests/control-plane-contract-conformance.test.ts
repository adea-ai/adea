// Contract conformance pin for #36's remaining box.
//
// The box asks that "Agent HQ builds against the pinned SDK without importing
// Control Plane server/domain/database/Restate packages". The hygiene half is
// proven — a repository-wide search finds no such import — but nothing consumed
// a *pinned* SDK either, so the contracts are mirrored locally (the
// decision-layer contract, the execution-location policy, the event-inbox
// schema) and a divergence would have been silent.
//
// This pins the mirror instead of adding a dependency: the checked-in fixture is
// a `decision-resolution.v1` payload as the Control Plane emits it
// (control-plane#558 is the contract's home), and it must decode through the
// consumer's own strict decoder. A renamed required field, a bumped version, or
// a missing nested field fails here — which is what makes keeping the mirror
// safe rather than a private copy that drifts.
import { expect, test } from 'bun:test'

import {
  DECISION_RESOLUTION_CONTRACT_VERSION,
  DecisionLayerProtocolError,
  decodeDecisionLayerResolution,
} from '../src/chat/composer/decision-layer'
import fixture from './fixtures/control-plane-decision-resolution-v1.json'

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>
}

test('the checked-in Control Plane resolution decodes through the consumer contract', () => {
  const decoded = decodeDecisionLayerResolution(clone())
  // The version the consumer declares and the version the fixture carries must
  // agree — that is the pin the two sides share.
  expect(decoded.contractVersion).toEqual({
    major: DECISION_RESOLUTION_CONTRACT_VERSION.major,
    minor: DECISION_RESOLUTION_CONTRACT_VERSION.minor,
  })
  expect(decoded.schemaVersion).toBe(1)
  // Everything the composer reads is present and typed.
  expect(decoded.resolution.harness.harnessId).toBe('claude-code')
  expect(decoded.resolution.model).toEqual({ modelId: 'claude-sonnet-4' })
  expect(decoded.resolution.runtime).toMatchObject({ kind: 'local', transport: 'direct-local' })
  expect(decoded.resolution.sandbox).toMatchObject({ mode: 'managed' })
  expect(decoded.resolution.delegation).toMatchObject({
    fanOut: 'none',
    promotion: 'review-required',
  })
  expect(decoded.resolutionDigest).toMatch(/^[a-f0-9]{64}$/)
  // The trace explains every resolved output, which is what the composer
  // surfaces when a pin is not what the user asked for.
  expect(Object.keys(decoded.trace).toSorted()).toEqual(['harness', 'model', 'runtime'])
  for (const entry of Object.values(decoded.trace)) {
    expect(['explicit-pin', 'project-default', 'profile-default', 'policy-default']).toContain(
      entry.source
    )
  }
})

test('drift between the mirror and the Control Plane contract fails here', () => {
  const renamedField = clone()
  renamedField.digest = renamedField.resolutionDigest
  delete renamedField.resolutionDigest

  const bumpedSchema = clone()
  bumpedSchema.schemaVersion = 2

  const bumpedContract = clone()
  bumpedContract.contractVersion = { major: 2, minor: 0 }

  const emptyModel = clone()
  ;(emptyModel.resolution as Record<string, unknown>).model = {}

  const missingRuntime = clone()
  delete (missingRuntime.resolution as Record<string, unknown>).runtime

  for (const [label, drifted] of [
    ['a renamed required field', renamedField],
    ['a bumped schema version', bumpedSchema],
    ['a bumped contract major', bumpedContract],
    ['a model entry that is neither resolved nor withheld', emptyModel],
    ['a missing nested runtime', missingRuntime],
  ] as const) {
    expect(() => decodeDecisionLayerResolution(drifted), label).toThrow(DecisionLayerProtocolError)
  }
})
