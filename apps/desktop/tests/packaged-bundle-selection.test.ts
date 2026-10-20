import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEV_BUNDLE_NAME,
  DEV_BUNDLE_REJECTIONS,
  DEV_CHANNEL_DIRECTORY,
  packagedLaneExitCode,
  selectDevAppBundle,
} from '../shell/scripts/packaged-bundle-selection'
import { findAppBundle, findRunningAppBundle } from '../shell/scripts/packaged-install'

const laneScript = readFileSync(
  new URL('../../../scripts/test-dev-runtime-packaged.mjs', import.meta.url),
  'utf8'
)
const installScript = readFileSync(
  new URL('../shell/scripts/packaged-install.ts', import.meta.url),
  'utf8'
)

/**
 * A filesystem seam over a literal tree: `directories` maps a directory path to
 * the names of its sub-directories, and `present` names the paths that exist.
 * The decision is pure, so the tree is data, not a disk.
 */
function fakeFilesystem(tree: Record<string, readonly string[]>, present: readonly string[] = []) {
  const existing = new Set(present)
  return {
    exists: (path: string) => existing.has(path),
    listDirectory: (path: string) => tree[path] ?? [],
  }
}

/** The seams the lane itself uses, over the real filesystem. */
function realFilesystem() {
  return {
    exists: existsSync,
    listDirectory: (dir: string) => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      } catch {
        return []
      }
    },
  }
}

const BUILD_ROOT = '/repo/apps/desktop/shell/build'
const CHANNEL_PATH = join(BUILD_ROOT, DEV_CHANNEL_DIRECTORY)
const BUNDLE_PATH = join(CHANNEL_PATH, DEV_BUNDLE_NAME)

describe('the packaged lane selects only the supported development bundle', () => {
  test('selects the supported development candidate', () => {
    const filesystem = fakeFilesystem(
      { [BUILD_ROOT]: [DEV_CHANNEL_DIRECTORY], [CHANNEL_PATH]: [DEV_BUNDLE_NAME] },
      [BUNDLE_PATH]
    )

    const selection = selectDevAppBundle({
      buildRoot: BUILD_ROOT,
      exists: filesystem.exists,
      listDirectory: filesystem.listDirectory,
    })

    expect(selection).toEqual({ bundle: BUNDLE_PATH, reason: 'selected' })
  })

  test('rejects a stable-only build root and never picks the stable bundle', () => {
    const filesystem = fakeFilesystem(
      {
        [BUILD_ROOT]: ['stable-macos-arm64'],
        [join(BUILD_ROOT, 'stable-macos-arm64')]: ['Adea.app'],
      },
      [join(BUILD_ROOT, 'stable-macos-arm64', 'Adea.app')]
    )

    const selection = selectDevAppBundle({
      buildRoot: BUILD_ROOT,
      exists: filesystem.exists,
      listDirectory: filesystem.listDirectory,
    })

    expect(selection).toEqual({ bundle: null, reason: DEV_BUNDLE_REJECTIONS.stableOnly })
    expect(selection.bundle).toBeNull()
  })

  test('rejects a missing candidate', () => {
    const filesystem = fakeFilesystem({ [BUILD_ROOT]: [] })

    const selection = selectDevAppBundle({
      buildRoot: BUILD_ROOT,
      exists: filesystem.exists,
      listDirectory: filesystem.listDirectory,
    })

    expect(selection).toEqual({ bundle: null, reason: DEV_BUNDLE_REJECTIONS.missing })
  })

  test('rejects a build root that does not exist at all', () => {
    const filesystem = fakeFilesystem({})

    const selection = selectDevAppBundle({
      buildRoot: BUILD_ROOT,
      exists: filesystem.exists,
      listDirectory: filesystem.listDirectory,
    })

    expect(selection).toEqual({ bundle: null, reason: DEV_BUNDLE_REJECTIONS.missing })
  })

  test('rejects ambiguous candidates', () => {
    const filesystem = fakeFilesystem(
      {
        [BUILD_ROOT]: [DEV_CHANNEL_DIRECTORY],
        [CHANNEL_PATH]: [DEV_BUNDLE_NAME, 'Adea-dev-copy.app'],
      },
      [BUNDLE_PATH, join(CHANNEL_PATH, 'Adea-dev-copy.app')]
    )

    const selection = selectDevAppBundle({
      buildRoot: BUILD_ROOT,
      exists: filesystem.exists,
      listDirectory: filesystem.listDirectory,
    })

    expect(selection).toEqual({ bundle: null, reason: DEV_BUNDLE_REJECTIONS.ambiguous })
  })

  test('rejects a bundle built for another architecture', () => {
    const filesystem = fakeFilesystem(
      {
        [BUILD_ROOT]: ['dev-macos-x64'],
        [join(BUILD_ROOT, 'dev-macos-x64')]: [DEV_BUNDLE_NAME],
      },
      [join(BUILD_ROOT, 'dev-macos-x64', DEV_BUNDLE_NAME)]
    )

    const selection = selectDevAppBundle({
      buildRoot: BUILD_ROOT,
      exists: filesystem.exists,
      listDirectory: filesystem.listDirectory,
    })

    expect(selection).toEqual({ bundle: null, reason: DEV_BUNDLE_REJECTIONS.wrongArchitecture })
  })

  test('rejects a bundle with another name in the supported channel directory', () => {
    const filesystem = fakeFilesystem(
      { [BUILD_ROOT]: [DEV_CHANNEL_DIRECTORY], [CHANNEL_PATH]: ['Adea.app'] },
      [join(CHANNEL_PATH, 'Adea.app')]
    )

    const selection = selectDevAppBundle({
      buildRoot: BUILD_ROOT,
      exists: filesystem.exists,
      listDirectory: filesystem.listDirectory,
    })

    expect(selection).toEqual({ bundle: null, reason: DEV_BUNDLE_REJECTIONS.wrongLayout })
  })

  test('rejects a channel directory that holds no bundle at all', () => {
    const filesystem = fakeFilesystem({ [BUILD_ROOT]: [DEV_CHANNEL_DIRECTORY], [CHANNEL_PATH]: [] })

    const selection = selectDevAppBundle({
      buildRoot: BUILD_ROOT,
      exists: filesystem.exists,
      listDirectory: filesystem.listDirectory,
    })

    expect(selection).toEqual({ bundle: null, reason: DEV_BUNDLE_REJECTIONS.missing })
  })

  test('rejects a candidate that the filesystem does not actually hold', () => {
    const filesystem = fakeFilesystem({
      [BUILD_ROOT]: [DEV_CHANNEL_DIRECTORY],
      [CHANNEL_PATH]: [DEV_BUNDLE_NAME],
    })

    const selection = selectDevAppBundle({
      buildRoot: BUILD_ROOT,
      exists: filesystem.exists,
      listDirectory: filesystem.listDirectory,
    })

    expect(selection).toEqual({ bundle: null, reason: DEV_BUNDLE_REJECTIONS.missing })
  })
})

describe('the packaged lane reads the real build root the same way', () => {
  test('selects the real development bundle and rejects a real stable-only root', () => {
    const root = mkdtempSync(join(tmpdir(), 'packaged-selection-'))
    try {
      const channel = join(root, DEV_CHANNEL_DIRECTORY)
      mkdirSync(channel, { recursive: true })
      mkdirSync(join(channel, DEV_BUNDLE_NAME), { recursive: true })
      const filesystem = realFilesystem()

      expect(
        selectDevAppBundle({
          buildRoot: root,
          exists: filesystem.exists,
          listDirectory: filesystem.listDirectory,
        })
      ).toEqual({ bundle: join(channel, DEV_BUNDLE_NAME), reason: 'selected' })

      // The same root with only a stable bundle beside it still resolves the
      // development bundle; a stable-only root resolves nothing.
      const stable = join(root, 'stable-macos-arm64')
      mkdirSync(stable, { recursive: true })
      mkdirSync(join(stable, 'Adea.app'), { recursive: true })
      expect(
        selectDevAppBundle({
          buildRoot: root,
          exists: filesystem.exists,
          listDirectory: filesystem.listDirectory,
        }).bundle
      ).toBe(join(channel, DEV_BUNDLE_NAME))

      const stableOnly = mkdtempSync(join(tmpdir(), 'packaged-selection-stable-'))
      try {
        const stableChannel = join(stableOnly, 'stable-macos-arm64')
        mkdirSync(stableChannel, { recursive: true })
        mkdirSync(join(stableChannel, 'Adea.app'), { recursive: true })
        expect(
          selectDevAppBundle({
            buildRoot: stableOnly,
            exists: filesystem.exists,
            listDirectory: filesystem.listDirectory,
          })
        ).toEqual({ bundle: null, reason: DEV_BUNDLE_REJECTIONS.stableOnly })
      } finally {
        rmSync(stableOnly, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the packaged lane is bound to the fail-closed decisions', () => {
  test('the lane script selects through the helper and exits through it', () => {
    // The decisions only bind the lane if the lane USES them.
    expect(laneScript).toContain(
      "from '../apps/desktop/shell/scripts/packaged-bundle-selection.ts'"
    )
    expect(laneScript).toContain('selectDevAppBundle(')
    expect(laneScript).toContain('packagedLaneExitCode(')
    // The recursive "any .app" fallback is gone, so a stable-only or
    // wrong-architecture bundle can never be selected by accident.
    expect(laneScript).not.toContain('findAppBundle')
    expect(laneScript).not.toContain(".endsWith('.app')")
    // The failure path exits with the computed code, not with the build's own
    // status, which is 0 for a successful build that produced no bundle. The
    // exit goes through the lane's injected seam, whose default IS the real
    // process exit.
    expect(laneScript).not.toContain('process.exit(build.status ?? 1)')
    expect(laneScript).toContain('exit = process.exit')
    expect(laneScript).toContain('exit(exitCode)')
  })

  test('the install helper selects through the same shared helper', () => {
    // Both callers share ONE fail-closed selector, so neither can drift back
    // to a recursive "any .app" fallback.
    expect(installScript).toContain("from './packaged-bundle-selection'")
    expect(installScript).toContain('selectDevAppBundle(')
    // The build-root selection itself holds no ".app" fallback of its own.
    const selection = installScript.slice(
      installScript.indexOf('export function findAppBundle('),
      installScript.indexOf('export type PackagedIdentity')
    )
    expect(selection).toContain('selectDevAppBundle(')
    expect(selection).not.toContain(".endsWith('.app')")
    expect(selection).not.toContain('depth')
    // The running-bundle lookup is a DIFFERENT contract (it walks up from an
    // entry directory to the .app that is running) and must not be routed
    // through the build-root selector.
    expect(installScript).toContain('export function findRunningAppBundle(')
    const runningLookup = installScript.slice(
      installScript.indexOf('export function findRunningAppBundle(')
    )
    expect(runningLookup).not.toContain('selectDevAppBundle(')
  })
})

describe('the install helper selects only the supported development bundle', () => {
  /** A build root with the given channel/bundle layout, over the real filesystem. */
  function stageBuildRoot(layout: ReadonlyArray<readonly [string, string]>) {
    const root = mkdtempSync(join(tmpdir(), 'packaged-install-selection-'))
    for (const [channel, bundle] of layout) {
      mkdirSync(join(root, channel, bundle), { recursive: true })
    }
    return root
  }

  test('selects the supported development candidate', () => {
    const root = stageBuildRoot([[DEV_CHANNEL_DIRECTORY, DEV_BUNDLE_NAME]])
    try {
      expect(findAppBundle(root)).toBe(join(root, DEV_CHANNEL_DIRECTORY, DEV_BUNDLE_NAME))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects a stable-only build root', () => {
    const root = stageBuildRoot([['stable-macos-arm64', 'Adea.app']])
    try {
      expect(findAppBundle(root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects a missing build root', () => {
    const root = mkdtempSync(join(tmpdir(), 'packaged-install-missing-'))
    try {
      expect(findAppBundle(root)).toBeNull()
      expect(findAppBundle(join(root, 'absent'))).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects ambiguous candidates', () => {
    const root = stageBuildRoot([
      [DEV_CHANNEL_DIRECTORY, DEV_BUNDLE_NAME],
      [DEV_CHANNEL_DIRECTORY, 'Adea-dev-copy.app'],
    ])
    try {
      expect(findAppBundle(root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects a bundle built for another architecture', () => {
    const root = stageBuildRoot([['dev-macos-x64', DEV_BUNDLE_NAME]])
    try {
      expect(findAppBundle(root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects a bundle with another name in the supported channel directory', () => {
    const root = stageBuildRoot([[DEV_CHANNEL_DIRECTORY, 'Adea.app']])
    try {
      expect(findAppBundle(root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the running-bundle lookup is a different contract and is untouched', () => {
    // findRunningAppBundle walks UP from an entry directory to the .app that is
    // running; it is not a build-root selection and must keep its own rule.
    const root = mkdtempSync(join(tmpdir(), 'packaged-install-running-'))
    try {
      const bundle = join(root, 'Adea.app')
      mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
      writeFileSync(join(bundle, 'Contents', 'MacOS', 'bun'), 'stub')
      const entry = join(bundle, 'Contents', 'Resources', 'app')
      mkdirSync(entry, { recursive: true })
      expect(findRunningAppBundle(entry)).toBe(bundle)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the packaged lane exit code fails closed', () => {
  test('a successful build with no usable bundle exits nonzero', () => {
    expect(packagedLaneExitCode({ buildStatus: 0, bundle: null })).not.toBe(0)
    expect(packagedLaneExitCode({ buildStatus: 0, bundle: null })).toBe(1)
  })

  test('a failed build keeps its own status', () => {
    expect(packagedLaneExitCode({ buildStatus: 2, bundle: null })).toBe(2)
    expect(packagedLaneExitCode({ buildStatus: 127, bundle: null })).toBe(127)
  })

  test('a build killed by a signal exits nonzero', () => {
    expect(packagedLaneExitCode({ buildStatus: null, bundle: null })).toBe(1)
  })

  test('a successful build with a usable bundle exits zero', () => {
    expect(packagedLaneExitCode({ buildStatus: 0, bundle: BUNDLE_PATH })).toBe(0)
  })
})
