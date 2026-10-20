/*
 * The Dev Runtime lane report writer, exercised directly.
 *
 * The packaged lane wrapper imports this module, but the wrapper's own tests inject
 * the summary writer, so the module's report-writing behaviour was never executed by
 * a test: the file sat at 0% functions and 14.81% lines under the repository's
 * unchanged per-file 80% gate.
 *
 * These tests run the real writer and assert what it actually leaves behind — the
 * summary file and its contents, the stamped copy, the directory it chose, and the
 * breadcrumbs it prints. Nothing is mocked: the file the lane claims to leave is
 * the file these tests read.
 *
 * The reports are written into a disposable lane directory under the repository's
 * git-ignored artifacts tree, and each test removes its own directory.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, readFileSync, rmdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { writeLaneSummary } from './dev-runtime-lane-report.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const written: string[] = []

/** A disposable lane directory under the git-ignored artifacts tree. */
function disposableDir(label: string): string {
  const dir = `artifacts/dev-runtime-report-test-${label}-${crypto.randomUUID()}`
  written.push(dir)
  return dir
}

/** The JSON a lane summary file holds. */
function readSummary(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

afterEach(() => {
  for (const dir of written.splice(0)) {
    rmSync(join(root, dir), { recursive: true, force: true })
  }
  // The disposable directories are the only thing this lane creates here, so the
  // git-ignored artifacts parent is removed again when it is left empty.
  try {
    rmdirSync(join(root, 'artifacts'))
  } catch {
    // Another lane's artifacts are present; they stay.
  }
})

describe('the dev-runtime lane report writer', () => {
  test('writes the summary where the lane says it does', async () => {
    const dir = disposableDir('write')
    const startedAt = new Date('2026-10-20T01:02:03.000Z')
    const log = spyOn(console, 'log').mockImplementation(() => {})

    const summaryPath = await writeLaneSummary('packaged', {
      command: 'bun run test:packaged',
      status: 'failed',
      startedAt,
      dir,
      details: { exitCode: 1, bundle: null },
    })

    log.mockRestore()
    expect(summaryPath).toBe(join(root, dir, 'packaged-summary.json'))
    expect(existsSync(summaryPath)).toBe(true)
    const summary = readSummary(summaryPath)
    expect(summary.lane).toBe('packaged')
    expect(summary.command).toBe('bun run test:packaged')
    expect(summary.status).toBe('failed')
    expect(summary.startedAt).toBe('2026-10-20T01:02:03.000Z')
    expect(typeof summary.finishedAt).toBe('string')
    expect(summary.durationMs).toBeGreaterThanOrEqual(0)
    expect(summary.details).toEqual({ exitCode: 1, bundle: null })
  })

  test('prints the artifact breadcrumb the lane reports', async () => {
    const dir = disposableDir('breadcrumb')
    const log = spyOn(console, 'log').mockImplementation(() => {})

    await writeLaneSummary('packaged', {
      command: 'bun run test:packaged',
      status: 'passed',
      startedAt: new Date(),
      dir,
    })

    const printed = log.mock.calls.map((call) => String(call[0])).join('\n')
    log.mockRestore()
    expect(printed).toContain('packaged lane passed')
    expect(printed).toContain(`summary artifact: ${dir}/packaged-summary.json`)
  })

  test('a stamp preserves the run under its own name', async () => {
    const dir = disposableDir('stamp')
    const log = spyOn(console, 'log').mockImplementation(() => {})

    const summaryPath = await writeLaneSummary('packaged', {
      command: 'bun run test:packaged',
      status: 'passed',
      startedAt: new Date(),
      dir,
      stamp: '20261020T010203',
    })

    const printed = log.mock.calls.map((call) => String(call[0])).join('\n')
    log.mockRestore()
    const stampedPath = join(root, dir, 'packaged-summary-20261020T010203.json')
    expect(existsSync(stampedPath)).toBe(true)
    expect(readSummary(stampedPath)).toEqual(readSummary(summaryPath))
    expect(printed).toContain('packaged lane stamped artifact:')
    expect(printed).toContain('packaged-summary-20261020T010203.json')
  })

  test('a later run overwrites the live summary while the stamped copy survives', async () => {
    // The #1037 behaviour: the live path is rewritten by every run, so a long
    // acceptance record is preserved under its own stamp.
    const dir = disposableDir('overwrite')
    const log = spyOn(console, 'log').mockImplementation(() => {})

    await writeLaneSummary('packaged', {
      command: 'bun run test:packaged',
      status: 'passed',
      startedAt: new Date(),
      dir,
      stamp: 'first',
      details: { run: 'first' },
    })
    await writeLaneSummary('packaged', {
      command: 'bun run test:packaged',
      status: 'failed',
      startedAt: new Date(),
      dir,
      details: { run: 'second' },
    })

    log.mockRestore()
    const live = readSummary(join(root, dir, 'packaged-summary.json'))
    const stamped = readSummary(join(root, dir, 'packaged-summary-first.json'))
    expect((live.details as { run: string }).run).toBe('second')
    expect(live.status).toBe('failed')
    expect((stamped.details as { run: string }).run).toBe('first')
    expect(stamped.status).toBe('passed')
  })

  test('the report can be pointed at another lane family', async () => {
    const dir = disposableDir('family')
    const log = spyOn(console, 'log').mockImplementation(() => {})

    const summaryPath = await writeLaneSummary('perf', {
      command: 'bun run test:performance:dev-runtime',
      status: 'passed',
      startedAt: new Date(),
      dir,
    })

    log.mockRestore()
    expect(summaryPath).toBe(join(root, dir, 'perf-summary.json'))
    expect(existsSync(summaryPath)).toBe(true)
    expect(readSummary(summaryPath).lane).toBe('perf')
  })

  test('a report with no details records an empty details object', async () => {
    const dir = disposableDir('details')
    const log = spyOn(console, 'log').mockImplementation(() => {})

    const summaryPath = await writeLaneSummary('packaged', {
      command: 'bun run test:packaged',
      status: 'passed',
      startedAt: new Date(),
      dir,
    })

    log.mockRestore()
    expect(readSummary(summaryPath).details).toEqual({})
  })

  test('a report never records a negative duration', async () => {
    // A clock that runs backwards (or a startedAt in the future) must not produce a
    // negative duration.
    const dir = disposableDir('duration')
    const log = spyOn(console, 'log').mockImplementation(() => {})

    const summaryPath = await writeLaneSummary('packaged', {
      command: 'bun run test:packaged',
      status: 'passed',
      startedAt: new Date(Date.now() + 60_000),
      dir,
    })

    log.mockRestore()
    expect(readSummary(summaryPath).durationMs).toBe(0)
  })

  test('the report directory is created when it does not exist', async () => {
    const dir = disposableDir('mkdir')
    const log = spyOn(console, 'log').mockImplementation(() => {})

    expect(existsSync(join(root, dir))).toBe(false)
    const summaryPath = await writeLaneSummary('packaged', {
      command: 'bun run test:packaged',
      status: 'passed',
      startedAt: new Date(),
      dir,
    })

    log.mockRestore()
    expect(existsSync(join(root, dir))).toBe(true)
    expect(existsSync(summaryPath)).toBe(true)
  })
})
