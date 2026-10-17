import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { inspectClient, simPayloadOffenders } from './check-desktop-sim-payload.mjs'
import { packFromEnv } from './pack-agent-sim.mjs'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function client() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-sim-boundary-'))
  roots.push(root)
  await writeFile(join(root, 'index.html'), '<main>Chat and Dev</main>')
  return root
}

test('measures a complete client and refuses a stale private pack', async () => {
  const root = await client()
  expect(await inspectClient(root)).toEqual({ files: 1, bytes: 25, simPayloadFiles: 0 })
  await mkdir(join(root, 'assets/agent-sim'), { recursive: true })
  await writeFile(join(root, 'assets/agent-sim/engine.js'), 'private')
  await expect(inspectClient(root)).rejects.toThrow('Sim payload')
})

test('refuses binaries even when moved out of the former engine prefix', () => {
  expect(
    simPayloadOffenders([
      'assets/x.glb',
      'assets/x.KTX2',
      'assets/basis_transcoder.wasm',
      'assets/app.js',
    ])
  ).toEqual(['assets/x.glb', 'assets/x.KTX2', 'assets/basis_transcoder.wasm'])
})

test('refuses symlinks that could conceal payload outside the inspected tree', async () => {
  const root = await client()
  await symlink(join(root, 'index.html'), join(root, 'linked'))
  await expect(inspectClient(root)).rejects.toThrow('symlinks')
})

test('old pack configuration fails without reading or staging private files', async () => {
  await expect(
    packFromEnv({ environment: { ADEA_AGENT_SIM_DIST: '/not/read' }, log() {} })
  ).rejects.toThrow('hosted separately')
  expect(await packFromEnv({ environment: {}, log() {} })).toBe(false)
})

test('CLI invoked through an absolute symlink cannot skip private-payload rejection', async () => {
  const root = await client()
  await writeFile(join(root, 'engine.js'), 'private')
  const entry = join(await client(), 'checker.mjs')
  await symlink(fileURLToPath(new URL('./check-desktop-sim-payload.mjs', import.meta.url)), entry)
  const result = spawnSync('node', [entry, '--client', root], { encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Sim payload')
})
