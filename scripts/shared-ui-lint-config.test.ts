import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dir, '..')
const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

describe('shared UI lint configuration', () => {
  test('Oxlint rejects hidden Solid classes and preserves shared primitive restrictions', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'adea-shared-ui-lint-'))
    fixtures.push(fixture)
    const sourcePath = join(fixture, 'consumer.tsx')
    writeFileSync(
      sourcePath,
      [
        "import { Root as KobalteRoot } from '@kobalte/core/select'",
        '',
        'export function Probe() {',
        '  return <>',
        '    <button type="button" />',
        '    <div classList={{ active: true }} />',
        '    <div role="tablist" aria-label="Browser lanes"><KobalteRoot role="tab" onClick={() => {}} /></div>',
        '    <KobalteRoot />',
        '  </>',
        '}',
      ].join('\n')
    )

    const result = spawnSync(
      resolve(root, 'node_modules/.bin/oxlint'),
      [
        '--config',
        resolve(root, '.oxlintrc.json'),
        '--threads',
        '1',
        '--format',
        'json',
        sourcePath,
      ],
      { cwd: root, encoding: 'utf8' }
    )

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout) as {
      diagnostics: { code: string }[]
    }
    const rules = report.diagnostics.map(({ code }) => code)

    expect(rules).toContain('adea(no-class-list)')
    expect(rules).toContain('adea(no-raw-interactive-elements)')
    expect(rules).toContain('adea(no-primitive-library-imports)')
    expect(rules).toContain('adea(no-interactive-wrappers)')
  })
})
