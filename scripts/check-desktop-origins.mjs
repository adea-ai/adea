// Cloud-origin scan for the desktop shell.
//
// The desktop's core security invariant is that the app talks only to the
// exact cloud origin baked in at build time. One JavaScript module owns the
// literal (`apps/desktop/scripts/cloud-config.mjs`); the client build injects it
// through `__ADEA_CLOUD_ORIGIN__`, and the shell never restates it. Any other
// `https://…` literal in the scanned trees is a silent widening of that
// invariant, so this scanner fails the build on every origin that is not the
// owning module's canonical constant or an explicitly baselined exception. Test
// code and comment lines are out of scope.

import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative, resolve, sep } from 'node:path'

/** Files whose origin literals are part of the scan. */
const SCAN_ROOTS = ['apps/desktop/shell', 'apps/desktop/src', 'apps/desktop/scripts']
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '.json', '.html']
/** Build output and dependency trees never ship as source. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.turbo'])

/** The one module allowed to name the canonical cloud origin. */
export const CLOUD_ORIGIN_SOURCE = 'apps/desktop/scripts/cloud-config.mjs'

const ORIGIN_LITERAL = /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?/g

/**
 * Origins that are allowed to appear literally outside the owning module, each
 * with the reason it cannot come from the canonical constant. Keep this list
 * short: every entry is an exception to the single-origin invariant.
 */
export const BASELINED_ORIGINS = []

/** Read the canonical origin from the module that owns it. */
export async function canonicalCloudOrigin(root) {
  const source = await readFile(join(root, CLOUD_ORIGIN_SOURCE), 'utf8')
  return /const\s+DEFAULT_CLOUD_ORIGIN\s*=\s*'([^']+)'/.exec(source)?.[1]
}

function originOf(literal) {
  return new URL(literal).origin
}

/**
 * Origins that are not cloud origins at all: the shell's own loopback server
 * and the loopback development server the client is built against.
 */
export function isLoopbackOrigin(origin) {
  const { hostname, protocol } = new URL(origin)
  return (
    protocol === 'http:' &&
    (hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '[::1]' ||
      hostname.endsWith('.localhost'))
  )
}

/**
 * The allowlist that applies to one scanned file. The canonical cloud origin is
 * only allowed where it is defined; every other file has to import it.
 */
export function allowedOriginsFor(file, canonical) {
  if (file === CLOUD_ORIGIN_SOURCE) {
    return [
      {
        origin: canonical,
        reason: 'the canonical cloud origin, defined in this module',
      },
      ...BASELINED_ORIGINS,
    ]
  }
  return [...BASELINED_ORIGINS]
}

/**
 * Every origin literal in one source file that is not allowed. Pure, so the
 * gate's own behaviour is testable.
 */
export function scanSource(source, file, allowedOrigins) {
  const allowed = new Set(allowedOrigins.map((entry) => originOf(entry.origin)))
  const violations = []

  for (const [index, line] of source.split('\n').entries()) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    if (trimmed.startsWith('"$schema"')) continue

    for (const literal of line.match(ORIGIN_LITERAL) ?? []) {
      let origin
      try {
        origin = originOf(literal)
      } catch {
        continue
      }
      if (allowed.has(origin) || isLoopbackOrigin(origin)) continue
      violations.push({ file, line: index + 1, origin, literal: literal.trim() })
    }
  }
  return violations
}

async function* sourceFiles(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      yield* sourceFiles(path)
      continue
    }
    if (entry.isFile() && SCAN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      yield path
    }
  }
}

/** Scan the desktop shell for origin literals outside the allowlist. */
export async function scanDesktopOrigins(root, canonical) {
  const violations = []
  for (const scanRoot of SCAN_ROOTS) {
    for await (const path of sourceFiles(join(root, scanRoot))) {
      // Test files and fixtures name hostile origins on purpose.
      const segments = relative(root, path).split(sep)
      const name = segments.at(-1) ?? ''
      if (
        segments.includes('tests') ||
        /\.test\.[cm]?[jt]sx?$/.test(name) ||
        /\.spec\.[cm]?[jt]sx?$/.test(name)
      ) {
        continue
      }
      const file = segments.join('/')
      violations.push(
        ...scanSource(await readFile(path, 'utf8'), file, allowedOriginsFor(file, canonical))
      )
    }
  }
  return violations
}

// `node scripts/check-desktop-origins.mjs` runs the scan; importing the module
// from the boundary gate only reads its exports.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(import.meta.url), '../..')
  const canonical = await canonicalCloudOrigin(root)
  const violations = await scanDesktopOrigins(root, canonical)
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.file}:${violation.line} ${violation.literal}`)
    }
    console.error(`check-desktop-origins: ${violations.length} origin violation(s)`)
    process.exit(1)
  }
  console.log(`check-desktop-origins: ok (canonical origin ${canonical})`)
}
