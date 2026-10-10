# M18.01.3 control-plane consumer proposal

Status: proposal for the control-plane owners. Nothing in `adea-ai/control-plane` is changed by this PR. The
local CP checkout at `ec742819` has unrelated uncommitted edits, and they were not touched. Tracking:
control-plane #940 and #942, both open.

Root approved the pinned v2 variant on #1244. This document describes the producer side as implemented, and
the consumer side CP still has to build. Reviewed against CP's committed tree at `ec742819`.

## What Adea emits for a fenced admission

HTTP 200, `cache-control: private, no-store`, and only these fields. The discriminator is `pi-lead-intent-fence/v2`.
It is a new schema, not a widening of v1.

```json
{
  "schemaVersion": "pi-lead-intent-fence/v2",
  "intentId": "<uuid, equal to the requested intentId>",
  "workspaceId": "wsp_<26 chars, equal to the requested workspaceId>",
  "dispatchPermitted": false,
  "rollbackFence": {
    "fencedAt": "<canonical UTC ISO-8601, not later than Adea's clock>",
    "reason": "operator_intervention | rollback_cohort",
    "actor": { "kind": "user", "userId": "<uuid>" } | { "kind": "operator", "operatorId": "<id>" }
  },
  "authorityRevision": "<channel version of the current canonical product>",
  "canonicalActorPrincipalId": "user:<original admission actor uuid>",
  "scopeRef": "adea-product:sha256:<64 hex>",
  "allowedPrincipalIds": ["<the service principal the signed proof verified>"]
}
```

Where the pins come from. All four are read from the same current canonical product that the unfenced
`pi-lead-intent/v1` evidence uses, under the same canonical locks. None comes from the request body beyond
the verified principal, and none is a default.

- `authorityRevision` is the channel version.
- `canonicalActorPrincipalId` is the original admission actor, not the fence actor.
- `scopeRef` is the same digest the unfenced admission computes. For the same authority, the fenced and
  unfenced scopeRef are equal. The golden fixtures check this.
- `allowedPrincipalIds` is the principal that the service proof verified for this request, which is the only
  principal the signed token can bind.

The v2 body has no prompt, profile, message or dispatch fields. Adea's signed reader discloses it only through
the existing authenticated, scoped product-reader boundary.

Adea refuses, with HTTP 404 `LEAD_PRODUCT_UNAVAILABLE` and no fence facts, when:

- `dispatchPermitted` is not exactly `false` with a fence, or not exactly `true` without one.
- The fence has extra or missing keys, a non-object `actor`, an unknown `reason` or actor `kind`, or a
  malformed `userId` or `operatorId`.
- `fencedAt` is not canonical (`Date.parse` plus `toISOString` round trip), or is later than Adea's clock.
  There is no skew tolerance.
- The product's identity does not match the requested workspace and intent.
- The service proof does not verify, or the authority is withdrawn during the read.

The old minimal `pi-lead-intent-fence/v1` body is no longer emitted. It remains as a fail-closed fixture,
`apps/web/test/contracts/lead-product-current.fenced.json`. Any v1 parser must refuse it, and any parser
that does not know v2 must refuse v2.

## Consumer policy

Adea enforces what it can. CP enforces the rest at its own gate.

| Operation                               | Fenced result | Condition                                                                                                                                            |
| --------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare`, `dispatch`                   | refuse        | always                                                                                                                                               |
| resume or restart of a dispatch attempt | refuse        | always. CP checks its own stored fence in the claiming transaction too                                                                               |
| publication of a new message            | refuse        | always. Adea's publication path refuses a fenced admission that has not already published                                                            |
| `status`, `progress` (observe)          | observe       | v2 body, requester in `allowedPrincipalIds`, and the retained `authorityRevision`, `scopeRef` and `canonicalActorPrincipalId` equal the current body |
| `cancel`                                | cancel        | as observe, and the requester is the original admission actor (`canonicalActorPrincipalId`)                                                          |

Recovery and reconciliation of a dispatch binding on a fenced admission remain on Adea's read path. That is
how an uncertain dispatch is reconciled without redispatch. It is not a resume, and it writes no new effect.

Adea's own cancel authority already binds to the original actor. A participant who is not the original actor
is refused, and the fence is unchanged (`lead-turn-fence-envelope-negative`).

## Typed consumer proposal (CP `apps/control-api`)

Sketch in zod, which CP already uses. It has not been compiled against CP.

```ts
import { z } from 'zod'
import {
  ProductionLeadProductEvidenceSchema,
  type ProductionLeadProductEvidence,
} from './models/production-lead-product.js'

const INTENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const WORKSPACE_ID = /^wsp_[0-9A-HJKMNP-TV-Z]{26}$/
const ACTOR_USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const OPERATOR_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const SCOPE_REF = /^adea-product:sha256:[0-9a-f]{64}$/

/** Canonical UTC only, and never after the CP clock. */
const fencedAt = (now: () => number) =>
  z.string().refine((value) => {
    const at = Date.parse(value)
    return Number.isFinite(at) && at <= now() && new Date(at).toISOString() === value
  }, 'fencedAt must be canonical UTC and not in the future')

export const LeadIntentFenceFactsV2Schema = (now: () => number) =>
  z
    .object({
      schemaVersion: z.literal('pi-lead-intent-fence/v2'),
      intentId: z.string().regex(INTENT_ID),
      workspaceId: z.string().regex(WORKSPACE_ID),
      dispatchPermitted: z.literal(false),
      rollbackFence: z
        .object({
          fencedAt: fencedAt(now),
          reason: z.enum(['operator_intervention', 'rollback_cohort']),
          actor: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('user'), userId: z.string().regex(ACTOR_USER_ID) }).strict(),
            z
              .object({ kind: z.literal('operator'), operatorId: z.string().regex(OPERATOR_ID) })
              .strict(),
          ]),
        })
        .strict(),
      authorityRevision: z.number().int().nonnegative(),
      canonicalActorPrincipalId: z.string().regex(/^user:[0-9a-f-]{36}$/i),
      scopeRef: z.string().regex(SCOPE_REF),
      allowedPrincipalIds: z.array(z.string().min(1).max(256)).min(1).max(1),
    })
    .strict()

export type LeadIntentFenceFactsV2 = z.infer<ReturnType<typeof LeadIntentFenceFactsV2Schema>>

export type LeadProductReadResult =
  | { readonly kind: 'admission'; readonly evidence: ProductionLeadProductEvidence }
  | { readonly kind: 'fenced'; readonly facts: LeadIntentFenceFactsV2 }

export type LeadOperation =
  'prepare' | 'dispatch' | 'resume' | 'publish' | 'status' | 'progress' | 'cancel'

/** Retained at the admission-time read. Compared, never trusted from the current body alone. */
export type RetainedFencePins = Readonly<{
  authorityRevision: number
  scopeRef: string
  canonicalActorPrincipalId: string
}>

/** Observation: the pins still match, and the requester is the one pinned. */
export function observeAllowed(
  current: LeadIntentFenceFactsV2,
  retained: RetainedFencePins,
  requesterPrincipalId: string
): boolean {
  return (
    current.authorityRevision === retained.authorityRevision &&
    current.scopeRef === retained.scopeRef &&
    current.canonicalActorPrincipalId === retained.canonicalActorPrincipalId &&
    current.allowedPrincipalIds.includes(requesterPrincipalId)
  )
}

/** Cancellation: observation rules, and the requester is the original admission actor, never the fence actor. */
export function cancelAllowed(
  current: LeadIntentFenceFactsV2,
  retained: RetainedFencePins,
  requesterPrincipalId: string,
  requesterActor: string
): boolean {
  return (
    observeAllowed(current, retained, requesterPrincipalId) &&
    requesterActor === retained.canonicalActorPrincipalId
  )
}

/** Only observation and actor-bound cancellation can use fenced facts. Everything else refuses. */
export const fencedOperationPolicy: Readonly<
  Record<LeadOperation, 'refuse' | 'observe' | 'cancel-as-actor'>
> = {
  prepare: 'refuse',
  dispatch: 'refuse',
  resume: 'refuse',
  publish: 'refuse',
  status: 'observe',
  progress: 'observe',
  cancel: 'cancel-as-actor',
}

/**
 * Parses one signed body from `createProductionProductHttpReader`. `pi-lead-intent/v1` takes the existing strict
 * path, unchanged. `pi-lead-intent-fence/v1` is not a fenced result, so it refuses. Unknown schemas, and any
 * identity mismatch, throw PI_PRODUCT_READER_UNAVAILABLE.
 */
export function parseLeadProductResponse(
  body: unknown,
  selectors: { workspaceId: string; intentId: string; principalId: string },
  now: () => number
): LeadProductReadResult {
  const schemaVersion =
    typeof body === 'object' && body !== null
      ? (body as { schemaVersion?: unknown }).schemaVersion
      : undefined
  if (schemaVersion === 'pi-lead-intent-fence/v2') {
    const facts = LeadIntentFenceFactsV2Schema(now).parse(body)
    if (
      facts.workspaceId !== selectors.workspaceId ||
      facts.intentId !== selectors.intentId ||
      !facts.allowedPrincipalIds.includes(selectors.principalId)
    )
      throw new Error('PI_PRODUCT_READER_UNAVAILABLE')
    return { kind: 'fenced', facts }
  }
  const evidence = ProductionLeadProductEvidenceSchema.parse(body)
  if (
    evidence.workspaceId !== selectors.workspaceId ||
    evidence.intentId !== selectors.intentId ||
    !evidence.allowedPrincipalIds.includes(selectors.principalId)
  )
    throw new Error('PI_PRODUCT_READER_UNAVAILABLE')
  return { kind: 'admission', evidence }
}
```

Where the change lands in CP at `ec742819`:

- `models/production-product-http.ts` `readCurrent`: currently calls `ProductionLeadProductEvidenceSchema.parse`
  on every body, so a fenced body throws `PI_PRODUCT_READER_UNAVAILABLE`. Replace that with
  `parseLeadProductResponse`, which returns the typed result.
- `models/production-lead-product.ts` `readCurrent`: accept the union. `admission` continues through the profile
  checks. `fenced` returns early and is never passed to the model or profile path.
- `pi-durable/node-admission.ts` `resolveIntent` and `assertCurrent`: route each operation through
  `fencedOperationPolicy`. A `refuse` result is refused before any state change. An `observe` or
  `cancel-as-actor` result is allowed only through `observeAllowed` or `cancelAllowed`, against the pins retained
  when the admission was created.

## Immutable producer fixtures

Each file is the exact body the Adea handler emits for a fixed input. Adea's test pins each file's SHA-256, so a
change needs a deliberate digest change in review.

| File (under `apps/web/test/contracts/`)            | Input                                                   | SHA-256                                                            |
| -------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| `lead-product-current.fenced-v2.json`              | user fence, rollback cohort, clock 2026-10-09T12:00:00Z | `69dc0516259fe1771dd221e49c35c760bcb3d2ab90f3132d147af35fa3437352` |
| `lead-product-current.fenced-v2-operator.json`     | operator fence, operator intervention, same clock       | `1d66d5057f7c21a05b39dc8cf0bcf25328ba1c8589b756fea3d570414536430a` |
| `lead-product-current.fenced.json` (v1, unchanged) | old minimal body, retained as a fail-closed fixture     | not emitted by the handler                                         |
| `lead-product-current.unfenced.json` (unchanged)   | v1 admission, for the scopeRef cross-check              | n/a                                                                |

Both v2 fixtures carry `authorityRevision` 2, `canonicalActorPrincipalId` `user:0f8b7c2e-1a2b-4c3d-8e9f-001122334455`,
`scopeRef` `adea-product:sha256:ea73cb08e627299c49a4abc2ee6cff42550fc09f7eefff5a5878ccba067b28ce` (the same as the
unfenced golden), and `allowedPrincipalIds` `["svc_control-plane"]`.

Adea's own test for the wrong principal and stale revision cases is `apps/web/test/lead-product-fence-pins-negative.test.ts`.
It includes reference predicates equal to those above. The CP consumer should reproduce its own version, and run
the same bytes.

## CP tests to add with this change

- Contract: the two v2 fixtures parse to `kind: 'fenced'`. The v1 fixture is refused.
- Each operation: `prepare`, `dispatch`, `resume` and `publish` refuse a fenced result, and no attempt is created or resumed.
- `status`, `progress`: observe only with the retained pins matching and the requester in `allowedPrincipalIds`.
  A wrong principal, a stale `authorityRevision` and a stale `scopeRef` each refuse.
- `cancel`: refuses unless the requester is the original admission actor. An operator fence does not substitute.
- A v2 body with an extra field, a future `fencedAt`, or a non-canonical `fencedAt` is refused.
- A `pi-lead-intent/v1` body with an extra field is still refused by the strict schema.

The current CP strict parser refuses v2 today, because it knows only v1 and the strict admission schema. That is
the fail-closed default until the CP change lands. Adea's CP checkout test records it.

CP obligations that do not depend on this proposal: check the stored fence in the same transaction that claims a
dispatch or resume, and persist the `rollbackFence` facts.

## Handoff

The fixtures above are immutable. They are handed to the CP worker as returned artifacts, not through a direct
edit in its worktree. The artifact is the commit that adds them on `feat/issue-1220-rollback-fencing`, with the
digests in the table as the check. Any change to a fixture needs a new digest here and a new review.
