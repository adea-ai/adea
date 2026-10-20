// The provenance of a checkout.
//
// A receipt that names a commit is only reproducible when it also names the
// tree it was produced from and says whether that tree was clean. The
// provenance is read from the checkout itself, so it cannot drift away from
// it, and a receipt that carries no provenance is refused rather than
// believed.

import { spawnSync } from 'node:child_process'

/** Runs one git command in a checkout and returns its output. */
function defaultRunner(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  })
  if (result.error || result.status !== 0) {
    throw new Error('the checkout provenance could not be read')
  }
  return (result.stdout ?? '').trim()
}

/**
 * Reads the provenance of a checkout.
 *
 * The commit is the exact tree the run happened in, the dirty flag says
 * whether that tree still had uncommitted changes, and the source names the
 * ref the run was made from.
 */
export function readCheckoutProvenance(root, run = defaultRunner) {
  let sha
  let status
  let source
  try {
    sha = run(root, ['rev-parse', 'HEAD'])
    status = run(root, ['status', '--porcelain'])
    source = run(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {
    // A checkout that cannot be read has no provenance. The record says so,
    // and every consumer of it refuses the receipt rather than believing it.
    return { sha: '', dirty: null, source: 'unavailable' }
  }
  return {
    sha,
    dirty: status.length > 0,
    source: source.length > 0 ? source : 'unknown',
  }
}

/**
 * Requires a provenance that can be reproduced.
 *
 * A dirty tree is refused: a receipt produced from uncommitted changes names
 * a commit that does not contain them, so it cannot be reproduced. A missing
 * commit or a missing source is refused for the same reason.
 */
export function assertReproducibleProvenance(provenance) {
  const sha = provenance?.sha
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('the receipt does not name the exact commit it was produced from')
  }
  if (provenance?.dirty !== false) {
    throw new Error('the receipt was produced from a working tree that was not clean')
  }
  const source = provenance?.source
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('the receipt does not name the source it was produced from')
  }
  return { sha, dirty: false, source }
}
