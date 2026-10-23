/*
 * The packaged lane wrapper's failure path, executed.
 *
 * #1507 made the lane's bundle selection fail closed: only the pinned
 * development target qualifies. This covers the EXECUTABLE consequence, which
 * the selection tests do not: when the build succeeds but the dev bundle is
 * missing or the selector rejects it, the lane must write the failed lane
 * summary, exit nonzero, and launch ZERO packaged-proof subprocesses.
 *
 * Every side effect is injected — the subprocess spawns, the filesystem the
 * selection reads, the summary writer and the exit — so the lane runs
 * deterministically with no build, no bundle and no app. The build command, the
 * fail-closed selection and the proof set are NOT injectable: the lane always
 * runs the real build and always proves against the real bundle.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runPackagedLane } from './test-dev-runtime-packaged.mjs'

/** The signal the lane's exit seam raises, so the exit code is observable. */
class LaneExit extends Error {
  code: number
  constructor(code: number) {
    super(`the packaged lane exited with ${code}`)
    this.name = 'LaneExit'
    this.code = code
  }
}

type SpawnCall = { args: string[]; command: string }

/** A recorded lane run: the spawns, the summaries and the exit. */
function runLane(options: {
  buildStatus?: number | null
  buildRootEntries?: Record<string, string[]>
  present?: readonly string[]
  proofStatus?: number | null
}) {
  const spawns: SpawnCall[] = []
  const summaries: Array<{ lane: string; summary: Record<string, unknown> }> = []
  let exitCode: number | undefined
  const buildStatus = options.buildStatus === undefined ? 0 : options.buildStatus
  const present = new Set(options.present ?? [])
  const tree = options.buildRootEntries ?? {}

  const exit = (code: number) => {
    exitCode = code
    throw new LaneExit(code)
  }

  const promise = runPackagedLane({
    buildRoot: '/repo/apps/desktop/shell/build',
    exists: (path: string) => present.has(path),
    exit,
    listDirectory: (dir: string) => tree[dir] ?? [],
    spawn: (command: string, args: string[]) => {
      spawns.push({ command, args })
      // The first spawn is the build; every later spawn is a packaged proof.
      const isBuild = args.includes('shell:build')
      return { status: isBuild ? buildStatus : (options.proofStatus ?? 0), signal: null }
    },
    writeSummary: async (lane: string, summary: Record<string, unknown>) => {
      summaries.push({ lane, summary })
    },
  })

  return {
    spawns,
    summaries,
    get exitCode() {
      return exitCode
    },
    async settled() {
      // The lane exits through the injected seam, which raises; that IS the
      // lane's normal end of run on the failure path.
      await promise.catch((error: unknown) => {
        if (!(error instanceof LaneExit)) throw error
      })
    },
  }
}

const BUILD_ROOT = '/repo/apps/desktop/shell/build'
const CHANNEL = `${BUILD_ROOT}/dev-macos-arm64`
const BUNDLE = `${CHANNEL}/Adea-dev.app`

describe('the packaged lane fails closed when the dev bundle is unusable', () => {
  test('a successful build with a missing bundle writes the failed summary and exits nonzero', async () => {
    const lane = runLane({
      buildStatus: 0,
      // The channel directory exists but holds no bundle.
      buildRootEntries: { [BUILD_ROOT]: ['dev-macos-arm64'], [CHANNEL]: [] },
    })

    await lane.settled()

    expect(lane.summaries).toHaveLength(1)
    const [record] = lane.summaries
    expect(record?.lane).toBe('packaged')
    const summary = record?.summary as {
      status: string
      details: { exitCode: number; bundle: string | null; error: string }
    }
    expect(summary.status).toBe('failed')
    expect(summary.details.exitCode).not.toBe(0)
    expect(summary.details.bundle).toBeNull()
    expect(summary.details.error).toContain('did not produce a usable dev app bundle')
    expect(lane.exitCode).toBe(summary.details.exitCode)
    expect(lane.exitCode).not.toBe(0)
  })

  test('a successful build the selector rejects writes the failed summary and exits nonzero', async () => {
    const lane = runLane({
      buildStatus: 0,
      // A stable-only build root: the selector rejects it by name.
      buildRootEntries: { [BUILD_ROOT]: ['stable-macos-arm64'] },
    })

    await lane.settled()

    expect(lane.summaries).toHaveLength(1)
    const summary = lane.summaries[0]?.summary as {
      status: string
      details: { exitCode: number; bundle: string | null; error: string }
    }
    expect(summary.status).toBe('failed')
    expect(summary.details.exitCode).not.toBe(0)
    expect(summary.details.bundle).toBeNull()
    expect(summary.details.error).toContain('stable-only')
    expect(lane.exitCode).not.toBe(0)
  })

  test('no packaged proof is launched when the bundle is unusable', async () => {
    const lane = runLane({
      buildStatus: 0,
      buildRootEntries: { [BUILD_ROOT]: ['dev-macos-arm64'], [CHANNEL]: [] },
    })

    await lane.settled()

    // The only subprocess is the build itself: no packaged proof ran.
    expect(lane.spawns).toHaveLength(1)
    expect(lane.spawns[0]?.args).toContain('shell:build')
    for (const spawn of lane.spawns) {
      expect(spawn.args).not.toContain('supervision-smoke.ts')
      expect(spawn.args).not.toContain('packaged-terminal-smoke.ts')
      expect(spawn.args).not.toContain('packaged-browser-matrix.ts')
      expect(spawn.args).not.toContain('packaged-worktree-smoke.ts')
    }
  })

  test('a failed build keeps the build status and launches no proof', async () => {
    const lane = runLane({ buildStatus: 2 })

    await lane.settled()

    expect(lane.summaries).toHaveLength(1)
    const summary = lane.summaries[0]?.summary as {
      status: string
      details: { exitCode: number; error: string }
    }
    expect(summary.status).toBe('failed')
    expect(summary.details.exitCode).toBe(2)
    expect(summary.details.error).toBe('the Electrobun build failed')
    expect(lane.exitCode).toBe(2)
    expect(lane.spawns).toHaveLength(1)
  })
})

describe('the packaged lane still launches its proofs when the bundle is usable', () => {
  test('the real filesystem selection accepts bundle directories and ignores app-shaped files', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-packaged-selection-'))
    const channel = join(directory, 'dev-macos-arm64')
    const bundle = join(channel, 'Adea-dev.app')
    const spawns: string[][] = []
    const summaries: Array<{ status: string }> = []
    try {
      mkdirSync(bundle, { recursive: true })
      writeFileSync(join(channel, 'Decoy.app'), 'not a bundle directory')
      await runPackagedLane({
        buildRoot: directory,
        spawn: (_command: string, args: string[]) => {
          spawns.push(args)
          return { status: 0, signal: null }
        },
        writeSummary: async (_lane: string, summary: { status: string }) => {
          summaries.push(summary)
        },
        exit: (code: number) => {
          expect(code).toBe(0)
        },
      })
      expect(summaries.at(-1)?.status).toBe('passed')
      expect(spawns).toHaveLength(6)
      for (const args of spawns.slice(1)) {
        expect(args).toContain(bundle)
        expect(args).not.toContain(join(channel, 'Decoy.app'))
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a usable bundle launches every proof and exits zero', async () => {
    const lane = runLane({
      buildStatus: 0,
      buildRootEntries: { [BUILD_ROOT]: ['dev-macos-arm64'], [CHANNEL]: ['Adea-dev.app'] },
      present: [BUNDLE],
    })

    await lane.settled()

    // The control: with a usable bundle the proofs DO run, so the zero-proof
    // assertion above is measuring a live path, not a dead one.
    expect(lane.spawns.length).toBeGreaterThan(1)
    const proofSpawns = lane.spawns.slice(1)
    expect(proofSpawns.map((spawn) => spawn.args[0]?.split('/').pop())).toEqual([
      'supervision-smoke.ts',
      'packaged-terminal-smoke.ts',
      'packaged-transport-defect-probe.ts',
      'packaged-worktree-smoke.ts',
      'packaged-browser-matrix.ts',
    ])
    const summary = lane.summaries.at(-1)?.summary as { status: string }
    expect(summary.status).toBe('passed')
    expect(lane.exitCode).toBe(0)
  })
})
