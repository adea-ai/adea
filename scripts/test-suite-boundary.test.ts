import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

describe('test suite boundaries', () => {
  test('exposes Code Foundry entry points for every test category', () => {
    expect(packageJson.scripts.test).toBe('bun run test:unit')
    expect(packageJson.scripts['test:unit']).toContain('turbo run test')
    expect(packageJson.scripts['test:unit']).toContain('bun run test:coverage')
    expect(packageJson.scripts['test:integration']).toBe('bun scripts/test-integration.mjs')
    const integrationRunner = readFileSync(resolve(root, 'scripts/test-integration.mjs'), 'utf8')
    expect(integrationRunner).toContain('DATABASE_MIGRATION_URL')
    expect(integrationRunner).toContain("spawnSync('docker'")
    expect(integrationRunner).toContain("'compose'")
    expect(integrationRunner).toContain("'tests'")
    expect(integrationRunner).toContain("'integration'")
    expect(packageJson.scripts['test:e2e']).toContain('playwright')
    const playwrightConfig = readFileSync(resolve(root, 'playwright.config.ts'), 'utf8')
    expect(playwrightConfig).toContain("'--use-angle=metal'")
    expect(playwrightConfig).toContain('const headless = process.env.PLAYWRIGHT_HEADLESS')
    expect(playwrightConfig).toContain('headless,')
    expect(packageJson.scripts.release).toBeUndefined()
    expect(packageJson.scripts['test:smoke']).toBeUndefined()
    expect(packageJson.scripts['native:smoke']).toBeUndefined()
  })

  test('enforces the repository coverage goal on durable core code', () => {
    expect(packageJson.scripts['test:coverage']).toBe(
      'bun test packages/auth/tests/unit packages/db/tests/unit scripts/*.test.ts --coverage'
    )

    const bunfig = readFileSync(resolve(root, 'bunfig.toml'), 'utf8')
    expect(bunfig).toContain('coverageThreshold = { line = 0.8, function = 0.8 }')
    expect(bunfig).toContain('coverageSkipTestFiles = true')
    expect(bunfig).toContain('coverageReporter = ["text", "lcov"]')
    expect(bunfig).toContain('coverageDir = "coverage"')

    const codeFoundry = readFileSync(resolve(root, '.github/code-foundry.yml'), 'utf8')
    expect(codeFoundry).toContain('coverage_minimum: 80')
  })

  test('runs the database-backed integration category in the Neon lane', () => {
    const neonWorkflow = readFileSync(resolve(root, '.github/workflows/neon_workflow.yml'), 'utf8')
    expect(neonWorkflow).toContain('bun run test:integration')
    expect(neonWorkflow).not.toContain('packages/db test:integration')
    expect(neonWorkflow).not.toContain('packages/auth test:integration')
  })

  test('builds desktop releases entirely on GitHub-hosted runners', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/release-assets.yml'), 'utf8')
    expect(workflow).not.toContain('self-hosted')
    expect(workflow).not.toContain('self_hosted')
    expect(workflow).not.toContain('CI_BILLING_PAUSED')
    expect(workflow).not.toContain('cargo-xwin')
    expect(workflow).not.toContain('CI_BILLING_GATE_BACKUP')
    // Bash-syntax steps must not fall back to the Windows default shell.
    expect(workflow).toContain('defaults:')
    expect(workflow).toContain('shell: bash')
    expect(workflow).toContain('runner: macos-14')
    expect(workflow).toContain('runner: ubuntu-24.04')
    expect(workflow).toContain('runner: windows-latest')
    expect(workflow).toContain('bun scripts/release-notes.mjs')
    expect(workflow).toContain('bun run --cwd packages/types build')
    expect(workflow).toContain('timeout_minutes: 120')
    expect(workflow).toContain('timeout-minutes: ${{ matrix.timeout_minutes }}')
    expect(workflow).toContain('id: desktop_bundle')
    expect(workflow).toContain('continue-on-error: true')
    expect(workflow).toContain("steps.desktop_bundle.outcome == 'failure'")
    expect(workflow).toContain('Retry desktop bundle upload')
    expect(workflow).toContain('Verify updater channel')
    expect(workflow).toContain('releases/latest/download/latest.json')
    expect(workflow).not.toContain('r2.cloudflarestorage.com')
    expect(workflow).not.toContain('updates.adea.dev')
    expect(workflow).not.toContain('name: desktop-updater-pages')
    expect(workflow).not.toContain('deploy-pages')
    expect(workflow).not.toContain('name: github-pages')
    expect(workflow).not.toContain('brew install awscli')
    expect(workflow).not.toContain('release-runner')
    expect(existsSync(resolve(root, '.github/release-runner'))).toBeFalse()
    expect(existsSync(resolve(root, 'scripts/manual-release.mjs'))).toBeFalse()
    expect(existsSync(resolve(root, 'scripts/release-runners.mjs'))).toBeFalse()
    expect(existsSync(resolve(root, 'scripts/native-smoke.mjs'))).toBeFalse()
  })

  test('keeps one canonical changelog and versions every private workspace in lockstep', () => {
    const releaseConfig = JSON.parse(
      readFileSync(resolve(root, 'release-please-config.json'), 'utf8')
    )
    const extraFiles = new Set(
      releaseConfig['extra-files'].map((entry: { path: string }) => entry.path)
    )

    // The previous Rust crate's Cargo manifests are gone; a release-please
    // updater that still points at them would silently stop versioning a file.
    expect([...extraFiles].filter((path: string) => path.includes('src-tauri'))).toEqual([])
    expect([...extraFiles].filter((path: string) => /Cargo\.(toml|lock)$/.test(path))).toEqual([])

    for (const workspaceGroup of ['apps', 'packages']) {
      for (const workspace of readdirSync(resolve(root, workspaceGroup))) {
        const packagePath = `${workspaceGroup}/${workspace}/package.json`
        if (!existsSync(resolve(root, packagePath))) continue
        expect(extraFiles.has(packagePath)).toBeTrue()
        expect(existsSync(resolve(root, workspaceGroup, workspace, 'CHANGELOG.md'))).toBeFalse()
      }
    }
  })
})
