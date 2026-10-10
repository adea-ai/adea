import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CLIENT_BUNDLE_BUDGETS } from './client-bundle-budgets.mjs'
import {
  INVENTORY_PATH,
  MEASUREMENTS_PATH,
  bundleBudget,
  evaluateBundle,
  inventoryErrors,
  probeFiles,
  summarizeAxe,
} from './readiness-evidence.mjs'

const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'))
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const existsAll = () => true

function git(cwd: string, args: string[]) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=f', '-c', 'user.email=f@example.invalid', ...args],
    { cwd, encoding: 'utf8' }
  )
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function commit(cwd: string, files: Record<string, string>, message: string) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), content)
  }
  git(cwd, ['add', '-A'])
  git(cwd, ['commit', '-q', '-m', message])
  return git(cwd, ['rev-parse', 'HEAD'])
}

function bundleReport(overrides: Record<string, number> = {}) {
  const total = CLIENT_BUNDLE_BUDGETS.total
  const startup = CLIENT_BUNDLE_BUDGETS.startup
  const chat = CLIENT_BUNDLE_BUDGETS.views.chat
  return {
    clientJavaScriptBytes: total.rawBytes,
    clientJavaScriptGzipBytes: total.gzipBytes,
    clientJavaScriptFiles: total.fileCount,
    startup: { rawBytes: startup.rawBytes, gzipBytes: startup.gzipBytes, fileCount: 1 },
    views: { chat: { rawBytes: chat.rawBytes, gzipBytes: chat.gzipBytes, fileCount: 1 } },
    ...overrides,
  }
}

describe('readiness inventory', () => {
  test('the committed inventory is valid and names every criterion once', () => {
    expect(inventoryErrors(inventory)).toEqual([])
    const ids = inventory.criteria.map((criterion: { id: string }) => criterion.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeGreaterThan(30)
  })

  test('validation refuses duplicate ids, mismatched categories and gaps without a reason', () => {
    const duplicate = clone(inventory)
    duplicate.criteria.push(clone(duplicate.criteria[0]))
    expect(inventoryErrors(duplicate).join('\n')).toContain('duplicate id')

    const mismatched = clone(inventory)
    mismatched.criteria[0].category = 'cost'
    expect(inventoryErrors(mismatched).join('\n')).toContain('category must match its id prefix')

    const unexplained = clone(inventory)
    const gap = unexplained.criteria.find(
      (criterion: { method: { kind: string } }) => criterion.method.kind === 'unavailable'
    )
    delete gap.method.reason
    expect(inventoryErrors(unexplained).join('\n')).toContain('unavailable needs a reason')
  })

  test('validation refuses unknown probes, bundle keys, unit files and method kinds', () => {
    const broken = clone(inventory)
    broken.criteria[0].method = { kind: 'presence', probes: ['no-such-probe'] }
    broken.criteria[1].method = { kind: 'bundle', keys: ['views.no-such-route'] }
    broken.criteria[2].method = { kind: 'certified', reason: 'x' }
    const errors = inventoryErrors(broken).join('\n')
    expect(errors).toContain('unknown probe no-such-probe')
    expect(errors).toContain('unknown bundle key views.no-such-route')
    expect(errors).toContain('unknown method kind certified')

    const missingFile = inventoryErrors(inventory, { fileExists: () => false }).join('\n')
    expect(missingFile).toContain('does not exist')
    expect(inventoryErrors(inventory, { fileExists: existsAll })).toEqual([])
  })

  test('the committed measurements carry the same inventory hash and never certify a gap', () => {
    const measurements = JSON.parse(readFileSync(MEASUREMENTS_PATH, 'utf8'))
    const hash = createHash('sha256').update(readFileSync(INVENTORY_PATH)).digest('hex')
    expect(measurements.inventorySha256).toBe(hash)
    expect(measurements.results.map((entry: { id: string }) => entry.id)).toEqual(
      inventory.criteria.map((criterion: { id: string }) => criterion.id)
    )
    for (const entry of measurements.results) {
      if (['not-measured', 'unavailable', 'not-claimed'].includes(entry.kind)) {
        expect(entry.status).toBe(entry.kind)
        expect(entry.status).not.toBe('pass')
      }
    }
    expect(JSON.stringify(measurements)).not.toContain('"certified"')
  })
})

describe('bundle budgets', () => {
  test('bundle keys resolve to the ceilings in the client budget module', () => {
    expect(bundleBudget('total')).toBe(CLIENT_BUNDLE_BUDGETS.total)
    expect(bundleBudget('startup')).toBe(CLIENT_BUNDLE_BUDGETS.startup)
    expect(bundleBudget('views.chat')).toBe(CLIENT_BUNDLE_BUDGETS.views.chat)
    expect(bundleBudget('views.missing')).toBeUndefined()
  })

  test('a report at the ceiling passes and one raw byte over fails with that check named', () => {
    const atLimit = evaluateBundle(bundleReport(), ['total', 'startup', 'views.chat'])
    expect(atLimit.map((entry) => entry.status)).toEqual(['pass', 'pass', 'pass'])
    expect(atLimit[0].headroom.rawBytes).toBe(0)

    const over = evaluateBundle(
      bundleReport({ clientJavaScriptBytes: CLIENT_BUNDLE_BUDGETS.total.rawBytes + 1 }),
      ['total']
    )
    expect(over[0].status).toBe('fail')
    expect(over[0].failing).toEqual(['rawBytes'])
  })
})

describe('axe summary', () => {
  test('fails only on serious or critical findings, and reports not-run without surfaces', () => {
    expect(
      summarizeAxe({ surfaces: [{ surface: 'chat', counts: { minor: 3, moderate: 2 } }] }).status
    ).toBe('pass')
    expect(summarizeAxe({ surfaces: [{ surface: 'chat', counts: { serious: 1 } }] }).status).toBe(
      'fail'
    )
    expect(summarizeAxe({ surfaces: [] }).status).toBe('not-run')
  })
})

describe('presence probes on git revisions', () => {
  test('counts files per revision and keeps test-only probes to test files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'readiness-probe-'))
    try {
      git(dir, ['init', '-q'])
      const first = commit(
        dir,
        {
          'src/feature.ts': 'export const needle = 1\n',
          'test/feature.test.ts': "test('needle', () => {})\n",
        },
        'add needle'
      )
      const second = commit(dir, { 'src/feature.ts': 'export const other = 1\n' }, 'remove needle')
      const probe = { pattern: 'needle', paths: ['.'] }
      expect(probeFiles(first, probe, dir)).toEqual(['src/feature.ts', 'test/feature.test.ts'])
      expect(probeFiles(first, { ...probe, testFilesOnly: true }, dir)).toEqual([
        'test/feature.test.ts',
      ])
      expect(probeFiles(second, probe, dir)).toEqual(['test/feature.test.ts'])
      expect(() => probeFiles('0'.repeat(40), probe, dir)).toThrow('not in the local object store')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('path-pattern probes list tracked files by name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'readiness-paths-'))
    try {
      git(dir, ['init', '-q'])
      const sha = commit(
        dir,
        { 'docs/rollback-runbook.md': '# runbook\n', 'docs/index.md': '# index\n' },
        'docs'
      )
      expect(
        probeFiles(sha, { pathPattern: 'rollback|rollout|runbook', paths: ['docs'] }, dir)
      ).toEqual(['docs/rollback-runbook.md'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
