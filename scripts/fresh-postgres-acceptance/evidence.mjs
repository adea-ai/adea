// The evidence class of an acceptance receipt.
//
// A receipt says what ran. The class says what that run is worth. A synthetic
// child proves the runner's gates; it does not prove PostgreSQL. A local
// disposable instance proves the provider and the database; it does not prove
// the hosted target. A CI run proves the lane in CI. A live run proves the
// Railway target, and only an authorized live run may claim that class.
//
// The classes are ordered by strength. A receipt may never claim a class
// stronger than the source that produced it, so a simulated result can not be
// recorded as a CI result and a local result can not be recorded as a live
// one. Live acceptance stays root-owned, so the live class is refused until
// it is authorized.

/** The evidence classes, weakest first. */
export const EVIDENCE_CLASSES = Object.freeze(['simulated', 'local-disposable', 'ci', 'live'])

/** The source that produced a receipt, and the class that source may claim. */
export const EVIDENCE_SOURCES = Object.freeze({
  'synthetic-child': 'simulated',
  'memory-journey': 'simulated',
  'local-disposable': 'local-disposable',
  'ci-disposable-proof': 'ci',
  'live-railway': 'live',
})

/**
 * The class a source may claim.
 *
 * A live source needs an explicit authorization. Without one the run is
 * refused, because a live acceptance that nobody authorized is not evidence.
 */
export function classifyEvidence(source, options = {}) {
  const authorized = options.authorized === true
  const mapped = Object.prototype.hasOwnProperty.call(EVIDENCE_SOURCES, source)
    ? EVIDENCE_SOURCES[source]
    : undefined
  if (!mapped) throw new Error('unknown acceptance evidence source: ' + String(source))
  if (mapped === 'live' && !authorized) {
    throw new Error(
      'live acceptance evidence is not authorized; live acceptance stays root-owned and open'
    )
  }
  return mapped
}

/**
 * The class a real disposable run may claim.
 *
 * A disposable proof that provisions a real container and proves against a
 * real database is `local-disposable` here, and `ci` when the run happened in
 * CI. The class is never `simulated`: a simulated run is not a run of this
 * proof, and the mocked harness that stands in for it says so itself.
 */
export function classifyDisposableProofEvidence(environment = {}) {
  return environment.GITHUB_ACTIONS === 'true' ? 'ci' : 'local-disposable'
}

/** The class a receipt carries, or a refusal when it carries none. */
export function assertEvidenceClass(value) {
  if (typeof value !== 'string' || !EVIDENCE_CLASSES.includes(value)) {
    throw new Error('unknown acceptance evidence class: ' + String(value))
  }
  return value
}

/**
 * Checks a receipt against the source that produced it.
 *
 * The receipt's class must be known, and it may not be stronger than the
 * class its source may claim. A receipt that claims more than its source
 * produced is refused rather than published.
 */
export function assertEvidenceNotPromoted(receipt, source, options = {}) {
  const expected = classifyEvidence(source, options)
  const actual = assertEvidenceClass(receipt?.evidence)
  if (EVIDENCE_CLASSES.indexOf(actual) > EVIDENCE_CLASSES.indexOf(expected)) {
    throw new Error(
      'acceptance evidence class ' + actual + ' is stronger than its source ' + source
    )
  }
  return actual
}

/**
 * The evidence a receipt must carry before it may be published.
 *
 * A receipt without a class is refused: a result that does not say how much it
 * is worth cannot be counted as evidence.
 */
export function receiptEvidence(receipt, source, options = {}) {
  const classified = classifyEvidence(source, options)
  const actual = assertEvidenceClass(receipt?.evidence)
  if (actual !== classified) {
    throw new Error(
      'acceptance receipt evidence ' + actual + ' does not match its source ' + source
    )
  }
  return actual
}
