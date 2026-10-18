// The context figures a producer reported, for the composer's context trigger.
//
// Only an authoritative `usage.observed` event the wire gate accepted counts, and only
// one of the generation on screen: a figure from an earlier generation describes a
// window that no longer exists. The newest such event wins. Nothing is derived: a
// missing figure stays missing (never zero), and a reported cost is passed on only
// when it survives the number the shared component takes without changing its value.
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'
import {
  decodeRuntimeEvent,
  decodeRuntimeUsageObservedPayload,
} from '@adea-ai/types/dev-runtime-wire'

export type ChatUsageFigures = Readonly<{
  used?: number
  total?: number
  breakdown?: Readonly<{
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    reasoning?: number
  }>
  cost?: Readonly<{ amount: number; currency?: string }>
}>

/** A decimal string as the same value in a number, or nothing when the number would be a different value. */
function exactNumber(decimal: string): number | undefined {
  const value = Number(decimal)
  if (!Number.isFinite(value)) return undefined
  const trimmed = decimal.includes('.') ? decimal.replace(/0+$/, '').replace(/\.$/, '') : decimal
  return String(value) === trimmed ? value : undefined
}

export function latestUsageFigures(
  events: readonly RuntimeEvent[],
  generation: number
): ChatUsageFigures | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.kind !== 'usage.observed' || event.generation !== generation) continue
    let usage: ReturnType<typeof decodeRuntimeUsageObservedPayload>
    try {
      decodeRuntimeEvent(event, { source: event.source })
      usage = decodeRuntimeUsageObservedPayload(event.payload, generation)
    } catch {
      // Not a usage observation the gate admits: keep looking for an earlier one.
      continue
    }
    const cost = usage.cost === undefined ? undefined : exactNumber(usage.cost.amount)
    return {
      ...(usage.context.used !== null ? { used: usage.context.used } : {}),
      ...(usage.context.total !== null ? { total: usage.context.total } : {}),
      ...(usage.breakdown !== undefined ? { breakdown: usage.breakdown } : {}),
      ...(usage.cost !== undefined && cost !== undefined
        ? { cost: { amount: cost, currency: usage.cost.currency } }
        : {}),
    }
  }
  return undefined
}
