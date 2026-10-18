// Opt-in consumer-boundary proof for CP draft #1136's `childAllowance` on the lead prepare response.
// Adea's product prepares and dispatches the lead through the installed @adea-ai SDK packages, over
// HTTP to CP's control API at the #1136 head. The expectation is explicit and required, so a
// broken SDK cannot pass by being measured and then excused:
//   PI_FACTORY_EXPECT_SDK=accepts  The installed SDK must accept the field. Prepare must return
//     `prepared`, the typed field must equal the pinned profile version's statement, and dispatch
//     must run the lead. Nothing is skipped; a rejecting SDK fails here.
//   PI_FACTORY_EXPECT_SDK=rejects  The installed SDK must reject the field and the turn must fail
//     closed (blocked, nothing started). This is the negative control for a registry SDK that
//     predates the field, and the reason the SDK must be released and bumped BEFORE CP deploys.
// PI_FACTORY_INSTALL says what is installed and is also required:
//   registry                       Adea's lockfile SDK is byte-identical to the candidate (the
//                                  current consumer acceptance gate: use with expect=accepts).
//   isolated-legacy-sdk            Legacy compatibility evidence: the exact registry SDK that
//                                  predates the field, installed in ./legacy-sdk outside Adea's
//                                  dependency graph and swapped in by its tsconfig override. Expected to
//                                  differ from the candidate (use with rejects; accepts must fail).
//   candidate-overlay              The packed candidate archives in a throwaway checkout. Pre-release
//                                  evidence only; it says nothing about Adea's lockfile.
// Pin CP with PI_FACTORY_SOURCE_PIN=source-allowance-candidate.json. Scripted ports other than CP's,
// never live.
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
const installKind = process.env.PI_FACTORY_INSTALL
const expectation = process.env.PI_FACTORY_EXPECT_SDK
if (!['registry', 'isolated-legacy-sdk', 'candidate-overlay'].includes(installKind))
  throw new Error('PI_FACTORY_INSTALL_REQUIRED')
if (!['accepts', 'rejects'].includes(expectation)) throw new Error('PI_FACTORY_EXPECT_SDK_REQUIRED')
// An install that is the candidate itself, or the post-bump registry SDK, must accept the field.
if (installKind !== 'isolated-legacy-sdk' && expectation !== 'accepts')
  throw new Error('CANDIDATE_OR_RELEASED_SDK_MUST_BE_EXPECTED_TO_ACCEPT')
const mustAccept = expectation === 'accepts'
const legacy = installKind === 'isolated-legacy-sdk'
const webRequire = createRequire(
  new URL(legacy ? './legacy-sdk/package.json' : '../../package.json', import.meta.url)
)
const sdkEntry = realpathSync(webRequire.resolve('@adea-ai/sdk'))
const { ControlApiOperations } = await import(sdkEntry)
const responseSchema = ControlApiOperations.preparePiDurableLead.responseSchema

let installed
// The payload CP sent, with and without the field, parsed by the installed preparation schema.
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

    test(`the installed SDK ${mustAccept ? 'accepts' : 'rejects'} the field, as expected`, async () => {
      const evidence = await control('evidence')
      expect(evidence.physicalSends).toBe(0)
      expect(evidence.secretResolutions).toBe(0)
      console.log(
        JSON.stringify({
          boundary: 'child-allowance',
          mode,
          expectation,
          installKind: installed.installKind,
          differingFiles: installed.packages.flatMap((entry) =>
            (entry.differingFiles ?? []).map((file) => `${entry.name}:${file}`)
          ),
          installedAccepts: accepts,
          preparedState: prepared.state,
          reasonCode: prepared.reasonCode,
        })
      )
      // The product's own SDK port must be the install under test, not only this file's import.
      const portAccepts = (() => {
        try {
          installedLeadSdkPort.preparationSchema.parse(captured.data)
          return true
        } catch {
          return false
        }
      })()
      expect(portAccepts).toBe(accepts)
      // A legacy install that does not differ from the candidate would prove nothing.
      if (legacy)
        expect(
          installed.packages.flatMap((entry) => entry.differingFiles ?? []).length
        ).toBeGreaterThan(0)
      // The measurement must equal the stated expectation before anything else is judged.
      expect(accepts).toBe(mustAccept)
      if (mustAccept) {
        expect(prepared.state).toBe('prepared')
        expect(prepared.selectionRef).toBe(
          harness.choices.requestedModelSelections.lead.selectionRef
        )
        expect(prepared.preparationRef).toMatch(/^prep_[a-f0-9]{32}$/)
      } else {
        // An older SDK refuses the response as a whole: the turn is blocked, never started.
        expect(prepared.state).toBe('blocked')
        expect(prepared.availability).toBe('unavailable')
        expect(prepared.reasonCode).toBe('RUNTIME_UNAVAILABLE')
        expect(prepared.preparationRef).toBeUndefined()
      }
    }, 30000)

    test(
      mustAccept
        ? 'the typed field survives, a response without it still parses, a half statement does not'
        : 'the field is the only thing the installed SDK rejects',
      () => {
        expect(probe(sample(captured, false))).toBe(true)
        if (!mustAccept) {
          expect(probe(captured)).toBe(false)
          return
        }
        const parsed = responseSchema.parse(captured)
        expect(parsed.data.childAllowance).toEqual(captured.data.childAllowance)
        const half = sample(captured, true)
        half.data.childAllowance =
          mode === 'none'
            ? { ...half.data.childAllowance, maximumMicrounits: 1 }
            : { ...half.data.childAllowance, maximumTokens: 0 }
        expect(probe(half)).toBe(false)
      }
    )

    test(
      mustAccept
        ? 'dispatch runs the lead with the field accepted'
        : 'a blocked turn never dispatches and starts no runtime',
      async () => {
        if (!mustAccept) {
          const evidence = await control('evidence')
          expect(evidence.physicalSends).toBe(0)
          expect(prepared.dispatchId).toBeUndefined()
          expect(prepared.runtimeSessionId).toBeUndefined()
          return
        }
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
        expect(status.executionId).toBeTruthy()
        expect(status.attemptId).toBeTruthy()
      },
      40000
    )
  })
}
