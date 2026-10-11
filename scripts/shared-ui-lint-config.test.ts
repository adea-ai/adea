import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript6'

const root = resolve(import.meta.dir, '..')
const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function hasConsumerSuppression(
  source: string,
  scriptKind: ts.ScriptKind = ts.ScriptKind.TSX
): boolean {
  const fileName =
    scriptKind === ts.ScriptKind.TS
      ? 'consumer.ts'
      : scriptKind === ts.ScriptKind.TSX
        ? 'consumer.tsx'
        : scriptKind === ts.ScriptKind.JS
          ? 'consumer.js'
          : 'consumer.jsx'
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind)
  const literalRanges: { end: number; start: number }[] = []
  const collectLiteralRanges = (node: ts.Node) => {
    if (
      node.kind === ts.SyntaxKind.JsxText ||
      node.kind === ts.SyntaxKind.StringLiteral ||
      node.kind === ts.SyntaxKind.RegularExpressionLiteral ||
      node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      literalRanges.push({ start: node.getStart(sourceFile), end: node.end })
    }
    ts.forEachChild(node, collectLiteralRanges)
  }
  collectLiteralRanges(sourceFile)

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, source)
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const tokenStart = scanner.getTokenPos()
    const literalRange = literalRanges.find(
      ({ start, end }) => tokenStart >= start && tokenStart < end
    )
    if (literalRange) {
      // The plain scanner can treat literal text as comments and consume past
      // the syntax boundary. Resume at the parsed boundary before scanning on.
      scanner.setTextPos(literalRange.end)
      continue
    }
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    )
      continue
    const comment = scanner.getTokenText()
    const directives = [...comment.matchAll(/(?:oxlint|eslint)-disable(?:-next-line|-line)?\b/g)]
    for (const [index, directive] of directives.entries()) {
      const directiveBody = comment
        .slice(directive.index + directive[0].length, directives[index + 1]?.index)
        .replace(/\*\/\s*$/, '')
      // Oxlint and ESLint use `--` to begin a suppression rationale. Text in
      // that rationale is not part of the directive's rule list.
      const rules = directiveBody.split('--')[0]!.trim()
      if (
        !rules ||
        /(?:^|[,\s])adea\//.test(rules) ||
        /(?:^|[,\s])shadcn\/(?:no-restyle|no-raw-colors|no-arbitrary-values|no-inline-styles|no-unknown-classes)(?:$|[,\s])/.test(
          rules
        )
      )
        return true
    }
  }
  return false
}

function scriptKindForFile(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (/\.(?:mts|cts|ts)$/.test(file)) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

describe('shared UI lint configuration', () => {
  test('consumer enforcement has no path exemptions', () => {
    const config = JSON.parse(readFileSync(resolve(root, '.oxlintrc.json'), 'utf8')) as {
      rules: Record<string, unknown>
      overrides?: { rules?: Record<string, unknown> }[]
    }
    for (const name of [
      'no-raw-interactive-elements',
      'no-primitive-library-imports',
      'no-interactive-wrappers',
      'no-class-list',
      'no-inline-styles',
      'require-action-button-tooltip',
    ]) {
      const rule = `adea/${name}`
      expect(config.rules[rule]).toBe('error')
      for (const override of config.overrides ?? []) expect(override.rules?.[rule]).toBeUndefined()
    }
  })

  test('consumer source does not suppress shared UI rules inline', () => {
    const suppressed: string[] = []
    for (const file of new Bun.Glob(
      '{apps,packages}/**/src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'
    ).scanSync({ cwd: root })) {
      if (
        file.includes('/node_modules/') ||
        file.includes('/dist/') ||
        file.endsWith('/routeTree.gen.ts')
      )
        continue
      const source = readFileSync(resolve(root, file), 'utf8')
      if (hasConsumerSuppression(source, scriptKindForFile(file))) suppressed.push(file)
    }
    expect(suppressed).toEqual([])
  })

  test('blanket and shared-rule suppression comments cannot bypass the consumer guard', () => {
    expect(hasConsumerSuppression('/* oxlint-disable */')).toBe(true)
    expect(hasConsumerSuppression('// eslint-disable-next-line -- broad bypass')).toBe(true)
    expect(hasConsumerSuppression('/* oxlint-disable\n adea/no-interactive-wrappers */')).toBe(true)
    expect(hasConsumerSuppression('// eslint-disable-line adea/no-inline-styles')).toBe(true)
    expect(
      hasConsumerSuppression('// oxlint-disable-next-line shadcn/no-restyle -- custom control')
    ).toBe(true)
    expect(hasConsumerSuppression('/* eslint-disable shadcn/no-arbitrary-values */')).toBe(true)
    expect(
      hasConsumerSuppression('// oxlint-disable-line no-console, shadcn/no-inline-styles')
    ).toBe(true)
    expect(hasConsumerSuppression('// oxlint-disable-line shadcn/no-raw-colors')).toBe(true)
    expect(hasConsumerSuppression('// oxlint-disable-next-line shadcn/no-unknown-classes')).toBe(
      true
    )
    expect(
      hasConsumerSuppression(
        '/* oxlint-disable no-console -- logging\n eslint-disable adea/no-inline-styles */'
      )
    ).toBe(true)
    expect(
      hasConsumerSuppression('// oxlint-disable-next-line no-control-regex -- protocol parser')
    ).toBe(false)
    expect(
      hasConsumerSuppression(
        '// oxlint-disable no-console -- note: adea/no-inline-styles is discussed'
      )
    ).toBe(false)
    expect(hasConsumerSuppression('const text = "/* oxlint-disable */"')).toBe(false)
  })

  test('suppression detection follows parsed comments rather than JSX or literal text', () => {
    expect(hasConsumerSuppression('<pre>// oxlint-disable shadcn/no-restyle</pre>')).toBe(false)
    expect(hasConsumerSuppression('<pre>/* eslint-disable adea/no-inline-styles */</pre>')).toBe(
      false
    )
    expect(hasConsumerSuppression('<div>{/* oxlint-disable adea/no-inline-styles */}</div>')).toBe(
      true
    )
    expect(hasConsumerSuppression('const text = "// oxlint-disable adea/no-inline-styles"')).toBe(
      false
    )
    expect(
      hasConsumerSuppression('const template = `// oxlint-disable adea/no-inline-styles`')
    ).toBe(false)
    expect(
      hasConsumerSuppression('const pattern = /[//] oxlint-disable adea\\/no-inline-styles/')
    ).toBe(false)
    expect(
      hasConsumerSuppression(
        'const template = `${/* oxlint-disable adea/no-inline-styles */ "value"}`'
      )
    ).toBe(true)
    expect(
      hasConsumerSuppression('<div>// display { /* oxlint-disable adea/no-inline-styles */ }</div>')
    ).toBe(true)
    expect(
      hasConsumerSuppression(
        'const template = `${value}`; /* oxlint-disable adea/no-inline-styles */'
      )
    ).toBe(true)
  })

  test('separate directives are evaluated independently', () => {
    expect(
      hasConsumerSuppression(
        '// oxlint-disable no-console -- unrelated rule\n// eslint-disable-next-line adea/no-inline-styles'
      )
    ).toBe(true)
  })

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
        '    <div role="button" onClick={() => {}} />',
        '    <span tabIndex={0} />',
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

    expect(rules).toContain('adea(no-interactive-wrappers)')
    expect(rules.filter((rule) => rule === 'adea(no-interactive-wrappers)')).toHaveLength(2)
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
