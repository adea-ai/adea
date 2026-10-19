import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEV_BUNDLE_NAME,
  DEV_BUNDLE_REJECTIONS,
  DEV_CHANNEL_DIRECTORY,
  packagedLaneExitCode,
  selectDevAppBundle,
} from './packaged-bundle-selection.mjs'

const laneScript = readFileSync(new URL('./test-dev-runtime-packaged.mjs', import.meta.url), 'utf8')

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
    expect(laneScript).toContain("from './packaged-bundle-selection.mjs'")
    expect(laneScript).toContain('selectDevAppBundle(')
    expect(laneScript).toContain('packagedLaneExitCode(')
    // The recursive "any .app" fallback is gone, so a stable-only or
    // wrong-architecture bundle can never be selected by accident.
    expect(laneScript).not.toContain('findAppBundle')
    expect(laneScript).not.toContain(".endsWith('.app')")
    // The failure path exits with the computed code, not with the build's own
    // status, which is 0 for a successful build that produced no bundle.
    expect(laneScript).not.toContain('process.exit(build.status ?? 1)')
    expect(laneScript).toContain('process.exit(exitCode)')
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
