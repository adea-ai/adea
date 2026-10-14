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
// - best effort: nothing here can throw or block a boot.
//
// Deletion safety. A path check followed by `unlink(path)` is not safe: any
// directory above the file may be a symlink (or be swapped for one between the
// check and the delete), which would delete a matching file outside the
// install. So the path is never handed to the kernel as a whole. The trusted
// root (`Application Support`) is opened once; every directory below it is
// opened with `openat(…, O_NOFOLLOW | O_DIRECTORY)` relative to the descriptor
// already held, so a symlink at any level refuses to open, and the file is
// removed with `unlinkat(dirfd, name)` on the descriptor of the directory that
// was verified. Replacing a path component afterwards cannot redirect the
// delete; the kernel resolves the name inside the directory we are holding,
// and `unlinkat` never follows a final symlink. If the native calls are not
// available the archive is simply left in place.
//
// Boot safety. Every open here is `O_NONBLOCK`: opening a named pipe at the
// archive or prepared-update filename for reading would otherwise block until
// a writer appears, hanging startup indefinitely. A non-blocking open returns
// at once, and anything that is not a regular file is skipped.
import { dlopen, FFIType, read } from 'bun:ffi'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
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

/** `ENOENT` is 2 on both Linux and macOS. */
const ENOENT = 2

/** What a descriptor-relative lookup of one name proved. */
export type EntryProbe = 'present' | 'absent' | 'unknown'

/** Descriptor-relative file operations; the seam the race tests use. */
export interface DescriptorOps {
  /** `openat`; returns a descriptor or -1. */
  openAt(dirFd: number, name: string, flags: number): number
  /** `unlinkat(dirFd, name, 0)`; returns 0 or -1. */
  unlinkAt(dirFd: number, name: string): number
  /**
   * Whether `name` exists in the directory, without following a final symlink
   * (a dangling symlink is `present`). `absent` only when the kernel positively
   * reported "no such entry"; any other failure is `unknown`, never `absent`.
   */
  probe(dirFd: number, name: string): EntryProbe
}

let nativeOps: DescriptorOps | null | undefined

const cstring = (value: string) => Buffer.from(`${value}\0`)

/** `AT_SYMLINK_NOFOLLOW` differs between macOS and Linux. */
const AT_SYMLINK_NOFOLLOW = process.platform === 'darwin' ? 0x20 : 0x100
const F_OK = 0

/** libc `openat`/`unlinkat`/`faccessat` through Bun's FFI, or null when unavailable. */
export function loadNativeOps(): DescriptorOps | null {
  if (nativeOps !== undefined) return nativeOps
  try {
    const library = dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
      openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      faccessat: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      [process.platform === 'darwin' ? '__error' : '__errno_location']: {
        args: [],
        returns: FFIType.ptr,
      },
    })
    const symbols = library.symbols as Record<string, (...args: never[]) => unknown>
    const errnoLocation = symbols[
      process.platform === 'darwin' ? '__error' : '__errno_location'
    ] as () => number | null
    const errno = (): number | undefined => {
      const location = errnoLocation()
      return location ? read.i32(location) : undefined
    }
    const openAt = (dirFd: number, name: string, flags: number) =>
      library.symbols.openat(dirFd, cstring(name), flags)
    nativeOps = {
      openAt,
      unlinkAt: (dirFd, name) => library.symbols.unlinkat(dirFd, cstring(name), 0),
      probe: (dirFd, name) => {
        // Two independent lookups must both report "no such entry". Either one
        // succeeding, or failing for any other reason (a symlink loop, a
        // permission error, an unsupported flag), is not proof of absence.
        const access = library.symbols.faccessat(dirFd, cstring(name), F_OK, AT_SYMLINK_NOFOLLOW)
        if (access === 0) return 'present'
        const accessErrno = errno()
        const open = openAt(
          dirFd,
          name,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
        )
        if (open >= 0) {
          closeSync(open)
          return 'present'
        }
        const openErrno = errno()
        return accessErrno === ENOENT && openErrno === ENOENT ? 'absent' : 'unknown'
      },
    }
  } catch {
    nativeOps = null
  }
  return nativeOps
}

/** Test seams; production callers pass only the two directories. */
export interface RetireInstallerArchiveOptions {
  /** The running bundle's `Contents/Resources`. */
  resourcesDir: string
  /** The user's `Library/Application Support` (the one trusted root). */
  applicationSupportDir: string
  ops?: DescriptorOps | null
  /** Runs once the directory chain is verified, before the prepared-record check. */
  afterDirectoryVerified?: () => void
  /** Runs immediately before unlinking. */
  beforeUnlink?: () => void
}

/**
 * Remove the installer's retained payload tar for the running build.
 */
export function retireInstallerArchive(
  options: RetireInstallerArchiveOptions
): InstallerArchiveOutcome {
  const held: number[] = []
  try {
    const versionFile = join(options.resourcesDir, 'version.json')
    let raw: string
    try {
      raw = readFileSync(versionFile, 'utf8')
    } catch {
      // Not a packaged install (dev runs, tests): there is no installer archive.
      return { state: 'skipped', reason: 'not a packaged install' }
    }
    const identity: unknown = JSON.parse(raw)
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

    const ops = options.ops === undefined ? loadNativeOps() : options.ops
    const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants
    if (!ops || O_DIRECTORY === undefined || O_NOFOLLOW === undefined || O_NONBLOCK === undefined) {
      return { state: 'skipped', reason: 'descriptor-relative file operations are unavailable' }
    }

    // The root is trusted (it may itself be reached through a user symlink);
    // everything below it must be a real directory, opened without following.
    const chain = [identifier, channel, 'self-extraction']
    let dirFd = openSync(options.applicationSupportDir, O_RDONLY | O_DIRECTORY | O_NONBLOCK)
    held.push(dirFd)
    let walked = options.applicationSupportDir
    for (const name of chain) {
      walked = join(walked, name)
      const next = ops.openAt(dirFd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK)
      if (next < 0) {
        return { state: 'skipped', reason: 'install directory is missing or not a real directory' }
      }
      held.push(next)
      dirFd = next
    }

    options.afterDirectoryVerified?.()

    // A prepared-update record, of any kind (even a dangling symlink or a pipe),
    // means hands off. Looked up in the directory we hold, never by pathname,
    // and only a positive "no such entry" lets the removal go ahead.
    if (ops.probe(dirFd, PREPARED_UPDATE_RECORD) !== 'absent') {
      return { state: 'skipped', reason: 'a prepared update record exists or cannot be ruled out' }
    }

    const name = `${hash}.tar`
    const fileFd = ops.openAt(dirFd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    if (fileFd < 0) {
      switch (ops.probe(dirFd, name)) {
        case 'absent':
          return { state: 'absent' }
        case 'present':
          return { state: 'skipped', reason: 'not a regular file' }
        default:
          return { state: 'skipped', reason: 'the archive could not be inspected' }
      }
    }
    held.push(fileFd)
    if (!fstatSync(fileFd).isFile()) return { state: 'skipped', reason: 'not a regular file' }

    options.beforeUnlink?.()
    if (ops.unlinkAt(dirFd, name) !== 0)
      return { state: 'skipped', reason: 'could not remove the archive' }
    return { state: 'removed', path: join(walked, name) }
  } catch (error) {
    return {
      state: 'skipped',
      reason: error instanceof Error ? error.message : 'unexpected failure',
    }
  } finally {
    for (const fd of held) {
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
    }
  }
}
