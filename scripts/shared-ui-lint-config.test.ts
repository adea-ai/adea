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
  test('Oxlint rejects control, class, inline-style, and icon-tooltip drift', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'adea-shared-ui-lint-'))
    fixtures.push(fixture)
    const sourcePath = join(fixture, 'consumer.tsx')
    writeFileSync(
      sourcePath,
      [
        "import { Root as KobalteRoot } from '@kobalte/core/select'",
        "import { Dynamic } from 'solid-js/web'",
        "import { Button } from '@adea-ai/ui/components/ui/button'",
        "import { ActionButton } from '@adea-ai/ui/components/composites/action-button'",
        '',
        'export function Probe() {',
        '  return <>',
        '    <button type="button" />',
        '    <Dynamic component="input" />',
        '    <div classList={{ active: true }} />',
        '    <KobalteRoot />',
        '    <div style={{ color: "red" }} />',
        '    <div {...{ style: { color: "red" } }} />',
        '    <style>{".custom { color: red; }"}</style>',
        '    <Button size="icon-sm" aria-label="Save" />',
        '    <ActionButton size="icon-sm" aria-label="Close" tooltip=" " />',
        '    <Button size="sm">Save</Button>',
        '    <ActionButton size="icon-sm" aria-label="Close" tooltip="Close dialog" />',
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
      diagnostics: { code: string; severity: string }[]
    }
    const rules = report.diagnostics.map(({ code }) => code)

    expect(rules).toContain('adea(no-class-list)')
    expect(rules).toContain('adea(no-raw-interactive-elements)')
    expect(rules).toContain('adea(no-primitive-library-imports)')
    expect(rules).toContain('adea(no-inline-styles)')
    expect(rules).toContain('adea(require-action-button-tooltip)')
    expect(rules.filter((rule) => rule === 'adea(no-raw-interactive-elements)')).toHaveLength(2)
    expect(rules.filter((rule) => rule === 'adea(no-inline-styles)')).toHaveLength(3)
    expect(rules.filter((rule) => rule === 'adea(require-action-button-tooltip)')).toHaveLength(2)
    for (const diagnostic of report.diagnostics) {
      if (diagnostic.code.startsWith('adea(')) expect(diagnostic.severity).toBe('error')
    }
  })
})
