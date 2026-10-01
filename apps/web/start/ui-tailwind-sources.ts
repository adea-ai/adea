import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'

import ts from 'typescript'
import type { Plugin, ResolvedConfig } from 'vite'

type Selection = { kind: 'execute' | 'side-effect' | 'all' } | { kind: 'named'; names: string[] }

interface RuntimeImport {
  specifier: string
  selection: Selection
}

interface ExportTarget {
  file: string
  selection: Selection
}

interface ParsedModule {
  sourceFile: ts.SourceFile
  source: string
}

export interface SourceDiscoveryOptions {
  entrypoint: string | string[]
  repositoryRoot: string
  uiPackageRoot: string
  uiSourceRoot: string
  includeDevLucideImports?: boolean
  resolveId(specifier: string, importer: string): Promise<string | undefined>
}

export interface LucideImportRequirement {
  file: string
  names: string[]
}

export interface UiSourceGraph {
  uiSourceFiles: string[]
  devLucideImports: LucideImportRequirement[]
}

export interface SourceDirectiveOptions {
  files: string[]
  uiPackageRoot: string
  stablePackagePath: string
  stylesheetPath: string
}

export function missingLucideDevShimExports(
  imports: LucideImportRequirement[],
  shimSource: string
): LucideImportRequirement[] {
  const shimExports = new Set<string>()
  const shim = ts.createSourceFile(
    'lucide-solid-dev-shim.jsx',
    shimSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSX
  )
  for (const statement of shim.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith('lucide-solid/icons/') ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    )
      continue
    for (const element of statement.exportClause.elements) {
      if (!element.isTypeOnly) shimExports.add(moduleExportName(element.name))
    }
  }

  return imports
    .map(({ file, names }) => ({
      file,
      names: names.filter((name) => !shimExports.has(name)).toSorted(),
    }))
    .filter(({ names }) => names.length > 0)
    .toSorted((left, right) => left.file.localeCompare(right.file))
}

export function assertLucideDevShimCoverage(
  imports: LucideImportRequirement[],
  shimSource: string,
  repositoryRoot?: string
): void {
  const missing = missingLucideDevShimExports(imports, shimSource)
  if (missing.length === 0) return

  const details = missing
    .map(({ file, names }) => {
      const displayPath = repositoryRoot
        ? relative(repositoryRoot, file).replaceAll('\\', '/')
        : file
      return `  ${displayPath}: ${names.join(', ')}`
    })
    .join('\n')
  throw new Error(
    `[adea-lucide-dev-shim] missing named exports from the dev shim:\n${details}\n` +
      'Add direct icon exports to apps/web/start/lucide-solid-dev-shim.jsx.'
  )
}

function modulePath(id: string): string {
  const withoutQuery = id.split('?')[0] ?? id
  const absolute = resolve(withoutQuery)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

function inside(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path)
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  )
}

function isWorkspaceSourceFile(path: string, repositoryRoot: string): boolean {
  if (!inside(path, repositoryRoot)) return false
  const segments = relative(repositoryRoot, path).split(sep)
  return (
    (segments[0] === 'apps' || segments[0] === 'packages') &&
    segments.includes('src') &&
    !segments.includes('node_modules')
  )
}

function isCodeFile(path: string): boolean {
  return ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(path))
}

function isTypeOnlyStatement(statement: ts.Statement): boolean {
  return (
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    (ts.canHaveModifiers(statement) &&
      (ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ??
        false))
  )
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
  )
}

function exportedNames(statement: ts.Statement): string[] {
  if (isTypeOnlyStatement(statement)) return []
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  ) {
    if (
      !hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      !hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    )
      return []
    return [
      ...(statement.name ? [statement.name.text] : []),
      ...(hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? ['default'] : []),
    ]
  }
  if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name)
    )
  }
  if (ts.isExportAssignment(statement)) return statement.isExportEquals ? ['default'] : ['default']
  return []
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  )
}

function moduleExportName(name: ts.ModuleExportName): string {
  return ts.isIdentifier(name) ? name.text : name.text
}

function readModule(path: string, cache: Map<string, ParsedModule>): ParsedModule {
  const file = modulePath(path)
  const cached = cache.get(file)
  if (cached) return cached
  const source = readFileSync(file, 'utf8')
  const extension = extname(file)
  const scriptKind =
    extension === '.tsx' || extension === '.jsx'
      ? ts.ScriptKind.TSX
      : ['.js', '.jsx', '.mjs', '.cjs'].includes(extension)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS
  const parsed: ParsedModule = {
    source,
    sourceFile: ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind),
  }
  cache.set(file, parsed)
  return parsed
}

function namespaceSelection(
  sourceFile: ts.Node,
  binding: ts.Identifier,
  excludedNode?: ts.Node
): Selection | undefined {
  const names = new Set<string>()
  let opaqueUse = false
  let used = false
  let shadowed = false

  const isShadowBinding = (node: ts.Identifier): boolean => {
    if (node === binding || node.text !== binding.text) return false
    const parent = node.parent
    if (
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isParameter(parent) && parent.name === node) ||
      ((ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isClassExpression(parent) ||
        ts.isEnumDeclaration(parent) ||
        ts.isInterfaceDeclaration(parent) ||
        ts.isTypeAliasDeclaration(parent) ||
        ts.isModuleDeclaration(parent)) &&
        parent.name === node) ||
      (ts.isCatchClause(parent) && parent.variableDeclaration?.name === node)
    )
      return true
    return false
  }

  const visit = (node: ts.Node) => {
    if (node === excludedNode) return
    if (ts.isIdentifier(node) && isShadowBinding(node)) shadowed = true
    if (ts.isIdentifier(node) && node.text === binding.text && node !== binding) {
      const parent = node.parent
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        names.add(parent.name.text)
        used = true
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const argument = parent.argumentExpression
        if (
          argument &&
          (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
        ) {
          names.add(argument.text)
          used = true
        } else {
          opaqueUse = true
          used = true
        }
      } else if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
        // This identifier is the property name, not a reference to the namespace.
      } else {
        opaqueUse = true
        used = true
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  if (!used) return undefined
  if (shadowed) return { kind: 'all' }
  return opaqueUse ? { kind: 'all' } : { kind: 'named', names: [...names].toSorted() }
}

function importSelection(
  declaration: ts.ImportDeclaration,
  sourceFile: ts.SourceFile
): Selection | undefined {
  const clause = declaration.importClause
  if (!clause) return { kind: 'side-effect' }
  if (clause.isTypeOnly) return undefined

  const names = new Set<string>()
  if (clause.name) names.add('default')
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    return namespaceSelection(sourceFile, clause.namedBindings.name, declaration)
  }
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly) names.add(element.propertyName?.text ?? element.name.text)
    }
  }
  return names.size ? { kind: 'named', names: [...names].toSorted() } : undefined
}

function dynamicSelection(call: ts.CallExpression): Selection {
  let current: ts.Node = call
  while (current.parent) {
    current = current.parent
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === 'then'
    ) {
      const callback = current.arguments[0]
      const parameter =
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        callback.parameters[0]
      if (parameter && ts.isIdentifier(parameter.name)) {
        const selection = namespaceSelection(callback, parameter.name)
        if (selection) return selection
      } else if (parameter && ts.isObjectBindingPattern(parameter.name)) {
        if (
          parameter.name.elements.some(
            (element) => element.dotDotDotToken || ts.isObjectBindingPattern(element.name)
          )
        )
          return { kind: 'all' }
        const names: string[] = []
        for (const element of parameter.name.elements) {
          const name = element.propertyName ?? element.name
          if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
            names.push(name.text)
          } else {
            return { kind: 'all' }
          }
        }
        if (names.length) return { kind: 'named', names: names.toSorted() }
      }
      return { kind: 'all' }
    }
    if (ts.isStatement(current) || ts.isSourceFile(current)) break
  }
  return { kind: 'all' }
}

function runtimeImports(parsed: ParsedModule): RuntimeImport[] {
  const imports: RuntimeImport[] = []
  const sourceFile = parsed.sourceFile

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const selection = importSelection(node, sourceFile)
      if (selection) imports.push({ specifier: node.moduleSpecifier.text, selection })
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (
        !argument ||
        (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))
      ) {
        throw new Error(
          `[adea-ui-tailwind-sources] non-literal runtime import in ${sourceFile.fileName}; use a literal import path so shared UI sources remain discoverable`
        )
      }
      imports.push({ specifier: argument.text, selection: dynamicSelection(node) })
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push({ specifier: node.arguments[0].text, selection: { kind: 'all' } })
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return imports
}

interface DevLucideCollectionOptions {
  entrypoints: string[]
  repositoryRoot: string
  uiSourceRoot: string
  resolveId(specifier: string, importer: string): Promise<string | undefined>
  cache: Map<string, ParsedModule>
}

async function collectDevLucideImports(
  options: DevLucideCollectionOptions
): Promise<LucideImportRequirement[]> {
  const visited = new Set<string>()
  const imports = new Map<string, Set<string>>()

  const record = (file: string, selection: Selection): void => {
    if (!inside(file, options.uiSourceRoot)) return
    if (selection.kind === 'all' || selection.kind === 'side-effect') {
      const reason = selection.kind === 'all' ? 'opaque or namespace' : 'side-effect-only'
      throw new Error(
        `[adea-lucide-dev-shim] ${reason} runtime import of 'lucide-solid' in ${file}; use named icon imports so the dev shim can be checked without loading the full catalogue`
      )
    }
    const names = imports.get(file) ?? new Set<string>()
    for (const name of selection.names) names.add(name)
    imports.set(file, names)
  }

  const visit = async (path: string): Promise<void> => {
    const file = modulePath(path)
    const inUi = inside(file, options.uiSourceRoot)
    if (
      !isCodeFile(file) ||
      (!inUi && !isWorkspaceSourceFile(file, options.repositoryRoot)) ||
      visited.has(file)
    )
      return
    visited.add(file)

    const parsed = readModule(file, options.cache)
    const visitDependency = async (specifier: string, isReexport = false): Promise<void> => {
      if (specifier === 'lucide-solid') return
      const resolved = await options.resolveId(specifier, file)
      if (!resolved) {
        const isPublishedUiImport =
          specifier === '@adea-ai/ui' || specifier.startsWith('@adea-ai/ui/')
        if (inUi || isPublishedUiImport) {
          throw new Error(
            `[adea-ui-tailwind-sources] unable to resolve ${isReexport ? 're-export' : 'runtime import'} '${specifier}' from ${file}`
          )
        }
        return
      }

      const target = modulePath(resolved)
      if (
        isCodeFile(target) &&
        (inside(target, options.uiSourceRoot) ||
          isWorkspaceSourceFile(target, options.repositoryRoot))
      )
        await visit(target)
    }

    for (const dependency of runtimeImports(parsed)) {
      if (dependency.specifier === 'lucide-solid') record(file, dependency.selection)
      else await visitDependency(dependency.specifier)
    }

    for (const statement of parsed.sourceFile.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        statement.isTypeOnly ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue
      const specifier = statement.moduleSpecifier.text
      if (specifier === 'lucide-solid') {
        if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) {
          record(file, { kind: 'all' })
        } else if (ts.isNamedExports(statement.exportClause)) {
          record(file, {
            kind: 'named',
            names: statement.exportClause.elements
              .filter((element) => !element.isTypeOnly)
              .map((element) => moduleExportName(element.propertyName ?? element.name)),
          })
        }
      } else {
        await visitDependency(specifier, true)
      }
    }
  }

  // Vite serves the published package as native ESM. Static imports and
  // re-exports are linked even when the consumer selects one root-barrel name.
  // Literal dynamic imports are also preflighted without importing or executing
  // them, so lazy features cannot fail later with a missing shim export.
  for (const entrypoint of options.entrypoints) await visit(entrypoint)

  return [...imports]
    .map(([file, names]) => ({ file, names: [...names].toSorted() }))
    .toSorted((left, right) => left.file.localeCompare(right.file))
}

function localRuntimeBinding(
  file: string,
  localName: string,
  cache: Map<string, ParsedModule>
): RuntimeImport | undefined {
  const parsed = readModule(file, cache)
  for (const statement of parsed.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const clause = statement.importClause
    if (!clause || clause.isTypeOnly) continue
    if (clause.name?.text === localName)
      return {
        specifier: statement.moduleSpecifier.text,
        selection: { kind: 'named', names: ['default'] },
      }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      if (clause.namedBindings.name.text === localName)
        return { specifier: statement.moduleSpecifier.text, selection: { kind: 'all' } }
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      const binding = clause.namedBindings.elements.find(
        (element) => !element.isTypeOnly && element.name.text === localName
      )
      if (binding) {
        return {
          specifier: statement.moduleSpecifier.text,
          selection: { kind: 'named', names: [binding.propertyName?.text ?? binding.name.text] },
        }
      }
    }
  }
  return undefined
}

function hasLocalRuntimeBinding(
  file: string,
  localName: string,
  cache: Map<string, ParsedModule>
): boolean {
  const parsed = readModule(file, cache)
  return parsed.sourceFile.statements.some((statement) => {
    if (isTypeOnlyStatement(statement)) return false
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === localName
    )
      return true
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.some((declaration) =>
        bindingNames(declaration.name).includes(localName)
      )
    return false
  })
}

function modifierExport(file: string, name: string, cache: Map<string, ParsedModule>): boolean {
  return readModule(file, cache).sourceFile.statements.some((statement) =>
    exportedNames(statement).includes(name)
  )
}

export async function collectUiSourceGraph(
  options: SourceDiscoveryOptions
): Promise<UiSourceGraph> {
  const repositoryRoot = realpathSync(options.repositoryRoot)
  const uiSourceRoot = realpathSync(options.uiSourceRoot)
  const entrypoints = (
    Array.isArray(options.entrypoint) ? options.entrypoint : [options.entrypoint]
  ).map((entrypoint) => realpathSync(entrypoint))
  const cache = new Map<string, ParsedModule>()
  const visited = new Set<string>()
  const files = new Set<string>()
  const publishedUiResolutions: string[] = []

  const resolveImport = async (
    specifier: string,
    importer: string,
    selection: Selection
  ): Promise<void> => {
    const importerIsUi = inside(importer, uiSourceRoot)
    const isPublishedUiImport = specifier === '@adea-ai/ui' || specifier.startsWith('@adea-ai/ui/')
    const resolved = await options.resolveId(specifier, importer)
    if (isPublishedUiImport)
      publishedUiResolutions.push(`${specifier} -> ${resolved ?? '(unresolved)'}`)
    if (!resolved) {
      if (isPublishedUiImport || importerIsUi)
        throw new Error(
          `[adea-ui-tailwind-sources] unable to resolve runtime import '${specifier}' from ${importer}`
        )
      return
    }

    const target = modulePath(resolved)
    if (!isCodeFile(target)) return
    if (isPublishedUiImport && !inside(target, uiSourceRoot)) {
      throw new Error(
        `[adea-ui-tailwind-sources] '${specifier}' resolved outside published UI source: ${target}`
      )
    }
    if (inside(target, uiSourceRoot) || isWorkspaceSourceFile(target, repositoryRoot)) {
      await visit(target, selection)
      return
    }
  }

  const resolveExportTargets = async (
    file: string,
    name: string,
    chain: Set<string>
  ): Promise<ExportTarget[]> => {
    const key = `${file}\0${name}`
    if (chain.has(key)) return []
    const nextChain = new Set(chain).add(key)
    const parsed = readModule(file, cache)
    const targets: ExportTarget[] = []

    if (modifierExport(file, name, cache)) targets.push({ file, selection: { kind: 'execute' } })

    for (const statement of parsed.sourceFile.statements) {
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || !statement.moduleSpecifier)
        continue
      const specifier = ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined
      if (!specifier) continue

      if (!statement.exportClause) {
        if (name === 'default') continue
        if (specifier === 'lucide-solid') {
          targets.push({ file, selection: { kind: 'execute' } })
          continue
        }
        const resolved = await options.resolveId(specifier, file)
        if (resolved)
          targets.push(...(await resolveExportTargets(modulePath(resolved), name, nextChain)))
        else if (inside(file, uiSourceRoot))
          throw new Error(
            `[adea-ui-tailwind-sources] unable to resolve re-export '${specifier}' from ${file}`
          )
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        if (statement.exportClause.name.text === name) {
          if (specifier === 'lucide-solid') {
            targets.push({ file, selection: { kind: 'execute' } })
            continue
          }
          const resolved = await options.resolveId(specifier, file)
          if (resolved) targets.push({ file: modulePath(resolved), selection: { kind: 'all' } })
        }
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly || moduleExportName(element.name) !== name) continue
          const importedName = moduleExportName(element.propertyName ?? element.name)
          if (specifier === 'lucide-solid') {
            targets.push({ file, selection: { kind: 'execute' } })
            continue
          }
          const resolved = await options.resolveId(specifier, file)
          if (resolved)
            targets.push({
              file: modulePath(resolved),
              selection: { kind: 'named', names: [importedName] },
            })
          else if (inside(file, uiSourceRoot))
            throw new Error(
              `[adea-ui-tailwind-sources] unable to resolve re-export '${specifier}' from ${file}`
            )
        }
      }
    }

    for (const statement of parsed.sourceFile.statements) {
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || statement.moduleSpecifier)
        continue
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly || moduleExportName(element.name) !== name) continue
        const localName = moduleExportName(element.propertyName ?? element.name)
        const imported = await localRuntimeBinding(file, localName, cache)
        if (imported) {
          const resolved = await options.resolveId(imported.specifier, file)
          if (resolved) targets.push({ file: modulePath(resolved), selection: imported.selection })
          else if (inside(file, uiSourceRoot))
            throw new Error(
              `[adea-ui-tailwind-sources] unable to resolve local re-export '${imported.specifier}' from ${file}`
            )
        } else if (hasLocalRuntimeBinding(file, localName, cache)) {
          targets.push({ file, selection: { kind: 'execute' } })
        }
      }
    }

    if (name === 'default') {
      for (const statement of parsed.sourceFile.statements) {
        if (!ts.isExportAssignment(statement)) continue
        if (statement.isExportEquals) {
          targets.push({ file, selection: { kind: 'execute' } })
        } else if (ts.isIdentifier(statement.expression)) {
          const imported = await localRuntimeBinding(file, statement.expression.text, cache)
          if (imported) {
            const resolved = await options.resolveId(imported.specifier, file)
            if (resolved)
              targets.push({ file: modulePath(resolved), selection: imported.selection })
          } else {
            targets.push({ file, selection: { kind: 'execute' } })
          }
        } else {
          targets.push({ file, selection: { kind: 'execute' } })
        }
      }
    }

    return deduplicateTargets(targets)
  }

  const runtimeExportNames = async (file: string, chain: Set<string>): Promise<string[]> => {
    if (chain.has(file)) return []
    const nextChain = new Set(chain).add(file)
    const parsed = readModule(file, cache)
    const names = new Set(parsed.sourceFile.statements.flatMap(exportedNames))
    for (const statement of parsed.sourceFile.statements) {
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue
      if (!statement.moduleSpecifier) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            if (!element.isTypeOnly) names.add(moduleExportName(element.name))
          }
        }
        continue
      }
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
      if (statement.moduleSpecifier.text === 'lucide-solid' && !statement.exportClause) {
        continue
      }
      const resolved = await options.resolveId(statement.moduleSpecifier.text, file)
      if (!resolved) {
        if (inside(file, uiSourceRoot))
          throw new Error(
            `[adea-ui-tailwind-sources] unable to resolve re-export '${statement.moduleSpecifier.text}' from ${file}`
          )
        continue
      }
      if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
        names.add(statement.exportClause.name.text)
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (!element.isTypeOnly) names.add(moduleExportName(element.name))
        }
      } else if (!statement.exportClause) {
        for (const name of await runtimeExportNames(modulePath(resolved), nextChain)) {
          if (name !== 'default') names.add(name)
        }
      }
    }
    return [...names].toSorted()
  }

  const visit = async (path: string, selection: Selection): Promise<void> => {
    const file = modulePath(path)
    if (!isCodeFile(file)) return
    if (!inside(file, uiSourceRoot) && !isWorkspaceSourceFile(file, repositoryRoot)) return
    const key = `${file}\0${selection.kind === 'named' ? selection.names.join(',') : selection.kind}`
    if (visited.has(key)) return
    visited.add(key)
    const parsed = readModule(file, cache)
    const isUiSource = inside(file, uiSourceRoot)
    if (isUiSource) files.add(file)

    const moduleImports = runtimeImports(parsed)
    // Follow all runtime imports of every visited module. Even when a module
    // is reached through a side-effect import, its own imports may execute
    // setup code or register UI components needed by the consumer.
    for (const dependency of moduleImports) {
      await resolveImport(dependency.specifier, file, dependency.selection)
    }

    if (selection.kind === 'execute' || selection.kind === 'side-effect') return
    const names =
      selection.kind === 'named' ? selection.names : await runtimeExportNames(file, new Set())
    for (const name of names) {
      const targets = await resolveExportTargets(file, name, new Set())
      if (!targets.length) {
        throw new Error(
          `[adea-ui-tailwind-sources] unable to resolve runtime export '${name}' from ${file}`
        )
      }
      for (const target of targets) await visit(target.file, target.selection)
    }
  }

  for (const entrypoint of entrypoints) await visit(entrypoint, { kind: 'execute' })
  if (files.size === 0)
    throw new Error(
      `[adea-ui-tailwind-sources] the client import graph resolved no shared UI source files from ${entrypoints.join(', ')}; package imports: ${publishedUiResolutions.slice(0, 8).join('; ') || '(none)'}`
    )
  return {
    uiSourceFiles: [...files].toSorted(),
    devLucideImports:
      options.includeDevLucideImports === false
        ? []
        : await collectDevLucideImports({
            entrypoints,
            repositoryRoot,
            uiSourceRoot,
            resolveId: options.resolveId,
            cache,
          }),
  }
}

export async function collectUiSourceFiles(options: SourceDiscoveryOptions): Promise<string[]> {
  return (await collectUiSourceGraph({ ...options, includeDevLucideImports: false })).uiSourceFiles
}

function deduplicateTargets(targets: ExportTarget[]): ExportTarget[] {
  const unique = new Map<string, ExportTarget>()
  for (const target of targets) {
    const key = `${target.file}\0${target.selection.kind === 'named' ? target.selection.names.join(',') : target.selection.kind}`
    unique.set(key, target)
  }
  return [...unique.values()]
}

export function formatUiSourceDirectives(options: SourceDirectiveOptions): string {
  const packageRoot = realpathSync(options.uiPackageRoot)
  const stylesheetDirectory = dirname(resolve(options.stylesheetPath))
  const sources = options.files
    .map((path) => realpathSync(path))
    .toSorted()
    .map((file) => {
      if (!inside(file, packageRoot))
        throw new Error(`[adea-ui-tailwind-sources] source is outside published package: ${file}`)
      const stableFile = resolve(options.stablePackagePath, relative(packageRoot, file))
      const relativePath = relative(stylesheetDirectory, stableFile).replaceAll('\\', '/')
      if (isAbsolute(relativePath))
        throw new Error(
          `[adea-ui-tailwind-sources] generated source path is not portable: ${relativePath}`
        )
      return `@source '${relativePath}';`
    })
  return `${sources.join('\n')}\n`
}

export function renderedUiSourcePaths(renderedModules: string[]): string[] {
  const prefix = '<dependencies>/@adea-ai/ui/'
  return renderedModules
    .filter((id) => id.startsWith(`${prefix}src/`))
    .map((id) => id.slice(prefix.length))
    .toSorted()
}

export function missingRenderedUiSourcePaths(
  renderedModules: string[],
  generatedSources: string[]
): string[] {
  const sources = new Set(generatedSources)
  return renderedUiSourcePaths(renderedModules).filter((path) => !sources.has(path))
}

function writeIfChanged(path: string, content: string) {
  let current: string | undefined
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    // The first invocation creates the ignored generated file.
  }
  if (current === content) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

interface UiSourcePluginOptions {
  checkLucideDevShim?: boolean
}

function uiSourcePlugin(webRoot: string, options: UiSourcePluginOptions): Plugin {
  let uiRoot = ''
  let uiSourceRoot = ''
  let repositoryRoot = ''
  let stablePackagePath = ''
  let shimPath = ''
  let checkLucideDevShim = false
  let generatedFiles: string[] = []

  return {
    name: 'adea-selective-ui-tailwind-sources',
    enforce: 'pre',
    async configResolved(config: ResolvedConfig) {
      const entrypoints = [
        resolve(webRoot, 'src/start/client.tsx'),
        // TanStack Start injects the router through StartClient's runtime; it
        // is not a source import from client.tsx, so include its real app entry.
        resolve(webRoot, 'src/start/router.tsx'),
      ]
      repositoryRoot = realpathSync(resolve(webRoot, '../..'))
      checkLucideDevShim = options.checkLucideDevShim === true && config.command === 'serve'
      const resolver = config.createResolver()
      const manifest = await resolver('@adea-ai/ui/package.json', entrypoints[0], false, false)
      if (!manifest)
        throw new Error('[adea-ui-tailwind-sources] unable to resolve @adea-ai/ui/package.json')
      uiRoot = realpathSync(dirname(modulePath(manifest)))
      uiSourceRoot = realpathSync(resolve(uiRoot, 'src'))
      stablePackagePath = resolve(webRoot, 'node_modules/@adea-ai/ui')
      shimPath = resolve(webRoot, 'start/lucide-solid-dev-shim.jsx')
      // A fresh hoisted install may not materialise apps/web/node_modules at
      // all, while the generated directives and Tailwind's scan reference the
      // package through this stable path — materialise the link instead of
      // failing the build on the install layout.
      if (!existsSync(dirname(stablePackagePath)))
        mkdirSync(dirname(stablePackagePath), { recursive: true })
      if (!existsSync(stablePackagePath)) symlinkSync(uiRoot, stablePackagePath, 'dir')
      if (realpathSync(stablePackagePath) !== uiRoot) {
        throw new Error(
          `[adea-ui-tailwind-sources] stable package link ${stablePackagePath} does not resolve to ${uiRoot}`
        )
      }

      const stylesheetPath = resolve(webRoot, 'node_modules/.cache/adea-ui-tailwind-sources.css')
      const manifestPath = resolve(webRoot, 'node_modules/.cache/adea-ui-tailwind-sources.json')
      const graph = await collectUiSourceGraph({
        entrypoint: entrypoints,
        repositoryRoot,
        uiPackageRoot: uiRoot,
        uiSourceRoot,
        includeDevLucideImports: checkLucideDevShim,
        resolveId: (specifier, importer) => resolver(specifier, importer, false, false),
      })
      generatedFiles = graph.uiSourceFiles
      if (checkLucideDevShim)
        assertLucideDevShimCoverage(
          graph.devLucideImports,
          readFileSync(shimPath, 'utf8'),
          repositoryRoot
        )
      const directives = formatUiSourceDirectives({
        files: generatedFiles,
        uiPackageRoot: uiRoot,
        stablePackagePath,
        stylesheetPath,
      })
      const packageRelativePaths = generatedFiles
        .map((file) => relative(uiRoot, file).replaceAll('\\', '/'))
        .toSorted()
      writeIfChanged(stylesheetPath, directives)
      writeIfChanged(manifestPath, `${JSON.stringify(packageRelativePaths, null, 2)}\n`)
    },
    configureServer(server) {
      server.watcher.add(resolve(webRoot, 'src'))
      server.watcher.add(resolve(webRoot, '../../packages'))
      if (checkLucideDevShim) server.watcher.add(shimPath)
    },
    async handleHotUpdate({ file, server }) {
      if (!generatedFiles.length || !isCodeFile(file)) return
      const before = generatedFiles
      const config = server.config
      const resolver = config.createResolver()
      const entrypoint = [
        resolve(webRoot, 'src/start/client.tsx'),
        resolve(webRoot, 'src/start/router.tsx'),
      ]
      const graph = await collectUiSourceGraph({
        entrypoint,
        repositoryRoot,
        uiPackageRoot: uiRoot,
        uiSourceRoot,
        includeDevLucideImports: checkLucideDevShim,
        resolveId: (specifier, importer) => resolver(specifier, importer, false, false),
      })
      if (checkLucideDevShim)
        assertLucideDevShimCoverage(
          graph.devLucideImports,
          readFileSync(shimPath, 'utf8'),
          repositoryRoot
        )
      const next = graph.uiSourceFiles
      const previousSources = formatUiSourceDirectives({
        files: before,
        uiPackageRoot: uiRoot,
        stablePackagePath,
        stylesheetPath: resolve(webRoot, 'node_modules/.cache/adea-ui-tailwind-sources.css'),
      })
      const nextSources = formatUiSourceDirectives({
        files: next,
        uiPackageRoot: uiRoot,
        stablePackagePath,
        stylesheetPath: resolve(webRoot, 'node_modules/.cache/adea-ui-tailwind-sources.css'),
      })
      if (previousSources === nextSources) return

      generatedFiles = next
      writeIfChanged(
        resolve(webRoot, 'node_modules/.cache/adea-ui-tailwind-sources.css'),
        nextSources
      )
      writeIfChanged(
        resolve(webRoot, 'node_modules/.cache/adea-ui-tailwind-sources.json'),
        `${JSON.stringify(next.map((sourcePath) => relative(uiRoot, sourcePath).replaceAll('\\', '/')).toSorted(), null, 2)}\n`
      )
      const styles = server.moduleGraph.getModulesByFile(resolve(webRoot, 'src/start/globals.css'))
      if (!styles) return
      for (const module of styles) server.moduleGraph.invalidateModule(module)
      return [...styles]
    },
  }
}

export function selectiveUiSourcePlugin(
  webRoot: string,
  options: UiSourcePluginOptions = {}
): Plugin {
  return uiSourcePlugin(webRoot, options)
}
