import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

function filesUnder(directory: string): string[] {
  const files: string[] = []
  if (!existsSync(directory)) return files
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(path))
    else if (entry.isFile() && entry.name.endsWith('.css')) files.push(path)
  }
  return files
}

// Every project stylesheet root. The token layer itself defines the values
// everything else must reference.
const stylesheetRoots = ['apps/web/src', 'packages/dev-view/src', 'packages/ui/src/styles']
const tokenLayer = new Set(['theme.css', 'appearance-font-settings.css'])

// Two utilities are the only sanctioned colour-mix users: the shimmer
// highlight and the sign-in grid hairline.
const colorMixAllowed = new Set(['base.css', 'auth-shell.css'])

// Auth and onboarding headlines scale fluidly past the 3xl step.
const displayType = /^(calc\()?clamp\(/

type Violation = { file: string; line: number; rule: string; value: string }

function violations(file: string): Violation[] {
  const name = file.split('/').pop() ?? file
  const found: Violation[] = []
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((text, index) => {
    const match = /^\s+([a-z-]+):\s*(.+?);/.exec(text)
    if (!match) return
    const [, property, value] = match
    const add = (rule: string) =>
      found.push({ file: relative(root, file), line: index + 1, rule, value })
    if (
      property === 'font-size' &&
      !/^(var\(--text-|inherit$|100%$|1em$|[\d.]+em$)/.test(value) &&
      !displayType.test(value) &&
      !(file.endsWith('apps/web/src/start/globals.css') && value === '16px')
    ) {
      add('font-size must be a published --text-* step')
    }
    if (property === 'font-weight' && !['400', '500', '600', 'inherit', 'normal'].includes(value)) {
      add('font-weight must be 400, 500 or 600')
    }
    if (property === 'border-radius') {
      for (const length of value.matchAll(/([\d.]+)rem/g)) {
        if (Number(length[1]) > 0.25) add('border-radius must use a --radius-* token')
      }
      if (/var\(--radius-[a-z0-9]+,/.test(value)) add('radius tokens take no fallback')
    }
    if (['gap', 'column-gap', 'row-gap', 'padding'].includes(property) && !value.includes('var(')) {
      for (const length of value.matchAll(/([\d.]+)rem/g)) {
        const eighths = Number(length[1]) * 8
        if (eighths !== Math.round(eighths)) add('spacing sits on the 0.125rem grid')
      }
    }
    if (value.includes('color-mix(') && !colorMixAllowed.has(name)) {
      add('use a semantic surface or status token instead of colour-mix')
    }
    if (
      /--dev-(border|panel|muted)\b/.test(value) ||
      /^--dev-(border|panel|muted)$/.test(property)
    ) {
      add('use the published border, card and muted-foreground tokens')
    }
  })
  return found
}

describe('local stylesheet token boundary', () => {
  const sheets = stylesheetRoots
    .flatMap((directory) => filesUnder(join(root, directory)))
    .filter((file) => !tokenLayer.has(file.split('/').pop() ?? ''))

  test('scans the project stylesheets', () => {
    expect(sheets.length).toBeGreaterThan(10)
  })

  test('local CSS only references published type, radius, spacing and colour tokens', () => {
    const found = sheets.flatMap(violations)
    expect(found.map((v) => `${v.file}:${v.line} ${v.rule} (${v.value})`)).toEqual([])
  })
})
