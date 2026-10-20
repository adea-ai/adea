// The CI gate for the fresh-account acceptance receipt.
//
// The acceptance lane prints a receipt and fails when it cannot prove
// anything. This is the CI side of that gate: a receipt is published only when
// it is the lane's own proof, it names the exact head the job checked out, and
// it shows a journey that really executed.
//
// A skipped run, a zero-pass run and a receipt from another tree are all
// refused. The lane's own contract is reused rather than restated: this module
// imports the acceptance lane's proof and provenance checks, so a receipt
// qualifies here exactly when it qualifies there.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyDisposableProofEvidence } from './fresh-postgres-acceptance/evidence.mjs'
import { assertReproducibleProvenance } from './fresh-postgres-acceptance/provenance.mjs'
import { assertDatabaseProof } from './fresh-postgres-acceptance/recovery.mjs'

/** The measured counts a journey that really executed carries. */
const EXECUTED_COUNTS = ['accounts', 'mappedUsers', 'exchanges']

/** The refusals a journey that really executed carries. */
const REFUSED_CASES = ['origin', 'pkce', 'replay']

/**
 * Requires the receipt to be a proof of the exact head, with real executed
 * tests behind it.
 *
 * `expectedSha` is the commit the job checked out. The receipt must name it:
 * a receipt that names any other commit, or a tree that was not clean, or a
 * tree the code did not come from, is refused.
 */
export function assertFreshAccountReceipt(receipt, options = {}) {
  const expectedSha = options.expectedSha
  if (typeof expectedSha !== 'string' || !/^[0-9a-f]{40}$/.test(expectedSha)) {
    throw new Error('the expected head is not an exact commit')
  }

  // The lane's own contract: a passed, real database proof. A simulated
  // result, a failed result and a result of another kind are refused there.
  assertDatabaseProof(receipt)

  // The exact head the job checked out, from a clean tree.
  const checkout = assertReproducibleProvenance(receipt.checkout)
  if (checkout.sha !== expectedSha) {
    throw new Error('the receipt does not name the exact head the job checked out')
  }
  const module = assertReproducibleProvenance(receipt.module)
  if (module.sha !== checkout.sha) {
    throw new Error('the receipt was produced from a different tree than the code came from')
  }

  // The journey really executed. A receipt without the journey's result, with
  // no measured account, exchange or mapping, or with no refused case, is a
  // result that proved nothing.
  const journey = receipt.desktopPrincipal
  if (!journey || typeof journey !== 'object') {
    throw new Error('the receipt carries no journey result')
  }
  if (journey.provider !== 'better-auth') {
    throw new Error('the receipt did not run the real provider')
  }
  for (const name of EXECUTED_COUNTS) {
    if (!Number.isInteger(journey[name]) || journey[name] < 1) {
      throw new Error('the receipt shows no executed ' + name)
    }
  }
  const refused = journey.refused
  if (!refused || typeof refused !== 'object') {
    throw new Error('the receipt shows no refused journey case')
  }
  for (const name of REFUSED_CASES) {
    if (!Number.isInteger(refused[name]) || refused[name] < 1) {
      throw new Error('the receipt shows no refused ' + name + ' case')
    }
  }

  return { checkout, module, journey }
}

/**
 * The artifact the job publishes.
 *
 * The receipt keeps the class the lane gave it, and the artifact carries the
 * class the source may claim: a disposable proof that ran in CI is a CI
 * result. Both are present, so the relabel hides nothing.
 */
export function buildFreshAccountArtifact(receipt, options = {}) {
  const environment = options.environment ?? process.env
  return {
    ...receipt,
    evidence: classifyDisposableProofEvidence(environment),
    laneEvidence: receipt.evidence,
    ciRun: {
      head: options.head ?? '',
      runId: options.runId ?? '',
      workflow: options.workflow ?? '',
      repository: options.repository ?? '',
    },
  }
}

/**
 * The receipt the lane printed: the last line of its output that is JSON.
 * Anything else is not a receipt.
 */
export function parseAcceptanceReceipt(output) {
  const lines = String(output ?? '')
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
  for (const line of lines.toReversed()) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // A line that is not JSON is not a receipt; an earlier one may be.
    }
  }
  throw new Error('the acceptance lane printed no receipt')
}

/**
 * Gates the receipt the lane printed and writes the artifact the job
 * publishes. A refused receipt fails the job: the artifact is not written.
 */
export function gateAcceptanceReceipt(options = {}) {
  const output = options.output ?? readFileSync(resolve(options.receiptFile), 'utf8')
  const receipt = parseAcceptanceReceipt(output)
  const proven = assertFreshAccountReceipt(receipt, { expectedSha: options.expectedSha })
  const artifact = buildFreshAccountArtifact(receipt, {
    environment: options.environment,
    head: options.expectedSha,
    runId: options.runId,
    workflow: options.workflow,
    repository: options.repository,
  })
  if (options.artifactFile) {
    writeFileSync(resolve(options.artifactFile), `${JSON.stringify(artifact, null, 2)}\n`)
  }
  return { receipt, artifact, proven }
}

/**
 * The gate as the job runs it: the exit code the job sees.
 *
 * The program never throws out of here. A refused receipt is a failed job, a
 * missing argument is a usage error, and a proof of the exact head is a pass.
 */
export function main(argv, options = {}) {
  const environment = options.environment ?? process.env
  const log = options.log ?? console.log
  const fail = options.fail ?? console.error
  const [receiptFile, expectedSha, artifactFile] = argv
  if (!receiptFile || !expectedSha || !artifactFile) {
    fail(
      'usage: ci-fresh-account-acceptance.mjs <receipt-file> <expected-head-sha> <artifact-file>'
    )
    return 2
  }
  try {
    const { artifact, proven } = gateAcceptanceReceipt({
      receiptFile,
      expectedSha,
      artifactFile,
      environment,
      runId: environment.GITHUB_RUN_ID,
      workflow: environment.GITHUB_WORKFLOW,
      repository: environment.GITHUB_REPOSITORY,
    })
    log(
      'the fresh-account acceptance receipt was gated: ' +
        JSON.stringify({
          head: proven.checkout.sha,
          evidence: artifact.evidence,
          laneEvidence: artifact.laneEvidence,
          accounts: proven.journey.accounts,
          exchanges: proven.journey.exchanges,
        })
    )
    return 0
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return 1
  }
}

// The job runs this module with Node, whose `import.meta.main` is absent
// before Node 24, so the fallback names the entry point as well.
if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
