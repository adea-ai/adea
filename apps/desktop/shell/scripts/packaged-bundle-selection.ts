// The packaged bundle selection and the packaged lane's exit code.
//
// The packaged lanes drive the REAL packaged macOS bundle, so they may only ever
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
// Both decisions are pure over injected filesystem seams, so they are testable
// without a build, a bundle, or an app.

import path from 'node:path'

/** The development bundle's name inside the channel directory. */
export const DEV_BUNDLE_NAME = 'Adea-dev.app'

/** The development channel directory: the supported macOS target architecture. */
export const DEV_CHANNEL_DIRECTORY = 'dev-macos-arm64'

/** Why a candidate did not qualify. */
export const DEV_BUNDLE_REJECTIONS = {
  ambiguous: 'ambiguous',
  missing: 'missing',
  stableOnly: 'stable-only',
  wrongArchitecture: 'wrong-architecture',
  wrongLayout: 'wrong-layout',
} as const

export type DevBundleRejection = (typeof DEV_BUNDLE_REJECTIONS)[keyof typeof DEV_BUNDLE_REJECTIONS]

export type DevBundleSelection =
  | { bundle: string; reason: 'selected' }
  | { bundle: null; reason: DevBundleRejection }

/**
 * The filesystem seams the selection runs over: the names of the DIRECTORIES in
 * a directory, and whether a path exists. An unreadable or absent directory
 * lists as empty, which the selection treats as "no candidate" rather than as
 * an error.
 */
export type DevBundleFileSystem = {
  exists(path: string): boolean
  listDirectory(path: string): readonly string[]
}

/**
 * Selects the packaged development bundle, or names why no candidate qualifies.
 */
export function selectDevAppBundle(input: {
  buildRoot: string
  exists: (path: string) => boolean
  listDirectory: (path: string) => readonly string[]
}): DevBundleSelection {
  const rootEntries = input.listDirectory(input.buildRoot)
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

  const channelEntries = input.listDirectory(path.join(input.buildRoot, DEV_CHANNEL_DIRECTORY))
  const bundles = channelEntries.filter((name) => name.endsWith('.app'))
  if (bundles.length === 0) return { bundle: null, reason: DEV_BUNDLE_REJECTIONS.missing }
  // More than one candidate: nothing says which one is the development bundle.
  if (bundles.length > 1) return { bundle: null, reason: DEV_BUNDLE_REJECTIONS.ambiguous }
  // The supported channel directory holds a bundle with another name: that is
  // not the development bundle this lane pins.
  if (bundles[0] !== DEV_BUNDLE_NAME)
    return { bundle: null, reason: DEV_BUNDLE_REJECTIONS.wrongLayout }

  const bundle = path.join(input.buildRoot, DEV_CHANNEL_DIRECTORY, DEV_BUNDLE_NAME)
  if (!input.exists(bundle)) return { bundle: null, reason: DEV_BUNDLE_REJECTIONS.missing }
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
export function packagedLaneExitCode(input: {
  buildStatus: number | null
  bundle: string | null
}): number {
  if (input.buildStatus !== 0) return input.buildStatus ?? 1
  return input.bundle ? 0 : 1
}
