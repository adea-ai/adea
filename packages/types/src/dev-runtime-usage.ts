import {
  exactKeys,
  fail,
  integerValue,
  record,
  stringValue,
} from './dev-runtime-validation-internal'

/** Reported snapshot for one model in one runtime-session generation. */
export type RuntimeUsageObservedPayload = Readonly<{
  schemaVersion: 1
  model: Readonly<{ providerId: string; modelId: string }>
  generation: number
  /** Current context occupancy and effective window; null means unknown. */
  context: Readonly<{ used: number | null; total: number | null }>
  /** Reported generation totals, independent of current context occupancy. */
  breakdown?: Readonly<{
    input?: number
    output?: number
    /** Cached input subsets; never add these to input again. */
    cacheRead?: number
    cacheWrite?: number
    /** Output subset; never add this to output again. */
    reasoning?: number
  }>
  /** Reported generation cost, preserved as an exact decimal without conversion. */
  cost?: Readonly<{ amount: string; currency: string }>
}>

function modelIdentifier(value: unknown, path: string): void {
  const text = stringValue(value, path, 1, 256)
  const hasControl = Array.from(text).some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || (code >= 127 && code <= 159)
  })
  if (text.trim() !== text || hasControl)
    fail(path, 'expected nonblank identifier without surrounding whitespace or controls')
}

/** Strict admission for observed figures; never derives missing usage or prices. */
export function decodeRuntimeUsageObservedPayload(
  value: unknown,
  expectedGeneration: number
): RuntimeUsageObservedPayload {
  const path = 'usage'
  const item = record(value, path)
  exactKeys(item, ['schemaVersion', 'model', 'generation', 'context'], ['breakdown', 'cost'], path)
  if (item.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'expected 1')
  integerValue(expectedGeneration, 'expectedGeneration', 0)
  if (integerValue(item.generation, `${path}.generation`, 0) !== expectedGeneration)
    fail(`${path}.generation`, 'does not match runtime event generation')

  const model = record(item.model, `${path}.model`)
  exactKeys(model, ['providerId', 'modelId'], [], `${path}.model`)
  modelIdentifier(model.providerId, `${path}.model.providerId`)
  modelIdentifier(model.modelId, `${path}.model.modelId`)

  const context = record(item.context, `${path}.context`)
  exactKeys(context, ['used', 'total'], [], `${path}.context`)
  const used = context.used === null ? null : integerValue(context.used, `${path}.context.used`, 0)
  const total =
    context.total === null ? null : integerValue(context.total, `${path}.context.total`, 1)
  if (used !== null && total !== null && used > total)
    fail(`${path}.context.used`, 'exceeds total context window')

  if ('breakdown' in item) {
    const breakdown = record(item.breakdown, `${path}.breakdown`)
    const keys = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const
    exactKeys(breakdown, [], keys, `${path}.breakdown`)
    if (Object.keys(breakdown).length === 0)
      fail(`${path}.breakdown`, 'expected a reported counter')
    for (const key of keys)
      if (key in breakdown) integerValue(breakdown[key], `${path}.breakdown.${key}`, 0)
    const counters = breakdown as NonNullable<RuntimeUsageObservedPayload['breakdown']>
    if (counters.input !== undefined) {
      if ((counters.cacheRead ?? 0) > counters.input)
        fail(`${path}.breakdown.cacheRead`, 'exceeds input tokens')
      // Subtraction avoids overflowing safe integer precision while checking the sum.
      if ((counters.cacheWrite ?? 0) > counters.input - (counters.cacheRead ?? 0))
        fail(`${path}.breakdown.cacheWrite`, 'combined cache tokens exceed input tokens')
    }
    if (
      counters.output !== undefined &&
      counters.reasoning !== undefined &&
      counters.reasoning > counters.output
    )
      fail(`${path}.breakdown.reasoning`, 'exceeds output tokens')
  }

  if ('cost' in item) {
    const cost = record(item.cost, `${path}.cost`)
    exactKeys(cost, ['amount', 'currency'], [], `${path}.cost`)
    const amount = stringValue(cost.amount, `${path}.cost.amount`, 1, 64)
    if (amount.trim() !== amount || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(amount))
      fail(`${path}.cost.amount`, 'expected nonnegative decimal string')
    const currency = stringValue(cost.currency, `${path}.cost.currency`, 3, 3)
    if (!/^[A-Z]{3}$/u.test(currency))
      fail(`${path}.cost.currency`, 'expected three uppercase letters')
  }

  return value as RuntimeUsageObservedPayload
}
