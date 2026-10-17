import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PREVIEW_SELECTION } from '../apps/web/cloudflare.config'

const root = new URL('..', import.meta.url).pathname
const workflowPath = join(root, '.github/workflows/cloudflare-preview.yml')
const workflowText = readFileSync(workflowPath, 'utf8')
const workflow = Bun.YAML.parse(workflowText) as {
  permissions: Record<string, string>
  jobs: Record<string, any>
}

const REFUSAL =
  'Preview deployment blocked: no isolated preview resources are configured. Select dedicated preview resources.'

function step(job: string, name: string): { name: string; run?: string; [key: string]: unknown } {
  const found = workflow.jobs[job].steps.find(
    (candidate: { name: string }) => candidate.name === name
  )
  if (!found) throw new Error(`step "${name}" not found in job "${job}"`)
  return found
}

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

// Executes a workflow step's real `run:` text under the shell options Actions uses for `bash`.
function runStep(
  runText: string,
  cwd: string,
  environment: Record<string, string>
): { status: number; output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'adea-preview-step-'))
  directories.push(directory)
  const scriptFile = join(directory, 'step.sh')
  writeFileSync(scriptFile, runText)
  const result = Bun.spawnSync(['bash', '--noprofile', '--norc', '-e', scriptFile], {
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: directory, ...environment },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    status: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  }
}

// A repository-shaped fixture: apps/web with a stub cf-wrangler in node_modules/.bin.
function fixture(stub: string | null): string {
  const directory = mkdtempSync(join(tmpdir(), 'adea-preview-fixture-'))
  directories.push(directory)
  const web = join(directory, 'apps/web')
  mkdirSync(web, { recursive: true })
  if (stub !== null) {
    mkdirSync(join(directory, 'node_modules/.bin'), { recursive: true })
    const binary = join(directory, 'node_modules/.bin/cf-wrangler')
    writeFileSync(binary, `#!/bin/sh\n${stub}\n`)
    chmodSync(binary, 0o755)
  }
  return web
}

const guardStep = () => step('unavailable', 'Assert the preview build is refused').run as string

describe('cloudflare-preview.yml outcomes', () => {
  test('has exactly the availability, unavailable and preview jobs', () => {
    expect(Object.keys(workflow.jobs).toSorted()).toEqual([
      'availability',
      'preview',
      'unavailable',
    ])
  })

  test('only an explicit unavailable state skips the deploy, and only a configured one deploys', () => {
    expect(workflow.jobs.unavailable.needs).toBe('availability')
    expect(workflow.jobs.unavailable.if).toBe("needs.availability.outputs.state == 'unavailable'")
    expect(workflow.jobs.preview.needs).toBe('availability')
    expect(workflow.jobs.preview.if).toContain("needs.availability.outputs.state == 'configured'")
    expect(workflow.jobs.preview.if).not.toContain('unavailable')
    // A failed or skipped availability job (invalid selection, draft, fork) runs neither job.
    for (const job of ['unavailable', 'preview']) {
      expect(workflow.jobs[job].if).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/)
    }
  })

  test('no step can turn a failure into success', () => {
    expect(workflowText).not.toMatch(/continue-on-error/)
    expect(workflowText).not.toMatch(/\|\|\s*true/)
    expect(workflowText).not.toMatch(/\bif:\s*(always|failure|cancelled)\(\)/)
    expect(workflowText).not.toMatch(/\bexit 0\b/)
  })

  test('the deploy job is the unchanged shared workflow with the credentials, and only it', () => {
    const preview = workflow.jobs.preview
    expect(preview.uses).toBe(
      '0xPlayerOne/code-foundry/.github/workflows/cloudflare-deploy.yml@v1.47.1'
    )
    expect(preview.with).toEqual({
      mode: 'preview',
      'deploy-tool': 'cf',
      'working-directory': 'apps/web',
      'install-working-directory': '.',
      'build-script': 'build:cloudflare',
      'bun-version': '1.4.0',
      environment: 'Preview - adea-web',
    })
    expect(Object.keys(preview.secrets).toSorted()).toEqual([
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
    ])
    // The selection is not forwarded to the build, so a configured run still fails closed at it.
    expect(JSON.stringify(preview.with) + JSON.stringify(preview.secrets)).not.toContain(
      'ADEA_PREVIEW_'
    )
    expect(preview.permissions).toEqual({ contents: 'read', deployments: 'write' })
  })

  test('the availability and unavailable jobs hold no Cloudflare credential or deploy permission', () => {
    for (const job of ['availability', 'unavailable']) {
      const serialized = JSON.stringify(workflow.jobs[job])
      expect(serialized).not.toMatch(
        /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|secrets\.|cf previews deploy|cf deploy/
      )
      expect(workflow.jobs[job].permissions).toEqual({ contents: 'read' })
      expect(workflow.jobs[job].secrets).toBeUndefined()
    }
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  test('the availability job reads exactly the selection names cloudflare.config.ts defines', () => {
    const environment = workflow.jobs.availability.env as Record<string, string>
    expect(Object.keys(environment).toSorted()).toEqual(Object.values(PREVIEW_SELECTION).toSorted())
    for (const [name, value] of Object.entries(environment)) {
      expect(value).toBe(`\${{ vars.${name} }}`)
    }
    expect(step('availability', 'Classify preview availability').run).toBe(
      'bun scripts/preview-availability.mjs'
    )
  })

  test('the unavailable job keeps the build and the configuration and guard tests', () => {
    expect(step('unavailable', 'Build Worker')).toMatchObject({
      'working-directory': 'apps/web',
      run: 'bun run build:cloudflare',
    })
    const tests = step('unavailable', 'Configuration and guard regression tests').run as string
    for (const file of [
      'apps/web/test/cloudflare-config.test.ts',
      'scripts/preview-availability.test.ts',
      'scripts/cloudflare-preview-workflow.test.ts',
    ]) {
      expect(tests).toContain(file)
    }
    expect(tests.startsWith('bun test')).toBe(true)
  })
})

describe('the preview-refusal step, executed as written', () => {
  test('passes only when the build fails with the isolation message', () => {
    const web = fixture(`echo '${REFUSAL}'; exit 1`)
    const result = runStep(guardStep(), web, {})
    expect(result.status).toBe(0)
    expect(result.output).toContain('refused by the isolation guard')
  })

  test('fails when the preview build succeeds', () => {
    const web = fixture('echo built; exit 0')
    const result = runStep(guardStep(), web, {})
    expect(result.status).toBe(1)
    expect(result.output).toContain('no longer blocks it')
  })

  test('fails when the build fails for any other reason', () => {
    const web = fixture("echo 'Error: wrangler could not parse the config'; exit 1")
    const result = runStep(guardStep(), web, {})
    expect(result.status).toBe(1)
    expect(result.output).toContain('other than the isolation guard')
  })

  test('fails when the message appears but the build somehow exits 0', () => {
    const web = fixture(`echo '${REFUSAL}'; exit 0`)
    expect(runStep(guardStep(), web, {}).status).toBe(1)
  })

  test('fails when cf-wrangler cannot be found, so the guard is never skipped silently', () => {
    const web = fixture(null)
    const result = runStep(guardStep(), web, {})
    expect(result.status).toBe(1)
    expect(result.output).toContain('cf-wrangler not found')
  })

  test('passes against the real cf-wrangler and the real config with no credentials', () => {
    const result = runStep(guardStep(), join(root, 'apps/web'), {
      PATH: `${join(root, 'node_modules/.bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    })
    expect(result.output).toContain(
      'Preview deployment blocked: no isolated preview resources are configured'
    )
    expect(result.status).toBe(0)
  })
})

describe('the unavailable report step', () => {
  test('writes an explicit, honest summary and a notice, and exits 0', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-preview-summary-'))
    directories.push(directory)
    const summary = join(directory, 'summary.md')
    writeFileSync(summary, '')
    const result = runStep(
      step('unavailable', 'Report that the preview deployment is intentionally unavailable')
        .run as string,
      directory,
      { GITHUB_STEP_SUMMARY: summary }
    )
    expect(result.status).toBe(0)
    expect(result.output).toContain('::notice title=Preview deployment intentionally unavailable::')
    const text = readFileSync(summary, 'utf8')
    expect(text).toContain('intentionally unavailable')
    expect(text).toContain('no Cloudflare credential was used')
    expect(text).toContain('would fail instead of landing here')
  })
})
