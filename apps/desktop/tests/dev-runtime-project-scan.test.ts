// The project scanner's contract (#398's remaining record gap): nested ignore
// rules, symlink refusal, and the budgets that end a walk early. The registry
// suite covers the cache/fingerprint/pagination behaviour; these pin the walker
// itself, which is where a monorepo scan can go wrong quietly.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanDirectoryRoot } from '../shell/src/dev-runtime/projects/scan'

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'adea-project-scan-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function packageAt(root: string, relativeDir: string, manifest = '{"name":"pkg"}'): string {
  const dir = relativeDir === '' ? root : join(root, relativeDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), manifest)
  return dir
}

describe('project scanner walker (#398)', () => {
  test('a nested .gitignore is applied on top of the root one, and a negation is reported', () => {
    const { root, cleanup } = scratch()
    try {
      writeFileSync(join(root, '.gitignore'), 'ignored-at-root/\n')
      packageAt(root, 'ignored-at-root')
      mkdirSync(join(root, 'packages'), { recursive: true })
      writeFileSync(join(root, 'packages', '.gitignore'), 'skip/\n!keep-me\n')
      packageAt(root, 'packages/skip')
      packageAt(root, 'packages/keep')

      const result = scanDirectoryRoot({ canonicalRoot: root })
      const dirs = result.entries.map((entry) => entry.relativeDir)

      // The root rule prunes its own subtree; the rule file *one level down*
      // prunes a subtree a single-file implementation would walk into.
      expect(dirs).toEqual(['packages/keep'])
      expect(
        result.diagnostics.some((entry) => entry.startsWith('gitignore_negation_unsupported'))
      ).toBe(true)

      // Control: remove the nested rule file and the pruned package appears,
      // which is what makes the assertion above about the nested rule itself.
      rmSync(join(root, 'packages', '.gitignore'))
      const control = scanDirectoryRoot({ canonicalRoot: root })
      expect(control.entries.map((entry) => entry.relativeDir)).toEqual([
        'packages/keep',
        'packages/skip',
      ])
    } finally {
      cleanup()
    }
  })

  test('never follows a symlinked directory', () => {
    const { root, cleanup } = scratch()
    try {
      packageAt(root, 'real')
      symlinkSync(join(root, 'real'), join(root, 'linked'), 'dir')

      const result = scanDirectoryRoot({ canonicalRoot: root })
      const dirs = result.entries.map((entry) => entry.relativeDir)

      // Each package keeps its own relative dir (the walker used to report
      // every package as the scan root, which made two packages
      // indistinguishable), and the link is never traversed.
      expect(dirs).toEqual(['real'])
      expect(result.entries[0]?.manifestPath).toBe('real/package.json')
    } finally {
      cleanup()
    }
  })

  test('a file-count budget ends the walk as partial, with its diagnostic', () => {
    const { root, cleanup } = scratch()
    try {
      for (let index = 0; index < 12; index += 1) packageAt(root, `pkg-${index}`)

      const result = scanDirectoryRoot({ canonicalRoot: root, budgets: { maxExaminedEntries: 3 } })

      expect(result.partial).toBe(true)
      expect(result.diagnostics).toContain('budget_exhausted')
      expect(result.examinedEntries).toBeLessThanOrEqual(6)
    } finally {
      cleanup()
    }
  })

  test('a package-count budget ends the walk as partial, with its diagnostic', () => {
    const { root, cleanup } = scratch()
    try {
      for (let index = 0; index < 5; index += 1) packageAt(root, `pkg-${index}`)

      const result = scanDirectoryRoot({ canonicalRoot: root, budgets: { maxPackages: 2 } })

      expect(result.partial).toBe(true)
      expect(result.diagnostics).toContain('budget_exhausted')
      expect(result.entries.length).toBeLessThanOrEqual(2)
    } finally {
      cleanup()
    }
  })

  test('cancellation stops the walk and says so', () => {
    const { root, cleanup } = scratch()
    try {
      // The probe is consulted at least every 100 entries, so the tree has to
      // be big enough for the walk to reach a check.
      for (let index = 0; index < 120; index += 1) packageAt(root, `pkg-${index}`)

      const result = scanDirectoryRoot({ canonicalRoot: root, shouldCancel: () => true })

      expect(result.cancelled).toBe(true)
      expect(result.partial).toBe(true)
      expect(result.diagnostics).toContain('cancelled')
    } finally {
      cleanup()
    }
  })

  test('a manifest beyond the byte budget is surfaced, not parsed', () => {
    const { root, cleanup } = scratch()
    try {
      packageAt(root, 'huge', `{"name":"huge","padding":"${'x'.repeat(512)}"}`)

      const result = scanDirectoryRoot({ canonicalRoot: root, budgets: { maxManifestBytes: 32 } })
      const entry = result.entries.find((candidate) => candidate.relativeDir === 'huge')

      expect(entry?.diagnostics).toContain('manifest_too_large')
      expect(entry?.packageManager).toBe('unknown')
    } finally {
      cleanup()
    }
  })
})
