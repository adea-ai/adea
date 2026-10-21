import { createHash } from 'node:crypto'

/**
 * Canonical JSON: object keys sorted at every level and absent keys dropped,
 * so two receipts that mean the same thing hash the same however their
 * evidence objects were constructed. Array order is significant and kept.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)])
    )
  }
  return value
}

/**
 * The digest of one published child outcome, bound to the exact parent
 * dispatch it was delivered under. The receipt table stores only this digest,
 * so a replay of the same outcome is recognised as the same outcome and a
 * changed one is refused. Canonicalising before hashing is what makes that
 * comparison independent of property order.
 */
export function leadChildOutcomeDigest(binding: unknown, evidence: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical({ binding, evidence })))
    .digest('hex')
}
