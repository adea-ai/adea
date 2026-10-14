// Opt-in consumer-boundary proof for CP draft #1136's `childAllowance` on the lead prepare response.
// Adea's product prepares and dispatches the lead through whichever @adea-ai SDK packages are
// installed, over HTTP to CP's control API at the #1136 head. The suite measures whether the
// installed SDK accepts the new field and asserts what Adea must do either way:
//   - installed SDK rejects it: the turn fails closed (blocked, nothing started). This is today's
//     registry SDK, and the reason the SDK must be released and bumped BEFORE CP is deployed.
//   - installed SDK accepts it: prepare and dispatch work, and the field surfaces typed and equal
//     to what the pinned profile version states (or `not_stated`).
// Run with PI_FACTORY_SOURCE_PIN=source-allowance-candidate.json. PI_FACTORY_INSTALL=
// candidate-overlay is pre-release evidence from a throwaway checkout; it is not evidence about
// Adea's lockfile. Scripted ports other than CP's, never live.
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { describe, beforeAll, afterAll, test, expect } from 'bun:test'
import { startHarness, pin, root } from './harness.mjs'
import { verifyInstalledPackages } from './installed-packages.mjs'
import { installedLeadSdkPort } from '../../src/server/lead-turn-sdk-port.ts'
import { createConfiguredLeadTurnDependencies } from '../../src/server/lead-turn-composition.ts'
import { createLeadTurnProduct } from '../../src/server/lead-turn-product.ts'

const manifestPath = process.env.PI_FACTORY_MANIFEST
if (!manifestPath) throw new Error('VERIFIED_CANDIDATE_MANIFEST_REQUIRED')
if (pin.revision === '7d36f9bb78e32be9cb2e508884f010a9ad670c6b')
  throw new Error('SET_PI_FACTORY_SOURCE_PIN_TO_A_CP_HEAD_THAT_DISCLOSES_CHILD_ALLOWANCE')
// registry-predating-candidate: the lockfile's registry SDK, which is expected to differ from the
// candidate; overlay: the candidate archives installed in a throwaway checkout.
const installKind = process.env.PI_FACTORY_INSTALL ?? 'registry-predating-candidate'
const webRequire = createRequire(new URL('../../package.json', import.meta.url))
const sdkEntry = realpathSync(webRequire.resolve('@adea-ai/sdk'))
const { ControlApiOperations } = await import(sdkEntry)
const responseSchema = ControlApiOperations.preparePiDurableLead.responseSchema

let installed
// The same payload an older control plane sends, with and without the field, parsed by whichever
// preparation schema is installed. This is the measurement; nothing below assumes its outcome.
const probe = (data) => responseSchema.safeParse(data).success
const sample = (captured, withField) => {
  const next = structuredClone(captured)
  if (!withField) delete next.data.childAllowance
  return next
}

beforeAll(async () => {
  // Package and source identity are verified before any database connection is opened.
  installed = await verifyInstalledPackages({
    manifestPath,
    expectedHead: pin.revision,
    cpRoot: root,
    port: installedLeadSdkPort,
    installKind,
  })
}, 60000)

for (const mode of ['profile', 'none']) {
  describe(`lead profile ${mode === 'profile' ? 'states a child allowance' : 'states none'}`, () => {
    let harness, control, product, scope, captured, accepts, prepared
    beforeAll(async () => {
      harness = await startHarness({
        allowanceSource: mode,
        controlApi: true,
        title: `1136 boundary ${mode}`,
      })
      control = harness.control
      const { hostMetadata, signing, workspaceId } = harness
      const dependencies = await createConfiguredLeadTurnDependencies({
        environment: {
          NODE_ENV: 'test',
          PI_DURABLE_LEAD_ENABLED: 'true',
          PI_DURABLE_LEAD_TARGET: JSON.stringify(hostMetadata.target),
          CONTROL_PLANE_ORIGIN: hostMetadata.baseUrl,
          CONTROL_PLANE_SIGNING_KEY: JSON.stringify(signing.privateJwk),
          CONTROL_PLANE_SIGNING_KEY_ID: signing.keyId,
          CONTROL_PLANE_SIGNING_ISSUER: signing.issuer,
        },
        resolveControlPlaneScope: async () => ({ workspaceId }),
      })
      product = createLeadTurnProduct(harness.connection.db, dependencies)
      scope = {
        workspaceId: harness.workspace.id,
        intentId: harness.intentId,
        userId: harness.owner.principal.userId,
      }
      // Record the prepare body CP sent, then give it to the installed schema.
      const real = globalThis.fetch
      globalThis.fetch = async (...args) => {
        const response = await real(...args)
        if (String(args[0]).includes('lead-dispatches/prepare'))
          captured = JSON.parse(await response.clone().text())
        return response
      }
      try {
        prepared = await product.prepare(scope)
      } finally {
        globalThis.fetch = real
      }
      accepts = probe(captured)
    }, 60000)
    afterAll(async () => {
      await harness?.stop()
    }, 15000)

    test('CP at the pinned head sends the disclosure bound to the pinned profile version', async () => {
      const statement = await control('profile-statement')
      const disclosure = captured.data.childAllowance
      expect(statement.source).toBe(mode)
      expect(disclosure.schemaVersion).toBe('pi-lead-child-allowance/v1')
      expect(disclosure.profile).toEqual({
        profileId: statement.profileId,
        profileVersionId: statement.profileVersionId,
        version: statement.version,
        revision: statement.revision,
      })
      if (mode === 'none') {
        expect(statement.allowance).toBeUndefined()
        expect(disclosure.state).toBe('not_stated')
        expect(Object.keys(disclosure)).not.toContain('maximumMicrounits')
      } else {
        expect(disclosure).toMatchObject({
          state: 'stated',
          currency: 'USD',
          maximumMicrounits: statement.allowance.maximumMicrounits,
          maximumTokens: statement.allowance.maximumTokens,
        })
      }
    }, 30000)

    test('the installed SDK schema either accepts the field or Adea fails closed', async () => {
      const evidence = await control('evidence')
      expect(evidence.physicalSends).toBe(0)
      expect(evidence.secretResolutions).toBe(0)
      console.log(
        JSON.stringify({
          boundary: 'child-allowance',
          mode,
          installKind: installed.installKind,
          differingFiles: installed.packages.flatMap((entry) =>
            (entry.differingFiles ?? []).map((file) => `${entry.name}:${file}`)
          ),
          installedAccepts: accepts,
          preparedState: prepared.state,
          reasonCode: prepared.reasonCode,
        })
      )
      if (accepts) {
        expect(prepared.state).toBe('prepared')
        expect(prepared.selectionRef).toBe(
          harness.choices.requestedModelSelections.lead.selectionRef
        )
      } else {
        // An older SDK refuses the response as a whole: the turn is blocked, never started.
        expect(prepared.state).toBe('blocked')
        expect(prepared.availability).toBe('unavailable')
        expect(prepared.reasonCode).toBe('RUNTIME_UNAVAILABLE')
        expect(prepared.preparationRef).toBeUndefined()
      }
    }, 30000)

    test('an accepting SDK surfaces the typed field and still parses a control plane that omits it', () => {
      if (!accepts) {
        // The field is what the installed schema rejects, and nothing else in the response.
        expect(probe(sample(captured, false))).toBe(true)
        return
      }
      const parsed = responseSchema.parse(captured)
      expect(parsed.data.childAllowance).toEqual(captured.data.childAllowance)
      expect(probe(sample(captured, false))).toBe(true)
      const half = sample(captured, true)
      half.data.childAllowance =
        mode === 'none'
          ? { ...half.data.childAllowance, maximumMicrounits: 1 }
          : { ...half.data.childAllowance, maximumTokens: 0 }
      expect(probe(half)).toBe(false)
    })

    test('with the field accepted, dispatch is unaffected and the lead runs', async () => {
      if (!accepts) return
      const started = await product.dispatch(scope)
      expect(['starting', 'running']).toContain(started.state)
      expect(started.dispatchId).toBeTruthy()
      let status
      const deadline = Date.now() + 15000
      do {
        status = await product.status(scope)
        if (status.state === 'running' && status.executionId && status.attemptId) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      } while (Date.now() < deadline)
      expect(status.state).toBe('running')
    }, 40000)
  })
}
