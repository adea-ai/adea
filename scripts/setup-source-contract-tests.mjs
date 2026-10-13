import { createHash } from 'node:crypto'
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const fixture = new URL('../apps/web/test/fixtures/source-contracts/', import.meta.url)
const commit = '6c296fbe561b755bda0fa87f7e1a05ab451bc2f7'
const setupCommand = 'bun scripts/setup-source-contract-tests.mjs'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function verifySourceContractFixture({ requireDependency = true } = {}) {
  const manifest = JSON.parse(readFileSync(new URL('provenance.json', fixture), 'utf8'))
  if (
    manifest.repository !== 'https://github.com/adea-ai/control-plane.git' ||
    manifest.commit !== commit ||
    manifest.zodVersion !== '4.6.5' ||
    Object.keys(manifest.sourceFiles).length !== 9
  )
    throw new Error('Source contract fixture provenance does not match the immutable pin')
  for (const [name, source] of Object.entries(manifest.sourceFiles)) {
    if (
      !/^[a-z-]+\.ts$/.test(name) ||
      source.path !== `packages/contracts/src/${name}` ||
      hash(readFileSync(new URL(`source/${name}.snapshot`, fixture))) !== source.sha256
    )
      throw new Error(`Immutable source contract fixture mismatch: ${name}`)
  }
  for (const [name, expected] of Object.entries(manifest.setupFiles)) {
    if (
      !['index.ts', 'package.json', 'bun.lock'].includes(name) ||
      hash(readFileSync(new URL(name, fixture))) !== expected
    )
      throw new Error(`Source contract fixture setup mismatch: ${name}`)
  }
  if (hash(readFileSync(new URL('LICENSE', fixture))) !== manifest.licenseSha256)
    throw new Error('Source contract fixture license mismatch')
  const packagePath = new URL('node_modules/zod/package.json', fixture)
  const installed =
    existsSync(packagePath) &&
    JSON.parse(readFileSync(packagePath, 'utf8')).version === manifest.zodVersion
  if (requireDependency && !installed)
    throw new Error(`Pinned source contract fixture dependency is missing. Run: ${setupCommand}`)
  if (requireDependency) {
    const generated = [
      ...Object.entries(manifest.sourceFiles).map(([name, source]) => [name, source.sha256]),
      ['index.ts', manifest.setupFiles['index.ts']],
    ]
    for (const [name, expected] of generated) {
      const path = new URL(`.runtime/${name}`, fixture)
      if (!existsSync(path) || hash(readFileSync(path)) !== expected)
        throw new Error(
          `Pinned source contract runtime is missing or changed. Run: ${setupCommand}`
        )
    }
  }
  return installed
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--verify-only'))
    throw new Error('Unknown source contract setup argument')
  if (!verifySourceContractFixture({ requireDependency: false }) && !args.includes('--verify-only'))
    execFileSync(
      'bun',
      ['install', '--cwd', fileURLToPath(fixture), '--frozen-lockfile', '--ignore-scripts'],
      { stdio: 'inherit' }
    )
  if (!args.includes('--verify-only')) {
    const manifest = JSON.parse(readFileSync(new URL('provenance.json', fixture), 'utf8'))
    mkdirSync(new URL('.runtime/', fixture), { recursive: true })
    for (const name of Object.keys(manifest.sourceFiles))
      copyFileSync(
        new URL(`source/${name}.snapshot`, fixture),
        new URL(`.runtime/${name}`, fixture)
      )
    copyFileSync(new URL('index.ts', fixture), new URL('.runtime/index.ts', fixture))
  }
  verifySourceContractFixture()
  console.log(`Source contract tests ready at immutable CP ${commit} (Zod 4.6.5)`)
}
