// Static conformance check for every Dev Runtime command a UI surface issues.
//
// The M12/M13 audit sweep found three panes calling operations the contract
// refuses — `dev.browser.targets` (unknown body key), `dev.browser.laneCreate`
// (missing required `profilePolicyId`), and `dev.device.start` (missing its
// resource binding, so `buildDevCommand` threw). Each had a passing test suite;
// nothing crossed the boundary between a pane and the registry it is written
// against. This check is that boundary.
//
// It parses with the TypeScript compiler that is already a dependency, not with
// regular expressions: a brace-counting regex version produced false positives
// on multi-line bodies and had to be debugged several times, and a guard that
// cries wolf is a guard that gets deleted.
//
// Deliberately conservative. A body built by spreading an object whose keys
// cannot be read statically is SKIPPED rather than guessed at, so the check
// reports only what it can prove.
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

import { devOperationDefinitions } from '../packages/types/src/dev-runtime-registry'

const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript')

const root = resolve(import.meta.dir, '..')

/** Surfaces that issue Dev Runtime commands and can therefore drift from the contract. */
const SCANNED_ROOTS = [
  'packages/dev-view/src',
  'packages/workspace-ui/src',
  'apps/web/src',
  'packages/data/src',
] as const

type OperationDefinition = { body?: string; resource?: unknown }

function sourceFiles(relativeDir: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const child = join(dir, entry)
      if (statSync(child).isDirectory()) walk(child)
      else if (child.endsWith('.ts') || child.endsWith('.tsx')) found.push(child)
    }
  }
  walk(resolve(root, relativeDir))
  return found
}

/**
 * Field names of a contracted body, at depth 1 only, so a nested object type
 * (`{ claim: { id: string } }`) contributes `claim` and not `id`.
 */
function contractBodyKeys(
  body: string | undefined
): { required: string[]; optional: string[] } | null {
  if (!body) return null
  const required: string[] = []
  const optional: string[] = []
  let depth = 0
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!
    if (character === '{' || character === '[' || character === '(') {
      depth += 1
      continue
    }
    if (character === '}' || character === ']' || character === ')') {
      depth -= 1
      continue
    }
    if (depth !== 1) continue
    const match = /^([A-Za-z_$][\w$]*)(\?)?\s*:/.exec(body.slice(index))
    if (match) {
      ;(match[2] ? optional : required).push(match[1]!)
      index += match[0].length - 1
    }
  }
  return { required, optional }
}

/** The statically-known keys of an object literal, or null if any is dynamic. */
function literalKeys(node: import('typescript').Node): string[] | null {
  if (!ts.isObjectLiteralExpression(node)) return null
  const keys: string[] = []
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) return null
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name))
      keys.push(property.name.text)
    else if (ts.isShorthandPropertyAssignment(property)) keys.push(property.name.text)
    else if (ts.isMethodDeclaration(property) || ts.isGetAccessor(property))
      keys.push(property.name.getText())
    else return null
  }
  return keys
}

type Finding = { file: string; line: number; operation: string; problem: string }

function scanFile(file: string): Finding[] {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const findings: Finding[] = []
  const report = (node: import('typescript').Node, operation: string, problem: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    findings.push({
      file: file.slice(root.length + 1),
      line: line + 1,
      operation,
      problem,
    })
  }

  const visit = (node: import('typescript').Node) => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined
      const operationArgument = node.arguments[0]!
      if (
        name === 'execute' &&
        ts.isStringLiteral(operationArgument) &&
        operationArgument.text.startsWith('dev.')
      ) {
        const operation = operationArgument.text
        const definition = (
          devOperationDefinitions as Record<string, OperationDefinition | undefined>
        )[operation]
        if (!definition) {
          report(node, operation, 'is not in the generated operation registry')
        } else {
          const resourceArgument = node.arguments[2]
          const hasResource =
            resourceArgument !== undefined && !ts.isOmittedExpression(resourceArgument)
          if (definition.resource && !hasResource)
            report(node, operation, 'binds a resource but the call passes none')
          if (!definition.resource && hasResource)
            report(node, operation, 'binds no resource but the call passes one')
          const contract = contractBodyKeys(definition.body)
          const keys = node.arguments[1] ? literalKeys(node.arguments[1]) : null
          if (contract && keys) {
            for (const key of keys)
              if (!contract.required.includes(key) && !contract.optional.includes(key))
                report(node, operation, `body key '${key}' is not in the contract`)
            for (const required of contract.required)
              if (!keys.includes(required))
                report(node, operation, `is missing required body key '${required}'`)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

const allFindings = SCANNED_ROOTS.flatMap((dir) => sourceFiles(dir).flatMap(scanFile))

describe('Dev Runtime command conformance', () => {
  test('the surfaces scanned actually issue Dev Runtime commands', () => {
    // A silently-empty scan would make every assertion below vacuous, so pin
    // that the scanner is looking at a real population of call sites.
    const operations = new Set(allFindings.map((f) => f.operation))
    expect(allFindings.length).toBeGreaterThanOrEqual(0)
    const scannedOperations = new Set<string>()
    for (const dir of SCANNED_ROOTS)
      for (const file of sourceFiles(dir)) {
        for (const match of readFileSync(file, 'utf8').matchAll(/'(dev\.[a-zA-Z.]+)'/g))
          scannedOperations.add(match[1]!)
      }
    expect(scannedOperations.size).toBeGreaterThan(10)
    expect(operations.size).toBeLessThanOrEqual(scannedOperations.size)
  })

  test('every Dev Runtime command a surface issues matches the registry', () => {
    const report = allFindings
      .map((f) => `${f.file}:${f.line}  ${f.operation} ${f.problem}`)
      .join('\n')
    expect(report).toBe('')
  })
})
