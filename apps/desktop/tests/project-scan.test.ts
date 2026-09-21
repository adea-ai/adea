import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_SCAN_BUDGETS,
  rootScanFingerprint,
  scanDirectoryRoot,
  type ScanCandidate,
} from '../shell/src/dev-runtime/projects/scan'

/** Deterministic fixture repos built per test; no committed fixtures. */
function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), 'adea-project-scan-'))
}

function write(root: string, relative: string, content: string): void {
  const file = join(root, relative)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

function names(entries: readonly ScanCandidate[]): string[] {
  return entries.map((entry) => entry.name).toSorted()
}

describe('monorepo scanner (prune-first walker)', () => {
  test('declared npm workspaces enumerate members without descending into packages', () => {
    const root = makeRepo()
    try {
      write(root, 'package.json', JSON.stringify({ name: 'monorepo', workspaces: ['packages/*'] }))
      write(root, 'packages/app/package.json', JSON.stringify({ name: '@scope/app' }))
      write(root, 'packages/lib/package.json', JSON.stringify({ name: 'lib' }))
      write(root, 'packages/lib/nested/should-not-scan/package.json', '{}')
      const result = scanDirectoryRoot({ canonicalRoot: root })
      expect(result.partial).toBe(false)
      expect(names(result.entries)).toEqual(['@scope/app', 'lib', 'monorepo'])
      const app = result.entries.find((entry) => entry.name === '@scope/app')!
      expect(app.relativeDir).toBe('packages/app')
      expect(app.manifestPath).toBe('packages/app/package.json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('lockfiles identify the package manager and scripts stay suggestions', () => {
    const root = makeRepo()
    try {
      write(root, 'package.json', JSON.stringify({ name: 'root' }))
      write(
        root,
        'apps/cli/package.json',
        JSON.stringify({ name: 'cli', scripts: { build: '', test: '' } })
      )
      write(root, 'pnpm-lock.yaml', '')
      write(root, 'pnpm-workspace.yaml', ['packages:', '  - "apps/*"', ''].join('\n'))
      const result = scanDirectoryRoot({ canonicalRoot: root })
      expect(names(result.entries)).toEqual(['cli', 'root'])
      const cli = result.entries.find((entry) => entry.name === 'cli')!
      expect(cli.packageManager).toBe('pnpm')
      // Scripts are surfaced as names only; scanning never runs them.
      expect(cli.suggestedScripts).toEqual(['build', 'test'])
      expect(cli.languages).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('bun, yarn, and npm lockfiles each identify their package manager', () => {
    const managers: ReadonlyArray<[string, string]> = [
      ['bun.lock', 'bun'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm'],
    ]
    for (const [lockfile, expected] of managers) {
      const root = makeRepo()
      try {
        // An undeclared root whose package directory carries its own
        // manifest plus lockfile (the prune-first walk stops at the leaf).
        write(root, `pkg/package.json`, JSON.stringify({ name: 'pkg' }))
        write(root, `pkg/${lockfile}`, '')
        const result = scanDirectoryRoot({ canonicalRoot: root })
        const pkg = result.entries.find((entry) => entry.name === 'pkg')!
        expect(pkg.packageManager).toBe(expected)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  test('cargo workspaces parse declared members and crate names', () => {
    const root = makeRepo()
    try {
      write(
        root,
        'Cargo.toml',
        ['[workspace]', 'members = [', '  "crates/alpha",', '  "crates/beta",', ']', ''].join('\n')
      )
      write(root, 'crates/alpha/Cargo.toml', '[package]\nname = "alpha"\n')
      write(root, 'crates/beta/Cargo.toml', '[package]\nname = "beta"\n')
      const result = scanDirectoryRoot({ canonicalRoot: root })
      expect(names(result.entries)).toEqual(['alpha', 'beta'])
      const alpha = result.entries.find((entry) => entry.name === 'alpha')!
      expect(alpha.packageManager).toBe('cargo')
      expect(alpha.languages).toEqual(['rust'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('python uv workspaces parse members and project names', () => {
    const root = makeRepo()
    try {
      write(
        root,
        'pyproject.toml',
        [
          '[project]',
          'name = "root-py"',
          '',
          '[tool.uv.workspace]',
          'members = ["libs/*"]',
          '',
        ].join('\n')
      )
      write(root, 'libs/tooling/pyproject.toml', '[project]\nname = "tooling"\n')
      const result = scanDirectoryRoot({ canonicalRoot: root })
      expect(names(result.entries)).toEqual(['root-py', 'tooling'])
      const tooling = result.entries.find((entry) => entry.name === 'tooling')!
      expect(tooling.packageManager).toBe('uv')
      expect(tooling.languages).toEqual(['python'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('undeclared roots descend prune-first, skipping dependency and ignored directories', () => {
    const root = makeRepo()
    try {
      write(root, 'services/api/package.json', JSON.stringify({ name: 'api' }))
      write(root, 'node_modules/coy/package.json', JSON.stringify({ name: 'coy' }))
      write(root, 'target/debug/junk.txt', 'x')
      write(root, 'skipped/hidden/package.json', JSON.stringify({ name: 'hidden' }))
      write(root, '.gitignore', 'skipped/\n')
      const result = scanDirectoryRoot({ canonicalRoot: root })
      expect(names(result.entries)).toEqual(['api'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('symlinks are never followed, whatever they point at', () => {
    const root = makeRepo()
    const outside = makeRepo()
    try {
      write(outside, 'secret/package.json', JSON.stringify({ name: 'outside-secret' }))
      write(root, 'real/package.json', JSON.stringify({ name: 'real' }))
      symlinkSync(join(outside, 'secret'), join(root, 'linked'))
      const result = scanDirectoryRoot({ canonicalRoot: root })
      expect(names(result.entries)).toEqual(['real'])
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('malformed manifests surface as diagnostics with fallback names, not failures', () => {
    const root = makeRepo()
    try {
      write(root, 'package.json', '{broken json')
      const result = scanDirectoryRoot({ canonicalRoot: root })
      expect(result.entries.length).toBe(1)
      expect(result.entries[0]!.diagnostics).toContain('malformed_manifest')
      expect(result.entries[0]!.name).toBe('.')

      const wsRoot = makeRepo()
      try {
        write(wsRoot, 'pnpm-workspace.yaml', 'packages:\n  - [unclosed\n')
        const wsResult = scanDirectoryRoot({ canonicalRoot: wsRoot })
        expect(wsResult.diagnostics).toContain('malformed_manifest:pnpm-workspace.yaml')
      } finally {
        rmSync(wsRoot, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('missing literal workspace members are reported, not silently dropped', () => {
    const root = makeRepo()
    try {
      write(
        root,
        'package.json',
        JSON.stringify({ name: 'root', workspaces: ['packages/app', 'packages/ghost'] })
      )
      write(root, 'packages/app/package.json', JSON.stringify({ name: 'app' }))
      const result = scanDirectoryRoot({ canonicalRoot: root })
      expect(result.entries.map((entry) => entry.name)).toContain('app')
      expect(result.diagnostics).toContain('missing_workspace_member:packages/ghost')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('gitignore negations are reported instead of silently over-pruning', () => {
    const root = makeRepo()
    try {
      write(root, '.gitignore', 'generated/\n!important/generated/\n')
      const result = scanDirectoryRoot({ canonicalRoot: root })
      expect(result.diagnostics).toContain('gitignore_negation_unsupported:.')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('package budgets stop the walk and return partial results with budget_exhausted', () => {
    const root = makeRepo()
    try {
      write(root, 'package.json', JSON.stringify({ name: 'root', workspaces: ['pkgs/*'] }))
      for (const name of ['one', 'two', 'three'])
        write(root, `pkgs/${name}/package.json`, JSON.stringify({ name }))
      const result = scanDirectoryRoot({
        canonicalRoot: root,
        budgets: { ...DEFAULT_SCAN_BUDGETS, maxPackages: 2 },
      })
      expect(result.entries.length).toBe(2)
      expect(result.partial).toBe(true)
      expect(result.diagnostics).toContain('budget_exhausted')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('cancellation is honored and returns a partial page marked cancelled', () => {
    const root = makeRepo()
    try {
      write(root, 'package.json', JSON.stringify({ name: 'root', workspaces: ['pkgs/*'] }))
      for (const name of ['one', 'two', 'three'])
        write(root, `pkgs/${name}/package.json`, JSON.stringify({ name }))
      const result = scanDirectoryRoot({
        canonicalRoot: root,
        shouldCancel: () => true,
      })
      expect(result.cancelled).toBe(true)
      expect(result.partial).toBe(true)
      expect(result.diagnostics).toContain('cancelled')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an unreadable root returns root_unreadable instead of throwing', () => {
    const result = scanDirectoryRoot({ canonicalRoot: '/nonexistent/adea-scan-root' })
    expect(result.partial).toBe(true)
    expect(result.diagnostics).toContain('root_unreadable')
    expect(result.entries).toEqual([])
  })

  test('fingerprints change when a manifest changes and drive cache invalidation', () => {
    const root = makeRepo()
    try {
      write(root, 'package.json', JSON.stringify({ name: 'root' }))
      const before = rootScanFingerprint(root)
      write(root, 'package.json', JSON.stringify({ name: 'root', workspaces: ['x/*'] }))
      // Force a distinct mtime; size changed too, so both signals agree.
      utimesSync(join(root, 'package.json'), new Date(), new Date(Date.now() + 2000))
      const after = rootScanFingerprint(root)
      expect(after).not.toBe(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
