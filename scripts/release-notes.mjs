#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export function extractReleaseNotes(changelog, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Release version must be an exact semantic version: ${version}`)
  }

  const lines = changelog.split(/\r?\n/)
  const heading = `## [${version}]`
  const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading}(`))
  if (start === -1) throw new Error(`Release notes are missing for ${version}`)

  const next = lines.findIndex((line, index) => index > start && line.startsWith('## ['))
  const section = lines
    .slice(start, next === -1 ? undefined : next)
    .join('\n')
    .trimEnd()
  if (!section) throw new Error(`Release notes are empty for ${version}`)
  return `${section}\n`
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const version = process.argv[2]
  if (!version) throw new Error('Usage: release-notes.mjs <version> [changelog]')
  const changelogPath = resolve(process.argv[3] ?? 'CHANGELOG.md')
  process.stdout.write(extractReleaseNotes(readFileSync(changelogPath, 'utf8'), version))
}
