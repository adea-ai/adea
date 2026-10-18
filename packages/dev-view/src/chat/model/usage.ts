// The context figures a producer reported, for the composer's context trigger.
//
// Only an authoritative `usage.observed` event the wire gate accepted counts, and only
// one of the generation on screen: a figure from an earlier generation describes a
// window that no longer exists. A snapshot belongs to one provider and model, so the
// newest snapshot of the model the caller names wins; a model id with no provider is
// used only when one provider reported it. With no model named, the figures are shown
// only when the generation reported exactly one model, because occupancy of another
// model is not this conversation's context. Nothing is derived: a missing
// figure stays missing (never zero), and a reported cost stays the producer's exact
// decimal text, never a number.
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'
import {
  decodeRuntimeEvent,
  decodeRuntimeUsageObservedPayload,
} from '@adea-ai/types/dev-runtime-wire'

export type ChatUsageModel = Readonly<{ providerId?: string; modelId: string }>

export type ChatUsageFigures = Readonly<{
  /** The provider and model these figures describe. */
  model: Readonly<{ providerId: string; modelId: string }>
  used?: number
  total?: number
  breakdown?: Readonly<{
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    reasoning?: number
  }>
  /** Exact decimal text and currency as the producer reported them. */
  cost?: Readonly<{ amount: string; currency: string }>
}>

const sameModel = (
  reported: Readonly<{ providerId: string; modelId: string }>,
  wanted: ChatUsageModel
): boolean =>
  reported.modelId === wanted.modelId &&
  (wanted.providerId === undefined || reported.providerId === wanted.providerId)

/**
 * The newest snapshot of the named model. A model id alone does not identify a
 * snapshot: two providers can serve the same id with different windows, so when no
 * provider is named and more than one provider reported that id, none is chosen.
 */
function newestOf(
  accepted: readonly ReturnType<typeof decodeRuntimeUsageObservedPayload>[],
  wanted: ChatUsageModel
) {
  const matches = accepted.filter((entry) => sameModel(entry.model, wanted))
  if (
    wanted.providerId === undefined &&
    new Set(matches.map((entry) => entry.model.providerId)).size > 1
  )
    return undefined
  return matches[0]
}

export function latestUsageFigures(
  events: readonly RuntimeEvent[],
  generation: number,
  model?: ChatUsageModel
): ChatUsageFigures | undefined {
  const accepted: ReturnType<typeof decodeRuntimeUsageObservedPayload>[] = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.kind !== 'usage.observed' || event.generation !== generation) continue
    try {
      decodeRuntimeEvent(event, { source: event.source })
      accepted.push(decodeRuntimeUsageObservedPayload(event.payload, generation))
    } catch {
      // Not a usage observation the gate admits: keep looking for an earlier one.
    }
  }
  const usage =
    model === undefined
      ? accepted.every((entry) => sameModel(entry.model, accepted[0]!.model))
        ? accepted[0]
        : undefined
      : newestOf(accepted, model)
  if (usage === undefined) return undefined
  return {
    model: { providerId: usage.model.providerId, modelId: usage.model.modelId },
    ...(usage.context.used !== null ? { used: usage.context.used } : {}),
    ...(usage.context.total !== null ? { total: usage.context.total } : {}),
    ...(usage.breakdown !== undefined ? { breakdown: usage.breakdown } : {}),
    ...(usage.cost !== undefined
      ? { cost: { amount: usage.cost.amount, currency: usage.cost.currency } }
      : {}),
  }
}
