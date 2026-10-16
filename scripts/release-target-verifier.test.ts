import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, string> }
const workflow = Bun.YAML.parse(
  readFileSync(join(root, '.github/workflows/release-assets.yml'), 'utf8')
) as { jobs: Record<string, { 'working-directory'?: string; steps: Step[] }> }

const stepNamed = (job: string, name: string) => {
  const step = workflow.jobs[job]!.steps.find((candidate) => candidate.name === name)
  if (!step?.run) throw new Error(`missing step: ${job} / ${name}`)
  return step as Step & { run: string; 'working-directory'?: string }
}

const RELEASE = '{"mode":"release","cloudOrigin":"https://adea.dev"}'
const LOCAL = '{"mode":"local","cloudOrigin":"http://localhost:3000"}'
const HOSTED_DEV = '{"mode":"hosted-dev","cloudOrigin":"https://adea.dev"}'

// The payload both release jobs inspect: the layout every existing check in
// those snippets expects, plus the client's recorded build target.
function buildPayload(directory: string, target: string | null) {
  const stage = join(directory, 'stage', 'Adea.app', 'Contents')
  const files: Record<string, string> = {
    'MacOS/launcher': '#!/bin/sh\n',
    'MacOS/bun': 'bun',
    'Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework': 'cef',
    'Resources/app/client/index.html': '<html></html>',
    'Resources/app/dev-runtime-sidecar/entry.js': '//',
    'Resources/app/managed-pi/managed-pi-1.0.0.archive': 'pi',
    'Resources/AppIcon.icns': 'icon',
    'Resources/version.json': '{"version":"1.2.3"}',
  }
  if (target !== null) files['Resources/app/client/adea-desktop-target.json'] = target
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(stage, path)), { recursive: true })
    writeFileSync(join(stage, path), content)
  }
  const payload = join(directory, 'payload.tar.zst')
  const packed = spawnSync('tar', [
    '--zstd',
    '-cf',
    payload,
    '-C',
    join(directory, 'stage'),
    'Adea.app',
  ])
  expect(packed.status).toBe(0)
  return payload
}

// A repository root with the files the jobs read at the release ref.
function fixtureRoot(directory: string, scriptsOnly: boolean) {
  const repo = join(directory, 'repo')
  mkdirSync(join(repo, 'apps/desktop'), { recursive: true })
  cpSync(join(root, 'apps/desktop/scripts'), join(repo, 'apps/desktop/scripts'), {
    recursive: true,
  })
  if (!scriptsOnly) {
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    cpSync(
      join(root, 'scripts/check-desktop-payload-version.mjs'),
      join(repo, 'scripts/check-desktop-payload-version.mjs')
    )
  }
  return repo
}

function run(script: string, cwd: string, env: Record<string, string>) {
  const file = join(cwd, '..', `step-${Math.random().toString(16).slice(2)}.sh`)
  writeFileSync(file, script)
  return spawnSync('bash', ['-e', file], {
    cwd,
    env: { HOME: process.env.HOME ?? '', ...env },
    encoding: 'utf8',
  })
}

describe('the packaging job verifier (Verify stable bundle structure)', () => {
  const step = stepNamed('desktop', 'Verify stable bundle structure')

  function execute(target: string | null, releaseVersion = '1.2.3') {
    const directory = mkdtempSync(join(tmpdir(), 'adea-release-pack-'))
    try {
      const repo = fixtureRoot(directory, false)
      // The job's working directory, relative to the checkout.
      const shell = join(repo, 'apps/desktop/shell')
      const app = join(shell, 'build/stable-macos-arm64/Adea.app')
      mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
      mkdirSync(join(app, 'Contents/Resources'), { recursive: true })
      writeFileSync(join(app, 'Contents/Info.plist'), '')
      writeFileSync(join(app, 'Contents/MacOS/launcher'), '#!/bin/sh\n')
      chmodSync(join(app, 'Contents/MacOS/launcher'), 0o755)
      cpSync(buildPayload(directory, target), join(app, 'Contents/Resources/payload.tar.zst'))
      // /usr/libexec/PlistBuddy exists only on macOS: the one absolute-path
      // tool the job calls. Everything else runs exactly as written.
      const plistBuddy = join(directory, 'PlistBuddy')
      writeFileSync(plistBuddy, '#!/bin/sh\necho launcher\n')
      chmodSync(plistBuddy, 0o755)
      const script = step.run.replaceAll('/usr/libexec/PlistBuddy', plistBuddy)
      expect(script).not.toBe(step.run)
      return run(script, shell, {
        PATH: process.env.PATH ?? '',
        RELEASE_VERSION: releaseVersion,
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  test('runs from apps/desktop/shell, as the job does', () => {
    expect(workflow.jobs.desktop!.steps.find((s) => s.name === step.name)).toBeDefined()
    expect((step as { 'working-directory'?: string })['working-directory']).toBe(
      'apps/desktop/shell'
    )
  })

  test('passes for a release-built payload, with and without a release version', () => {
    const result = execute(RELEASE)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Stable bundle verified')
    expect(execute(RELEASE, '').status).toBe(0)
  })

  test('fails for a payload built as a local or hosted-dev client, or with no record', () => {
    for (const target of [LOCAL, HOSTED_DEV]) {
      const result = execute(target)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('not as a release build')
    }
    expect(execute(null).status).not.toBe(0)
  })

  test('keeps its earlier checks: a payload whose version differs from the release fails', () => {
    expect(execute(RELEASE, '9.9.9').status).not.toBe(0)
  })
})

describe('the published-assets verifier (Verify uploaded desktop assets)', () => {
  const step = stepNamed('verify-assets', 'Verify uploaded desktop assets')

  function execute(target: string | null) {
    const directory = mkdtempSync(join(tmpdir(), 'adea-release-assets-'))
    try {
      // The job checks out only apps/desktop/scripts at the release tag, so the
      // working directory holds nothing else (no root scripts, no shell).
      const repo = fixtureRoot(directory, true)
      expect(existsSync(join(repo, 'scripts'))).toBe(false)
      const releaseDirectory = join(directory, 'release')
      mkdirSync(releaseDirectory)
      const dmg = join(releaseDirectory, 'Adea-v1.2.3-macos-arm64.dmg')
      writeFileSync(dmg, '')
      truncateSync(dmg, 51 * 1024 * 1024)
      const handle = spawnSync('sh', [
        '-c',
        `printf koly | dd of='${dmg}' bs=1 seek=${51 * 1024 * 1024 - 512} conv=notrunc 2>/dev/null`,
      ])
      expect(handle.status).toBe(0)
      cpSync(
        buildPayload(directory, target),
        join(releaseDirectory, 'Adea-v1.2.3-macos-arm64.app.tar.zst')
      )
      // `gh release download` copies the fixture assets into --dir; nothing leaves the machine.
      const bin = join(directory, 'bin')
      mkdirSync(bin)
      writeFileSync(
        join(bin, 'gh'),
        [
          '#!/bin/bash',
          'set -e',
          'if [ "$1 $2" = "release download" ]; then',
          '  while [ $# -gt 0 ]; do [ "$1" = "--dir" ] && dir="$2"; shift; done',
          `  cp '${releaseDirectory}'/* "$dir"/`,
          '  exit 0',
          'fi',
          'echo "unexpected gh call: $*" >&2',
          'exit 1',
          '',
        ].join('\n')
      )
      chmodSync(join(bin, 'gh'), 0o755)
      return run(step.run, repo, {
        PATH: `${bin}:${process.env.PATH}`,
        RELEASE_TAG: 'v1.2.3',
        GITHUB_REPOSITORY: 'adea-ai/adea',
        GH_TOKEN: 'unused',
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  test('checks out the verifier from the release tag, scripts directory only', () => {
    const steps = workflow.jobs['verify-assets']!.steps
    const checkoutIndex = steps.findIndex((s) => s.uses?.startsWith('actions/checkout@'))
    expect(checkoutIndex).toBeGreaterThan(-1)
    expect(checkoutIndex).toBeLessThan(steps.findIndex((s) => s.name === step.name))
    expect(steps[checkoutIndex]!.with).toMatchObject({
      ref: '${{ env.RELEASE_TAG }}',
      'sparse-checkout': 'apps/desktop/scripts',
      'persist-credentials': false,
    })
    expect((step as { 'working-directory'?: string })['working-directory']).toBeUndefined()
  })

  test('passes for a release-built archive, using only what the sparse checkout holds', () => {
    const result = execute(RELEASE)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Release assets verified')
  })

  test('fails for an archive built as a local or hosted-dev client, or with no record', () => {
    for (const target of [LOCAL, HOSTED_DEV]) {
      const result = execute(target)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('not as a release build')
    }
    expect(execute(null).status).not.toBe(0)
  })

  test('uses no variable the job never defines (set -u)', () => {
    expect(step.run).toContain('set -euo pipefail')
    expect(step.run).not.toContain('$payload')
    expect(step.run).not.toContain('../scripts/')
  })
})
