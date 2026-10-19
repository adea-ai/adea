// The packaged lane's bundle selection and its exit code.
//
// The packaged lane drives the REAL packaged macOS bundle, so it may only ever
// drive the one bundle the repository pins as the development target:
// `<shell build>/dev-macos-arm64/Adea-dev.app` — the same path the install
// helper, the transport probe and the packaged suites all use.
//
// A build root can also hold a stable-channel bundle (the auto-update
// artefact, which carries no bundled Dev Runtime sidecar), a bundle built for
// another architecture, or more than one candidate. Selecting any of those
// would run the packaged proofs against something the lane does not mean to
// prove, so the selection is fail-closed: it returns the one supported bundle
// or names why no candidate qualifies.
//
// Both decisions are pure over injected filesystem seams, so they are
// testable without a build, a bundle, or an app.

import path from 'node:path'

/** The development bundle's name inside the channel directory. */
export const DEV_BUNDLE_NAME = 'Adea-dev.app'

/** The development channel directory: the supported macOS target architecture. */
export const DEV_CHANNEL_DIRECTORY = 'dev-macos-arm64'

/** Why a candidate did not qualify. */
export const DEV_BUNDLE_REJECTIONS = Object.freeze({
  ambiguous: 'ambiguous',
  missing: 'missing',
  stableOnly: 'stable-only',
  wrongArchitecture: 'wrong-architecture',
  wrongLayout: 'wrong-layout',
})

/**
 * Selects the packaged development bundle, or names why no candidate qualifies.
 *
 * `listDirectory` returns the names of the DIRECTORIES in a directory (an
 * unreadable or absent directory lists as empty), and `exists` reports whether
 * a path exists. Both are injected so the decision is deterministic and needs
 * no filesystem at all.
 */
export function selectDevAppBundle({ buildRoot, exists, listDirectory }) {
  const rootEntries = listDirectory(buildRoot)
  if (!rootEntries.includes(DEV_CHANNEL_DIRECTORY)) {
    // A development bundle for ANOTHER architecture is not this lane's target,
    // and neither is a stable-channel bundle.
    const otherDevelopment = rootEntries.filter((name) => name.startsWith('dev-macos-'))
    if (otherDevelopment.length > 0)
      return { bundle: null, reason: DEV_BUNDLE_REJECTIONS.wrongArchitecture }
    const stable = rootEntries.filter((name) => name.startsWith('stable-macos-'))
    if (stable.length > 0) return { bundle: null, reason: DEV_BUNDLE_REJECTIONS.stableOnly }
    return { bundle: null, reason: DEV_BUNDLE_REJECTIONS.missing }
  }

  const channelEntries = listDirectory(path.join(buildRoot, DEV_CHANNEL_DIRECTORY))
  const bundles = channelEntries.filter((name) => name.endsWith('.app'))
  if (bundles.length === 0) return { bundle: null, reason: DEV_BUNDLE_REJECTIONS.missing }
  // More than one candidate: nothing says which one is the development bundle.
  if (bundles.length > 1) return { bundle: null, reason: DEV_BUNDLE_REJECTIONS.ambiguous }
  // The supported channel directory holds a bundle with another name: that is
  // not the development bundle this lane pins.
  if (bundles[0] !== DEV_BUNDLE_NAME)
    return { bundle: null, reason: DEV_BUNDLE_REJECTIONS.wrongLayout }

  const bundle = path.join(buildRoot, DEV_CHANNEL_DIRECTORY, DEV_BUNDLE_NAME)
  if (!exists(bundle)) return { bundle: null, reason: DEV_BUNDLE_REJECTIONS.missing }
  return { bundle, reason: 'selected' }
}

/**
 * The lane's exit code.
 *
 * A build that failed keeps its own status; a build killed by a signal has
 * none, so it is 1. A build that SUCCEEDED but produced no usable bundle is a
 * lane FAILURE: the lane must not exit successfully for a run that proved
 * nothing.
 */
export function packagedLaneExitCode({ buildStatus, bundle }) {
  if (buildStatus !== 0) return buildStatus ?? 1
  return bundle ? 0 : 1
}
