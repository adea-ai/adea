// Cloud-origin scan for the desktop shell.
//
// The desktop's core security invariant is that the app talks only to the
// exact cloud origin baked in at build time. Three places have to agree on it:
// the packaged CSP, the native authorization allowlist, and the browser-safe
// broker pinning. A fourth, stray `https://…` literal anywhere in the shell is
// a silent widening of that invariant, so this scanner fails the build on any
// origin that is not the canonical constant or an explicitly baselined
// exception. Test code and comment lines are out of scope.

import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** Files whose origin literals are part of the scan. */
const SCAN_ROOTS = ['apps/desktop/src-tauri', 'apps/desktop/src', 'apps/desktop/scripts']
const SCAN_EXTENSIONS = ['.rs', '.ts', '.tsx', '.mjs', '.js', '.json', '.html']
/** Build output and dependency trees never ship as source. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'target', 'gen', '.turbo'])

/** The canonical constant in native code. */
export const CLOUD_ORIGIN_SOURCE = 'apps/desktop/src-tauri/src/cloud.rs'
/** The canonical constant in the build wrapper that writes the packaged CSP. */
export const CLOUD_BUILD_SOURCE = 'apps/desktop/scripts/tauri-cloud-config.mjs'

const ORIGIN_LITERAL = /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?/g

/**
 * Origins that are allowed to appear literally, each with the reason it cannot
 * come from the canonical constant. Keep this list short: every entry is an
 * exception to the single-origin invariant.
 */
export const BASELINED_ORIGINS = [
  {
    origin: 'https://github.com',
    reason: 'signed desktop update release channel (tauri.conf.json updater endpoint)',
  },
  {
    origin: 'https://raw.githubusercontent.com',
    reason: 'marketplace plugin logo images (CSP img-src)',
  },
  {
    origin: 'https://cdn.simpleicons.org',
    reason: 'marketplace plugin logo images (CSP img-src)',
  },
  {
    origin: 'https://www.google.com',
    reason: 'marketplace favicon lookups (CSP img-src)',
  },
]

/** Read the canonical origin from the two places that must agree on it. */
export async function canonicalCloudOrigins(root) {
  const rust = await readFile(join(root, CLOUD_ORIGIN_SOURCE), 'utf8')
  const build = await readFile(join(root, CLOUD_BUILD_SOURCE), 'utf8')
  return {
    rust: /const\s+DEFAULT_CLOUD_ORIGIN:\s*&str\s*=\s*"([^"]+)"/.exec(rust)?.[1],
    build: /const\s+DEFAULT_CLOUD_ORIGIN\s*=\s*'([^']+)'/.exec(build)?.[1],
  }
}

function originOf(literal) {
  return new URL(literal).origin
}

/**
 * Origins that are not cloud origins at all: the loopback dev server and the
 * Tauri IPC channel. `normalizeDesktopCloudOrigin` permits loopback origins for
 * local development, and `tauri://localhost` / `http://ipc.localhost` are how
 * the packaged webview reaches its own embedded assets and IPC bridge. A JSON
 * `$schema` key is tooling metadata, not a request target.
 */
function isInfrastructureOrigin(origin) {
  const { hostname, protocol } = new URL(origin)
  return (
    protocol === 'http:' &&
    (hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '[::1]' ||
      hostname === 'ipc.localhost' ||
      hostname.endsWith('.localhost'))
  )
}

/**
 * Every origin literal in one source file that is not allowed. Pure, so the
 * gate's own behaviour is testable.
 */
export function scanSource(source, file, allowedOrigins) {
  const allowed = new Set(allowedOrigins.map((entry) => originOf(entry.origin)))
  const violations = []
  let inRustTestModule = false

  for (const [index, line] of source.split('\n').entries()) {
    // Rust unit tests deliberately name hostile origins to prove they are
    // rejected; they are not part of the shipped surface.
    if (file.endsWith('.rs')) {
      if (line.includes('#[cfg(test)]')) inRustTestModule = true
      if (inRustTestModule) continue
    }
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
      if (allowed.has(origin) || isInfrastructureOrigin(origin)) continue
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
export async function scanDesktopOrigins(root, allowedOrigins) {
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
      violations.push(
        ...scanSource(await readFile(path, 'utf8'), segments.join('/'), allowedOrigins)
      )
    }
  }
  return violations
}
