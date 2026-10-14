// The Electrobun installer keeps the decompressed app payload it just
// installed (`self-extraction/<hash>.tar`, roughly 700 MB) so Electrobun's own
// updater can build delta patches against it. Adea updates through its own
// signed feed (updates.ts, updater.ts) and never calls Electrobun's updater,
// so that copy is dead weight for the life of the install. Neither Electrobun
// 2.0.x's `electrobun.config.ts` nor its extractor has an option to skip it
// (`release.generatePatch` only controls patch generation at build time), so
// the shell retires the one copy the installer wrote for the running build.
//
// The rule is deliberately narrow:
// - only `<hash>.tar`, where `<hash>` is the hash in the running bundle's own
//   `Resources/version.json`: the installer run that produced this bundle;
// - an install that was later replaced by an Adea update runs a bundle with a
//   different hash, so the archive left by the original installer (historical
//   user data) never matches and is never touched;
// - only a regular file under the identity's own `self-extraction` directory,
//   never a symlink, and never while an Electrobun prepared-update record
//   exists;
// - best effort: nothing here can throw or block a boot.
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** The extractor only accepts hashes of this shape when it names the tar. */
const SAFE_HASH = /^[A-Za-z0-9_-]+$/
/** Identifier and channel become path components under Application Support. */
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** Electrobun's record of an update it has staged; present means "hands off". */
const PREPARED_UPDATE_RECORD = '.electrobun-prepared-update.json'

export type InstallerArchiveOutcome =
  | { state: 'removed'; path: string }
  | { state: 'absent' }
  | { state: 'skipped'; reason: string }

/**
 * Remove the installer's retained payload tar for the running build.
 *
 * `resourcesDir` is the running bundle's `Contents/Resources`;
 * `applicationSupportDir` is the user's `Library/Application Support`.
 */
export function retireInstallerArchive(options: {
  resourcesDir: string
  applicationSupportDir: string
}): InstallerArchiveOutcome {
  try {
    const versionFile = join(options.resourcesDir, 'version.json')
    // Not a packaged install (dev runs, tests): there is no installer archive.
    if (!existsSync(versionFile)) return { state: 'skipped', reason: 'not a packaged install' }

    const identity: unknown = JSON.parse(readFileSync(versionFile, 'utf8'))
    if (typeof identity !== 'object' || identity === null) {
      return { state: 'skipped', reason: 'unreadable version identity' }
    }
    const { identifier, channel, hash } = identity as Record<string, unknown>
    if (
      typeof identifier !== 'string' ||
      typeof channel !== 'string' ||
      typeof hash !== 'string' ||
      !SAFE_COMPONENT.test(identifier) ||
      !SAFE_COMPONENT.test(channel) ||
      !SAFE_HASH.test(hash)
    ) {
      return { state: 'skipped', reason: 'unsafe version identity' }
    }

    const extractionDir = join(
      options.applicationSupportDir,
      identifier,
      channel,
      'self-extraction'
    )
    if (existsSync(join(extractionDir, PREPARED_UPDATE_RECORD))) {
      return { state: 'skipped', reason: 'a prepared update record exists' }
    }

    const archive = join(extractionDir, `${hash}.tar`)
    let stat
    try {
      stat = lstatSync(archive)
    } catch {
      return { state: 'absent' }
    }
    if (!stat.isFile()) return { state: 'skipped', reason: 'not a regular file' }

    rmSync(archive, { force: true })
    return { state: 'removed', path: archive }
  } catch (error) {
    return {
      state: 'skipped',
      reason: error instanceof Error ? error.message : 'unexpected failure',
    }
  }
}
