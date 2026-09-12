// Docs lint: the specs stay reachable, linked, and listed.
//
// Per-module specs only stay useful if nothing can quietly orphan them: a moved
// file leaves dead links, and a spec nobody is routed to is a page that silently
// rots. This check keeps three promises:
//
// 1. every relative link between tracked docs resolves to a file,
// 2. the spec directory has no orphan (every spec is listed in the AGENTS.md
//    router table), and
// 3. every spec the router names exists.
//
// `scripts/docs-boundary.test.ts` runs it in the validation lane.

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** Docs the check reads: the router plus every markdown file it indexes. */
export const DOC_ROOTS = ['docs', 'README.md', 'apps/desktop/README.md', '.github/CONTRIBUTING.md']
export const SPEC_DIRECTORY = 'docs/specs'
export const ROUTER = 'AGENTS.md'

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/g

async function markdownFiles(root, directory) {
  const files = []
  const entries = await readdir(join(root, directory), { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(root, path)))
    } else if (entry.name.endsWith('.md')) {
      files.push(path.split(sep).join('/'))
    }
  }
  return files
}

function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')
}

/** Every relative link target that does not resolve to a file. */
export async function brokenLinks(root) {
  const broken = []
  for (const docRoot of DOC_ROOTS) {
    const files = docRoot.endsWith('.md') ? [docRoot] : await markdownFiles(root, docRoot)
    for (const file of files) {
      const source = await readFile(join(root, file), 'utf8')
      for (const match of source.matchAll(MARKDOWN_LINK)) {
        const target = match[1].trim()
        if (isExternal(target)) continue
        const path = target.split('#')[0]
        if (path.length === 0) continue
        const resolved = resolve(join(root, dirname(file)), path)
        try {
          await readFile(resolved)
        } catch {
          broken.push({ file, target })
        }
      }
    }
  }
  return broken
}

/** The spec files on disk and the spec paths the router table names. */
export async function specCoverage(root) {
  const specs = (await markdownFiles(root, SPEC_DIRECTORY)).sort()
  const router = await readFile(join(root, ROUTER), 'utf8')
  const routed = [...router.matchAll(/docs\/specs\/[a-z0-9-]+\.md/g)].map((match) => match[0])
  const unique = [...new Set(routed)].sort()

  return {
    orphaned: specs.filter((spec) => !unique.includes(spec)),
    missing: unique.filter((spec) => !specs.includes(spec)),
  }
}

/** Every markdown document that the specs or the router point at, for context. */
export function documentPath(file) {
  return relative(process.cwd(), file)
}
