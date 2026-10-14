// TS 7's native compiler removed the classic JS API; the typescript6 alias keeps it.
import ts from 'typescript6'

const isZodSpecifier = (text: string) => text === 'zod' || text.startsWith('zod/')

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

function isId(node: ts.Node, name: string): node is ts.Identifier {
  return ts.isIdentifier(node) && node.text === name
}

function zCall(call: ts.Node, member: 'string' | 'number' | 'object'): call is ts.CallExpression {
  return (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    isId(call.expression.expression, 'z') &&
    call.expression.name.text === member
  )
}

/**
 * The one use of zod the client stand-in supports: a default `z` import and
 *
 *   const schema = z.object({ token: z.string(), expires_at: z.number() })
 *   const result = schema.safeParse(value)   // read only as result.success / result.data
 *
 * Returns what a source file does with zod beyond that. An empty list means the
 * stand-in is a drop-in replacement; any entry means it is not. Works on the
 * syntax tree, so spelling variants (aliases, destructuring, element access,
 * chaining, namespace or named imports, dynamic import, require, re-export)
 * cannot slip past a text match.
 */
export function zodCompatibilityProblems(source: string): string[] {
  const file = ts.createSourceFile(
    'adapter.mjs',
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS
  )
  const problems: string[] = []
  const at = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
  const report = (node: ts.Node, message: string) => problems.push(`line ${at(node)}: ${message}`)

  let importName: ts.Identifier | undefined

  // Every way of reaching zod other than the one default import.
  walk(file, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isZodSpecifier(node.moduleSpecifier.text)) return
      const clause = node.importClause
      if (
        node.moduleSpecifier.text !== 'zod' ||
        !clause ||
        clause.isTypeOnly ||
        clause.namedBindings !== undefined ||
        clause.name?.text !== 'z' ||
        importName !== undefined
      ) {
        report(node, 'zod must be imported once as a default binding named z')
      } else {
        importName = clause.name
      }
      return
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isZodSpecifier(node.moduleSpecifier.text)
    ) {
      report(node, 'zod is re-exported')
      return
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const loads =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && (callee.text === 'require' || callee.text === 'import'))
      if (loads) {
        const [argument] = node.arguments
        const specifier = argument && ts.isStringLiteralLike(argument) ? argument.text : undefined
        if (specifier === undefined || isZodSpecifier(specifier)) {
          report(node, 'zod is loaded dynamically')
        }
      }
    }
    // A zod specifier anywhere else (e.g. a string stored and imported later).
    if (
      ts.isStringLiteralLike(node) &&
      isZodSpecifier(node.text) &&
      !(ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) &&
      !(ts.isCallExpression(node.parent) && node.parent.arguments[0] === node)
    ) {
      report(node, 'the zod specifier is used as a value')
    }
  })

  if (!importName) return problems

  /** A reference to `name` (not a property name, label or declaration site). */
  const references = (scope: ts.Node, name: string): ts.Identifier[] => {
    const found: ts.Identifier[] = []
    walk(scope, (node) => {
      if (!isId(node, name)) return
      const parent = node.parent
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return
      if (ts.isPropertyAssignment(parent) && parent.name === node) return
      if (ts.isImportClause(parent)) return
      found.push(node)
    })
    return found
  }

  const declaredElsewhere = (name: string): boolean => {
    let declared = false
    walk(file, (node) => {
      const named =
        (ts.isVariableDeclaration(node) ||
          ts.isParameter(node) ||
          ts.isBindingElement(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node)) &&
        node.name !== undefined &&
        isId(node.name, name)
      if (named) declared = true
    })
    return declared
  }
  if (declaredElsewhere('z')) report(importName, 'z is redeclared, so uses of it cannot be traced')

  const objectSchemas: ts.Identifier[] = []
  const accounted = new Set<ts.Node>()

  for (const reference of references(file, 'z')) {
    const access = reference.parent
    const call = access.parent
    const member = ts.isPropertyAccessExpression(access) ? access.name.text : undefined
    const supported =
      ts.isPropertyAccessExpression(access) &&
      access.expression === reference &&
      (member === 'string' || member === 'number' || member === 'object') &&
      ts.isCallExpression(call) &&
      call.expression === access
    if (!supported) {
      report(reference, 'z is used other than as z.string(), z.number() or z.object({ ... })')
      continue
    }
    accounted.add(call)
  }

  const expectedShape = ['token:string', 'expires_at:number']
  for (const call of accounted) {
    if (!ts.isCallExpression(call)) continue
    if (zCall(call, 'string') || zCall(call, 'number')) {
      const parent = call.parent
      const field = ts.isPropertyAssignment(parent) && parent.initializer === call
      const inShape =
        field &&
        ts.isObjectLiteralExpression(parent.parent) &&
        zCall(parent.parent.parent, 'object')
      if (call.arguments.length > 0 || call.typeArguments !== undefined) {
        report(call, 'a field takes arguments or type arguments')
      }
      if (!inShape) report(call, 'a field is chained, stored or used outside z.object({ ... })')
      continue
    }
    // z.object(...)
    const [shape, ...rest] = call.arguments
    if (!shape || rest.length > 0 || !ts.isObjectLiteralExpression(shape) || call.typeArguments) {
      report(call, 'z.object must take exactly one object literal')
      continue
    }
    const fields: string[] = []
    for (const property of shape.properties) {
      const name =
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
          ? property.name.text
          : undefined
      const initializer = ts.isPropertyAssignment(property) ? property.initializer : undefined
      const kind =
        initializer && zCall(initializer, 'string')
          ? 'string'
          : initializer && zCall(initializer, 'number')
            ? 'number'
            : undefined
      if (name === undefined || kind === undefined) {
        report(property, 'a z.object field is not a plain z.string() or z.number()')
      } else {
        fields.push(`${name}:${kind}`)
      }
    }
    if (fields.join(',') !== expectedShape.join(',')) {
      report(
        call,
        `the schema fields are ${fields.join(', ')}; the stand-in is checked for token, expires_at`
      )
    }
    const declaration = call.parent
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer === call &&
      ts.isIdentifier(declaration.name) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      objectSchemas.push(declaration.name)
    } else {
      report(call, 'a schema is not bound directly to a const')
    }
  }

  for (const schema of objectSchemas) {
    for (const use of references(file, schema.text)) {
      if (use === schema) continue
      const access = use.parent
      const call = access.parent
      const supported =
        ts.isPropertyAccessExpression(access) &&
        access.expression === use &&
        access.name.text === 'safeParse' &&
        ts.isCallExpression(call) &&
        call.expression === access &&
        call.arguments.length === 1 &&
        !call.typeArguments
      if (!supported) {
        report(use, `${schema.text} is used other than as ${schema.text}.safeParse(value)`)
        continue
      }
      // The result is read as .success / .data in the scope that declares it.
      const declaration = call.parent
      if (!(ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name))) {
        report(call, 'a safeParse result is not bound to a plain variable')
        continue
      }
      const resultName = declaration.name.text
      let scope: ts.Node = declaration
      while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent
      for (const read of references(scope, resultName)) {
        if (read === declaration.name) continue
        const property = read.parent
        const ok =
          ts.isPropertyAccessExpression(property) &&
          property.expression === read &&
          (property.name.text === 'success' || property.name.text === 'data') &&
          !(ts.isCallExpression(property.parent) && property.parent.expression === property)
        if (!ok) report(read, `${resultName} is read other than as .success or .data`)
      }
    }
  }
  return problems
}
