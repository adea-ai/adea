import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

describe('build cache routing', () => {
  test('the pinned setup action can recognize the build runner', () => {
    // Code Foundry v1.48.4 setup/action.yml, script_uses_runner: setup does not
    // follow wrappers or script aliases before deciding whether to restore.
    // Keep this contract until that detector supports wrapped task runners.
    const runner = /(?:^|[\s;&|(])(?:vp\s+(?:-C\s+\S+\s+)?run|vpr)(?:\s|$)/
    expect(runner.test(manifest.scripts.build)).toBe(true)
  })

  for (const ci of [undefined, '', 'true', 'false']) {
    for (const status of [0, 23]) {
      test(`CI=${String(ci)} selects the correct runner and preserves exit ${status}`, () => {
        const fixture = mkdtempSync(join(tmpdir(), 'adea-build-routing-'))
        try {
          const bin = join(fixture, 'bin')
          mkdirSync(bin)
          writeFileSync(
            join(fixture, 'package.json'),
            JSON.stringify({ scripts: { build: manifest.scripts.build } })
          )
          // Exercise the real package script through Bun. Only its leaf
          // commands are replaced: a dispatch test need not rebuild the app.
          for (const name of ['vp', 'node']) {
            const path = join(bin, name)
            writeFileSync(
              path,
              `#!/bin/sh\nprintf '%s\\n' '${name}' "$@" "\${VITE_CACHE_PATH-unset}" > "$BUILD_ROUTING_RECEIPT"\nexit "$BUILD_ROUTING_STATUS"\n`
            )
            chmodSync(path, 0o755)
          }
          const receipt = join(fixture, 'receipt')
          const cache = join(fixture, 'restored-cache')
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            VITE_CACHE_PATH: cache,
            BUILD_ROUTING_RECEIPT: receipt,
            BUILD_ROUTING_STATUS: String(status),
          }
          delete env.CI
          if (ci !== undefined) env.CI = ci
          const result = spawnSync(process.execPath, ['run', '--cwd', fixture, 'build'], {
            env,
            encoding: 'utf8',
          })
          expect(result.error).toBeUndefined()
          expect(result.status, result.stderr).toBe(status)
          const expected = ci
            ? ['vp', 'run', 'orch:build', cache]
            : ['node', 'scripts/vp-local-run.mjs', 'orch:build', cache]
          expect(readFileSync(receipt, 'utf8').trim().split('\n')).toEqual(expected)
        } finally {
          rmSync(fixture, { recursive: true, force: true })
        }
      })
    }
  }
})

describe('qualified cache publication for validation', () => {
  const workflow = readFileSync(
    join(root, '.github/workflows/task-cache-qualification.yml'),
    'utf8'
  )
  const publication = workflow.split('- name: Save qualified tasks for validation readers')[1] ?? ''

  test('publishes only after qualification succeeds on a default-branch push', () => {
    expect(publication).toContain(
      "if: success() && github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)"
    )
    expect(workflow.indexOf('- name: Save qualified tasks for validation readers')).toBeGreaterThan(
      workflow.indexOf(
        '--compare-manifest "$RUNNER_TEMP/manifest-cold.txt,$RUNNER_TEMP/manifest-warm.txt"'
      )
    )
    expect(publication).toContain(
      'uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0'
    )
  })

  test('uses the pinned setup namespace and archive path list, not the proof-only namespace', () => {
    // v1.48.4 setup's broad restore prefix ends immediately after vp<version>.
    expect(readFileSync(join(root, '.github/code-foundry.yml'), 'utf8')).toMatch(
      /^runtime_ref: v1\.48\.4$/m
    )
    const prefix = `vite-plus-v1-\${{ runner.os }}-\${{ runner.arch }}-nodev${manifest.engines.node}-bun${manifest.packageManager.replace('bun@', '')}-vp${manifest.devDependencies['vite-plus']}-`
    expect(publication).toContain(`key: ${prefix}qualified-`)
    expect(publication).toContain("${{ hashFiles('bun.lock', 'vite.config.ts') }}")
    expect(publication).toContain('${{ github.run_id }}-${{ github.run_attempt }}')
    // Actions hashes the pattern list, not just the files it expands to.
    const paths = publication.match(/path: \|\n((?: +[^\n]+\n)+?)(?= +key:)/)?.[1]
    expect(
      paths
        ?.trim()
        .split('\n')
        .map((line) => line.trim())
    ).toEqual(['node_modules/.vite/task-cache', '**/node_modules/.vite/task-cache'])
    expect(publication).not.toContain('VITE_CACHE_PATH')
  })
})
