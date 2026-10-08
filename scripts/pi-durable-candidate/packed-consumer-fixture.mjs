/** Install actual local candidate packs into a disposable consumer; never alters repository pins. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const sdkNames = new Set(['@adea-ai/sdk', '@adea-ai/contracts', '@adea-ai/runtime-sdk'])

export async function createPackedConsumerFixture(manifestPath, kind) {
  if (!['model', 'lead'].includes(kind)) throw new Error('Unknown candidate consumer')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!['local-candidate/v1', 'pi-durable-candidate-artifacts/v1'].includes(manifest.schemaVersion))
    throw new Error('Unsupported candidate artifact manifest')
  const artifacts = manifest.packages ?? manifest.artifacts
  if (!Array.isArray(artifacts) || artifacts.length < 2)
    throw new Error('Missing actual SDK/contracts packs')
  const dependencies = {}
  const hashes = []
  for (const item of artifacts) {
    if (!sdkNames.has(item.name) || dependencies[item.name] || !/^[a-f0-9]{64}$/.test(item.sha256))
      throw new Error('Invalid candidate package identity')
    const archive = item.filename ?? item.archive
    if (typeof archive !== 'string' || archive !== archive.split(/[\\/]/).pop())
      throw new Error('Candidate archive must be a manifest-local filename')
    const path = resolve(dirname(manifestPath), archive)
    const sha256 = createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
    if (sha256 !== item.sha256) throw new Error('Candidate package digest mismatch')
    dependencies[item.name] = `file:${path}`
    hashes.push({ name: item.name, version: item.version, sha256 })
  }
  if (!dependencies['@adea-ai/sdk'] || !dependencies['@adea-ai/contracts'])
    throw new Error('Actual SDK and contracts packs are required')
  const directory = await mkdtemp(join(tmpdir(), 'adea-packed-consumer-'))
  try {
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify(
        {
          name: 'adea-candidate-consumer-fixture',
          private: true,
          type: 'module',
          dependencies,
          overrides: dependencies,
        },
        null,
        2
      )
    )
    execFileSync('bun', ['install', '--ignore-scripts'], { cwd: directory, stdio: 'pipe' })
    const files =
      kind === 'model'
        ? ['model-connections-consumer.ts', 'model-connections-consumer.test.ts']
        : ['lead-dispatch-consumer.ts', 'lead-dispatch-consumer.test.ts']
    const consumerRoot = join(directory, 'scripts/pi-durable-candidate')
    await mkdir(consumerRoot, { recursive: true })
    for (const file of files) await cp(join(root, file), join(consumerRoot, file))
    const readinessTarget = join(directory, 'apps/web/src/server')
    await mkdir(readinessTarget, { recursive: true })
    await cp(
      resolve(root, '../../apps/web/src/server/model-selection-readiness.ts'),
      join(readinessTarget, 'model-selection-readiness.ts')
    )
    const repo = resolve(root, '../..')
    const consumer =
      kind === 'model' ? 'model-connections-consumer.ts' : 'lead-dispatch-consumer.ts'
    await writeFile(
      join(directory, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2023',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            noEmit: true,
            strict: true,
            skipLibCheck: true,
            allowImportingTsExtensions: true,
            types: ['node'],
            typeRoots: [join(repo, 'apps/web/node_modules/@types')],
            lib: ['ES2023', 'DOM'],
          },
          include: [
            `scripts/pi-durable-candidate/${consumer}`,
            'apps/web/src/server/model-selection-readiness.ts',
          ],
        },
        null,
        2
      )
    )
    execFileSync(join(repo, 'node_modules/.bin/tsc'), ['-p', join(directory, 'tsconfig.json')], {
      cwd: directory,
      stdio: 'pipe',
    })
    execFileSync('bun', ['test', join(consumerRoot, consumer.replace('.ts', '.test.ts'))], {
      cwd: directory,
      stdio: 'pipe',
    })
    const entry = await import(pathToFileURL(join(consumerRoot, consumer)).href)
    return {
      entry,
      hashes,
      source: {
        head: manifest.head ?? manifest.baseCommit,
        tree: manifest.sourceTree,
        digest: manifest.sourceDigest,
      },
      close: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
