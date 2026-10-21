// The CI gate for the built-Worker desktop-auth receipt.
//
// The qualification is the acceptance lane's own: it prints one receipt, and
// the exit status is the verdict. This gate is the CI side of that contract. A
// receipt is published only when it proves the exact head the job checked out,
// when every assertion it made passed, and when the teardown removed what the
// run owned.
//
// The contract is the receipt the qualification publishes. This gate reads it
// and applies the rules that contract states: the proof kind, the pass rule
// (every assertion passed, and the run proved something), the evidence class,
// the exact source and head with the artifact's identity, and the cleanup
// verdict that the receipt may only carry once the Worker was stopped and its
// material was removed. The shared provenance check is imported rather than
// restated.
//
// The gate runs with Bun, because the qualification and its contract modules
// are TypeScript with extensionless internal imports, which Node's resolver
// cannot load.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertReproducibleProvenance } from './fresh-postgres-acceptance/provenance.mjs'

/** The prefix the qualification prints its receipt with. */
export const BUILT_WORKER_RECEIPT_PREFIX = 'BUILT_WORKER_DESKTOP_AUTH '

/** The kind of proof the qualification publishes. */
export const BUILT_WORKER_PROOF_KIND = 'built-worker-desktop-auth'

/**
 * The receipt the qualification printed, or a failure when it printed none.
 *
 * A run that failed, was cancelled or was interrupted prints no receipt at
 * all, and a receipt that is not the qualification's own is not a receipt.
 */
export function parseBuiltWorkerReceipt(output) {
  for (const line of String(output ?? '')
    .split('\n')
    .toReversed()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(BUILT_WORKER_RECEIPT_PREFIX)) continue
    try {
      const parsed = JSON.parse(trimmed.slice(BUILT_WORKER_RECEIPT_PREFIX.length))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // A line that is not JSON is not a receipt; an earlier one may be.
    }
  }
  throw new Error('the built-Worker qualification printed no receipt')
}

/**
 * Requires the receipt to be a proof of the exact head, with real assertions
 * behind it and its own cleanup settled.
 *
 * `expectedSha` is the commit the job checked out. The receipt has to name it:
 * a receipt that names another commit is not a proof of this pull request, and
 * a Worker that was built from another tree is not a proof of it either.
 */
export function assertBuiltWorkerReceipt(receipt, options = {}) {
  const expectedSha = options.expectedSha
  if (typeof expectedSha !== 'string' || !/^[0-9a-f]{40}$/.test(expectedSha)) {
    throw new Error('the expected head is not an exact commit')
  }

  // The kind of proof this receipt has to be. The shared database-proof check
  // accepts every kind the repository knows, and this is the qualification's
  // own kind: a receipt of another kind is not a proof of the built Worker.
  if (receipt?.proofKind !== BUILT_WORKER_PROOF_KIND) {
    throw new Error('the receipt is not a built-Worker desktop-auth proof')
  }

  // A failed receipt carries no value, and a simulated result proves nothing.
  if (receipt?.status !== 'passed') {
    throw new Error('the receipt is not a passed proof')
  }
  if (receipt?.evidence === 'simulated') {
    throw new Error('a simulated result does not prove a built Worker')
  }
  // A receipt that does not say how much it is worth is not evidence. Only the
  // classes a real run may claim are accepted: a CI run and a local disposable
  // run both prove a built Worker, and nothing else does.
  if (receipt?.evidence !== 'ci' && receipt?.evidence !== 'local-disposable') {
    throw new Error('the receipt does not carry a real evidence class')
  }

  // The pass rule the contract states: every assertion passed, and the run
  // proved something. A run that proved nothing is a failed run.
  const assertions = Array.isArray(receipt?.assertions) ? receipt.assertions : []
  const failed = assertions.filter((assertion) => assertion?.passed !== true)
  if (failed.length > 0 || !(receipt.passed > 0)) {
    throw new Error('the built-Worker qualification failed')
  }
  if (receipt.failed !== 0) {
    throw new Error('the built-Worker qualification failed')
  }

  // The exact head, from a clean tree, and the code from the same tree.
  const checkout = assertReproducibleProvenance(receipt.checkout)
  if (checkout.sha !== expectedSha) {
    throw new Error('the receipt does not name the exact head the job checked out')
  }
  const module = assertReproducibleProvenance(receipt.module)
  if (module.sha !== checkout.sha) {
    throw new Error('the receipt was produced from a different tree than the code came from')
  }

  // The artifact the qualification proved belongs to this checkout: the build
  // stamp names this exact commit, and the tree it was built from was clean.
  if (receipt.worker?.built !== true) {
    throw new Error('the receipt does not name a built Worker')
  }
  const artifact = receipt.worker.artifact
  if (artifact?.verified !== true) {
    throw new Error('the built Worker was not proved to belong to this checkout')
  }
  if (artifact.sha !== checkout.sha) {
    throw new Error('the built Worker was built from another commit')
  }
  if (artifact.dirty !== false) {
    throw new Error('the built Worker was built from a tree that was not clean')
  }

  // The cleanup gate: the receipt may only exist when the Worker was stopped
  // and its material was removed. A container the run could not remove is
  // reported by the job's own resource check.
  const cleanup = receipt.cleanup
  if (!cleanup) {
    throw new Error('the receipt carries no cleanup verdict')
  }
  if (cleanup.workerStopped !== true || cleanup.materialRemoved !== true) {
    throw new Error('the run did not clean up after itself')
  }

  return { checkout, module, artifact, cleanup }
}

/**
 * Gates the receipt the qualification printed and writes the artifact the job
 * publishes. A refused receipt fails the job: the artifact is not written.
 */
export function gateBuiltWorkerReceipt(options = {}) {
  const output = options.output ?? readFileSync(resolve(options.receiptFile), 'utf8')
  const receipt = parseBuiltWorkerReceipt(output)
  const proven = assertBuiltWorkerReceipt(receipt, { expectedSha: options.expectedSha })
  if (options.artifactFile) {
    writeFileSync(resolve(options.artifactFile), `${JSON.stringify(receipt, null, 2)}\n`)
  }
  return { receipt, proven }
}

/**
 * The gate as the job runs it: the exit code the job sees.
 *
 * The program never throws out of here. A refused receipt is a failed job, a
 * missing argument is a usage error, and a proof of the exact head is a pass.
 */
export function main(argv, options = {}) {
  const log = options.log ?? console.log
  const fail = options.fail ?? console.error
  const [receiptFile, expectedSha, artifactFile] = argv
  if (!receiptFile || !expectedSha || !artifactFile) {
    fail(
      'usage: ci-built-worker-desktop-auth.mjs <receipt-file> <expected-head-sha> <artifact-file>'
    )
    return 2
  }
  try {
    const { receipt, proven } = gateBuiltWorkerReceipt({
      receiptFile,
      expectedSha,
      artifactFile,
    })
    log(
      'the built-Worker desktop-auth receipt was gated: ' +
        JSON.stringify({
          head: proven.checkout.sha,
          evidence: receipt.evidence,
          artifact: proven.artifact.digest,
          assertions: receipt.passed,
        })
    )
    return 0
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
