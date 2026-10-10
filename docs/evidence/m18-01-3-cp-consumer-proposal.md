# M18.01.3 control-plane consumer proposal

Status: proposal for the control-plane owners, not implemented. Nothing in `adea-ai/control-plane` is changed
by this PR. The local CP checkout at `ec742819` has unrelated uncommitted edits, and they were not touched.
Tracking: control-plane #940 and #942, both open.

Reviewed against CP's committed tree at `ec742819`. File names below refer to that commit.

## What Adea emits after this head

Unfenced, dispatchable admission: `pi-lead-intent/v1`, unchanged.

Fenced admission: HTTP 200, `cache-control: private, no-store`, and only these fields:

```json
{
  "schemaVersion": "pi-lead-intent-fence/v1",
  "intentId": "<uuid, equal to the requested intentId>",
  "workspaceId": "wsp_<26 chars, equal to the requested workspaceId>",
  "dispatchPermitted": false,
  "rollbackFence": {
    "fencedAt": "<canonical UTC ISO-8601, not later than Adea's clock>",
    "reason": "operator_intervention | rollback_cohort",
    "actor": { "kind": "user", "userId": "<uuid>" } | { "kind": "operator", "operatorId": "<id>" }
  }
}
```

Adea refuses (HTTP 404 `LEAD_PRODUCT_UNAVAILABLE`, with no fence facts) when:

- `dispatchPermitted` is not exactly `false` with a fence, or not exactly `true` without one.
- The fence has extra or missing keys, a non-object `actor`, an unknown `reason` or actor `kind`, or a
  malformed `userId` or `operatorId`.
- `fencedAt` is not in canonical form (`Date.parse` plus `toISOString` round trip), or is later than
  Adea's clock. There is no skew tolerance.
- The identity of the product does not match the requested workspace and intent.

## Why CP cannot yet act on fenced status or cancel

CP's `NodePiDurableLeadAdmission.resolveIntent` and `assertCurrent` (`pi-durable/node-admission.ts`)
call `#evidence()` for every operation, and that call requires full v1 evidence. The fence-only body has
no `scopeRef`, `allowedPrincipalIds` or `canonicalActorPrincipalId`, so read-safe observation and
actor-scoped cancel cannot be authorized from it. Until root decides on the pinned variant (last section),
CP must refuse fenced results for every operation. That is the fail-closed default, and it matches the
behaviour today.

## Proposed typed consumer (CP `apps/control-api`)

Sketch in zod, the schema library CP already uses. It has not been compiled against CP.

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

/** Canonical UTC only, and never after the CP clock. */
const fencedAt = (now: () => number) =>
  z.string().refine((value) => {
    const at = Date.parse(value)
    return Number.isFinite(at) && at <= now() && new Date(at).toISOString() === value
  }, 'fencedAt must be canonical UTC and not in the future')

export const LeadIntentFenceFactsV1Schema = (now: () => number) =>
  z
    .object({
      schemaVersion: z.literal('pi-lead-intent-fence/v1'),
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
    })
    .strict()

export type LeadIntentFenceFactsV1 = z.infer<ReturnType<typeof LeadIntentFenceFactsV1Schema>>

export type LeadProductReadResult =
  | { readonly kind: 'admission'; readonly evidence: ProductionLeadProductEvidence }
  | { readonly kind: 'fenced'; readonly facts: LeadIntentFenceFactsV1 }

export type LeadOperation = 'prepare' | 'dispatch' | 'status' | 'progress' | 'cancel'

/**
 * Fenced facts are never a dispatchable product. Until the pinned variant is approved, no operation may
 * act on them. Status, progress and cancel stay refused, which is today's behaviour.
 */
export const fencedOperationPolicy: Readonly<Record<LeadOperation, 'refuse'>> = {
  prepare: 'refuse',
  dispatch: 'refuse',
  status: 'refuse',
  progress: 'refuse',
  cancel: 'refuse',
}

/**
 * Parses one signed body from `createProductionProductHttpReader`. The `pi-lead-intent/v1` path is the
 * existing strict parse, unchanged. Unknown schemas, and any identity mismatch, throw
 * PI_PRODUCT_READER_UNAVAILABLE.
 */
export function parseLeadProductResponse(
  body: unknown,
  selectors: { workspaceId: string; intentId: string; principalId: string },
  now: () => number
): LeadProductReadResult {
  if (
    typeof body === 'object' &&
    body !== null &&
    (body as { schemaVersion?: unknown }).schemaVersion === 'pi-lead-intent-fence/v1'
  ) {
    const facts = LeadIntentFenceFactsV1Schema(now).parse(body)
    if (facts.workspaceId !== selectors.workspaceId || facts.intentId !== selectors.intentId)
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
- `models/production-lead-product.ts` `readCurrent`: accept the union. `admission` continues through the
  profile checks. `fenced` returns early and is never passed to the model or profile path.
- `pi-durable/node-admission.ts` `resolveIntent` and `assertCurrent`: route each operation through
  `fencedOperationPolicy`, so a fenced result is refused before any state change.

CP tests to add with this change:

- Contract: `apps/web/test/contracts/lead-product-current.fenced.json` parses to `kind: 'fenced'`. Each
  negative from the list above is refused.
- Every operation returns refused for a fenced result, and no attempt is created or resumed.
- A `pi-lead-intent/v1` body with an extra field is still refused by the strict schema.
- A `fencedAt` in the future is refused by CP's clock.

CP obligations that do not depend on this proposal (from the evidence record, unchanged): check the stored
fence in the same transaction that claims a dispatch or resume, and persist the `rollbackFence` facts.

## Decision item: pinned fence variant (not emitted by this head)

Read-safe observation and actor-scoped cancel need the four pins from the coordinated CP change. Adding
them widens what the fenced body discloses, so this is a separate decision for root. If root approves it,
the typed variant would be:

```ts
// Not emitted by Adea in this head. Shown so the decision can be made against a concrete type.
export type LeadIntentFenceFactsV2Pinned = LeadIntentFenceFactsV1 & {
  readonly authorityRevision: number
  readonly canonicalActorPrincipalId: `user:${string}`
  readonly scopeRef: `adea-product:sha256:${string}`
  readonly allowedPrincipalIds: readonly string[]
}
```

If approved, `fencedOperationPolicy` can change `status` and `progress` to `observe`, and `cancel` to
`cancel-as-actor`, but only for a principal in `allowedPrincipalIds`, and only for the actor in
`canonicalActorPrincipalId`. The fixture
`apps/web/test/contracts/lead-product-current.fenced.json` would need a matching update on the Adea side.
