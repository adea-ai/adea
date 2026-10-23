import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as urls from 'node:url'

import { PREVIEW_SELECTION } from '../apps/web/cloudflare.config'
import { classifyPreviewAvailability } from './preview-availability.mjs'

const script = new URL('./preview-availability.mjs', import.meta.url).pathname

const valid = {
  ADEA_PREVIEW_HYPERDRIVE_ID: '11111111111111111111111111111111',
  ADEA_PREVIEW_SECRETS_STORE_ID: '22222222222222222222222222222222',
  ADEA_PREVIEW_DATABASE_URL_SECRET: 'ADEA_PREVIEW_DATABASE_URL',
  ADEA_PREVIEW_AUTH_BASE_URL_SECRET: 'ADEA_PREVIEW_AUTH_BASE_URL',
  ADEA_PREVIEW_AUTH_COOKIE_SECRET_NAME: 'ADEA_PREVIEW_AUTH_COOKIE_SECRET',
  ADEA_PREVIEW_AUTH_TRUSTED_ORIGINS_SECRET: 'ADEA_PREVIEW_AUTH_TRUSTED_ORIGINS',
}

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function runScript(selection: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'adea-preview-availability-'))
  directories.push(directory)
  const output = join(directory, 'output')
  const summary = join(directory, 'summary')
  writeFileSync(output, '')
  writeFileSync(summary, '')
  // A clean environment: nothing inherited can select or deselect a preview resource.
  const result = Bun.spawnSync([process.execPath, script], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: directory,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      ...selection,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    output: readFileSync(output, 'utf8'),
    summary: readFileSync(summary, 'utf8'),
  }
}

describe('preview availability', () => {
  test('the six selection names are the ones cloudflare.config.ts reads', () => {
    expect(Object.values(PREVIEW_SELECTION).toSorted()).toEqual(Object.keys(valid).toSorted())
  })

  test('no selection is unavailable, a state that exits 0 and names itself', () => {
    const result = runScript({})
    expect(result.status).toBe(0)
    expect(result.output).toBe('state=unavailable\n')
    expect(result.summary).toContain('intentionally unavailable')
    expect(result.summary).toContain('not a validation failure')
  })

  test('empty and whitespace-only values count as unset, as previewEnv reads them', () => {
    const blank = Object.fromEntries(
      Object.keys(valid).map((name, index) => [name, index % 2 ? '' : '  '])
    )
    expect(classifyPreviewAvailability(blank)).toBe('unavailable')
    expect(runScript(blank).output).toBe('state=unavailable\n')
  })

  test('a complete preview selection is configured and leaves the deploy to run', () => {
    const result = runScript(valid)
    expect(result.status).toBe(0)
    expect(result.output).toBe('state=configured\n')
  })

  test.each(Object.keys(valid))(
    'a selection missing only %s fails, never unavailable',
    (missing) => {
      const partial = { ...valid }
      delete (partial as Record<string, string>)[missing]
      const result = runScript(partial)
      expect(result.status).toBe(1)
      expect(result.output).toBe('')
      expect(result.stdout).toContain('::error title=Preview configuration invalid::')
      expect(result.stdout).toContain('all or nothing')
      expect(result.summary).toContain('Preview configuration invalid')
    }
  )

  test('a single stray value fails closed', () => {
    const result = runScript({ ADEA_PREVIEW_HYPERDRIVE_ID: valid.ADEA_PREVIEW_HYPERDRIVE_ID })
    expect(result.status).toBe(1)
    expect(result.output).toBe('')
  })

  test('the production Hyperdrive or Secrets Store fails closed', () => {
    const productionHyperdrive = runScript({
      ...valid,
      ADEA_PREVIEW_HYPERDRIVE_ID: '5faad934a0a14a29bbb4780ca2f53fa6',
    })
    expect(productionHyperdrive.status).toBe(1)
    expect(productionHyperdrive.output).toBe('')
    const productionStore = runScript({
      ...valid,
      ADEA_PREVIEW_SECRETS_STORE_ID: 'b3a1b4e8427a4d23ac7925cc18a7a2ac',
    })
    expect(productionStore.status).toBe(1)
    expect(productionStore.output).toBe('')
  })

  test('a production or non-preview secret name fails closed', () => {
    for (const [name, value] of [
      ['ADEA_PREVIEW_DATABASE_URL_SECRET', 'ADEA_RAILWAY_PRODUCTION_DATABASE_URL'],
      ['ADEA_PREVIEW_AUTH_COOKIE_SECRET_NAME', 'ADEA_RAILWAY_PRODUCTION_AUTH_SECRET'],
      ['ADEA_PREVIEW_AUTH_BASE_URL_SECRET', 'SOME_OTHER_SECRET'],
    ] as const) {
      const result = runScript({ ...valid, [name]: value })
      expect(result.status).toBe(1)
      expect(result.output).toBe('')
    }
  })

  test('an inherited selection from the parent environment is not what the test sees', () => {
    // runScript passes a clean environment, so the ambient shell cannot change these results.
    expect(runScript({}).output).toBe('state=unavailable\n')
  })
})

async function runPreviewEntry(selection: Record<string, string>, files = true) {
  const directory = mkdtempSync(join(tmpdir(), 'adea-preview-entry-'))
  directories.push(directory)
  const output = join(directory, 'output')
  const summary = join(directory, 'summary')
  writeFileSync(output, 'previous-output\n')
  writeFileSync(summary, 'previous-summary\n')
  const previous = { argv: process.argv, env: process.env }
  const entry = crypto.randomUUID()
  const moduleUrl = new URL(`./preview-availability.mjs?entry=${entry}`, import.meta.url)
  const originalUrl = urls.pathToFileURL
  // Preserve the entry-point comparison for this fresh instrumented module
  // instance; every other URL conversion keeps the original implementation.
  const address = spyOn(urls, 'pathToFileURL').mockImplementation((path) =>
    path === script ? moduleUrl : originalUrl(path)
  )
  const messages = spyOn(console, 'log').mockImplementation(() => {})
  const exitSignal = Symbol('preview command exit')
  let status = 0
  const exit = spyOn(process, 'exit').mockImplementation((code) => {
    status = Number(code ?? 0)
    throw exitSignal
  })
  try {
    process.argv = [process.execPath, script]
    process.env = {
      PATH: process.env.PATH ?? '',
      HOME: directory,
      ...selection,
      ...(files ? { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } : {}),
    }
    try {
      await import(`./preview-availability.mjs?entry=${entry}`)
    } catch (error) {
      if (error !== exitSignal) throw error
    }
    return {
      status,
      messages: messages.mock.calls.flat().join('\n'),
      output: readFileSync(output, 'utf8'),
      summary: readFileSync(summary, 'utf8'),
    }
  } finally {
    process.argv = previous.argv
    process.env = previous.env
    address.mockRestore()
    messages.mockRestore()
    exit.mockRestore()
  }
}

describe('preview command reporting', () => {
  test.each([
    ['unavailable', {}],
    ['configured', valid],
  ] as const)(
    'appends the %s state without overwriting earlier workflow output',
    async (state, selection) => {
      const result = await runPreviewEntry(selection)
      expect(result.status).toBe(0)
      expect(result.messages).toBe(`Preview availability: ${state}`)
      expect(result.output).toBe(`previous-output\nstate=${state}\n`)
      expect(result.summary.startsWith('previous-summary\n')).toBe(true)
      expect(result.summary).toContain(
        state === 'unavailable'
          ? 'intentionally unavailable'
          : 'Isolated preview resources are selected'
      )
    }
  )

  test('reports an invalid selection, exits before publishing state, and appends its diagnostic', async () => {
    const result = await runPreviewEntry({
      ADEA_PREVIEW_HYPERDRIVE_ID: valid.ADEA_PREVIEW_HYPERDRIVE_ID,
    })
    expect(result.status).toBe(1)
    expect(result.messages).toContain('::error title=Preview configuration invalid::')
    expect(result.messages).toContain('all or nothing')
    expect(result.output).toBe('previous-output\n')
    expect(result.summary).toContain('previous-summary\n### Preview configuration invalid')
  })

  test('works without GitHub output files and still fails an invalid selection', async () => {
    const configured = await runPreviewEntry(valid, false)
    expect(configured.status).toBe(0)
    expect(configured.messages).toBe('Preview availability: configured')
    expect(configured.output).toBe('previous-output\n')
    expect(configured.summary).toBe('previous-summary\n')
    const invalid = await runPreviewEntry(
      { ADEA_PREVIEW_HYPERDRIVE_ID: valid.ADEA_PREVIEW_HYPERDRIVE_ID },
      false
    )
    expect(invalid.status).toBe(1)
    expect(invalid.messages).toContain('Preview configuration invalid')
    expect(invalid.summary).toBe('previous-summary\n')
  })
})
