// Pins the lazy entry graph of the Control Plane panes and Lead chat (ADR 0013). Each entry's
// static import closure is read from source, so a stray import that would pull a sibling
// feature into another's chunk fails here before it shows up as bytes in the production build.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = join(import.meta.dir, '../../src')

function sourceFile(module: string): string {
  for (const extension of ['.ts', '.tsx']) {
    const path = join(src, `${module}${extension}`)
    if (existsSync(path)) return path
  }
  throw new Error(`No source file for ./${module}`)
}

/**
 * Relative modules a source text loads when it runs: static imports and re-exports, not
 * type-only ones. Each statement is read on its own (the source has no semicolons, so a
 * clause that spans statements would hide the runtime import after a type import).
 */
function runtimeImports(code: string): string[] {
  const found: string[] = []
  for (const statement of code.split(/^(?=(?:import|export)\b)/m)) {
    const sideEffect = statement.match(/^import\s*'\.\/([^']+)'/)
    if (sideEffect) {
      found.push(sideEffect[1]!)
      continue
    }
    const match = statement.match(/^(?:import|export)\s+([^'"]*?)\s*from\s*'\.\/([^']+)'/)
    if (!match) continue
    const clause = match[1]!
    if (/^type[\s{*]/.test(clause)) continue
    // `import { type A }` alone is erased; `import { type A, B }` keeps B.
    if (clause.startsWith('{') && clause.split(',').every((part) => /^[{\s]*type\s/.test(part)))
      continue
    found.push(match[2]!)
  }
  return found
}

function staticImports(module: string): string[] {
  return runtimeImports(readFileSync(sourceFile(module), 'utf8'))
}

function dynamicImports(module: string): string[] {
  const code = readFileSync(sourceFile(module), 'utf8')
  return [...code.matchAll(/\bimport\(\s*'\.\/([^']+)'\s*\)/g)].map((match) => match[1]!)
}

function staticClosure(entry: string): Set<string> {
  const seen = new Set<string>()
  const pending = [entry]
  while (pending.length > 0) {
    const module = pending.pop()!
    if (seen.has(module)) continue
    seen.add(module)
    pending.push(...staticImports(module))
  }
  return seen
}

const catalogPanes = ['skills-pane', 'cloud-connections-pane']
const hostPanes = ['runtime-nodes-pane', 'lead-model-pane']
const leadChat = ['lead-turn-controls', 'lead-model-request']
const entries = ['lead-chat', 'control-plane-catalog', 'control-plane-hosts']

function expectDisjoint(entry: string, forbidden: readonly string[]) {
  const closure = staticClosure(entry)
  expect(forbidden.filter((module) => closure.has(module))).toEqual([])
}

test('the retired shared Control Plane settings entry stays retired', () => {
  expect(existsSync(join(src, 'control-plane-settings.ts'))).toBe(false)
  for (const module of ['conversation-surface', 'workspace-details-dialog']) {
    expect(dynamicImports(module)).not.toContain('control-plane-settings')
    expect(staticImports(module)).not.toContain('control-plane-settings')
  }
})

test('Lead chat reaches no settings pane', () => {
  expect([...staticClosure('lead-chat')]).toEqual(expect.arrayContaining(leadChat))
  expectDisjoint('lead-chat', [
    ...catalogPanes,
    ...hostPanes,
    'control-plane-settings-model',
    'workspace-lead-status',
    'control-plane-catalog',
    'control-plane-hosts',
  ])
})

test('catalog panes reach neither the host panes nor Lead chat', () => {
  expect([...staticClosure('control-plane-catalog')]).toEqual(expect.arrayContaining(catalogPanes))
  expectDisjoint('control-plane-catalog', [...hostPanes, ...leadChat, 'lead-chat'])
})

test('host and model panes reach neither the catalog panes nor Lead chat', () => {
  expect([...staticClosure('control-plane-hosts')]).toEqual(expect.arrayContaining(hostPanes))
  expectDisjoint('control-plane-hosts', [
    ...catalogPanes,
    'control-plane-settings-model',
    'lead-turn-controls',
    'lead-chat',
  ])
})

test('the conversation surface and settings dialog load every entry on demand', () => {
  for (const host of ['conversation-surface', 'workspace-details-dialog']) {
    const closure = staticClosure(host)
    expect(entries.filter((entry) => closure.has(entry))).toEqual([])
    expect(
      [...closure].filter((module) => [...catalogPanes, ...hostPanes].includes(module))
    ).toEqual([])
  }
  expect(dynamicImports('conversation-surface')).toEqual(expect.arrayContaining(['lead-chat']))
  expect(dynamicImports('workspace-details-dialog')).toEqual(
    expect.arrayContaining(['control-plane-catalog', 'control-plane-hosts'])
  )
})

test('the import scanner keeps runtime imports that follow type and package imports', () => {
  const code = [
    "import type { Client } from '@adea-ai/api-client'",
    "import { Pane } from './pane'",
    "import type { Choices } from './choices'",
    "import { type Row } from '@adea-ai/types'",
    "import { helper } from './helper'",
    "import { type OnlyType, type AlsoType } from './types-only'",
    "import { type Kept, value } from './mixed'",
    "import Default, { type Named } from './default'",
    "import './side-effect'",
    'export type Alias = { a: 1 }',
    "export { Exported } from './exported'",
    "export type { Shape } from './shape'",
    "export type * from './all-types'",
    "export * from './all'",
    '',
  ].join('\n')
  expect(runtimeImports(code)).toEqual([
    'pane',
    'helper',
    'mixed',
    'default',
    'side-effect',
    'exported',
    'all',
  ])
})

test('the import scanner reads multi-line clauses', () => {
  const code = `import {
  type Row,
  Pane,
} from './pane'
import type {
  Choices,
} from './choices'
`
  expect(runtimeImports(code)).toEqual(['pane'])
})
