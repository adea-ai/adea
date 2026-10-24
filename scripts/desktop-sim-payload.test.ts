import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { inspectArchive, inspectClient, simPayloadOffenders } from './check-desktop-sim-payload.mjs'
import { packFromEnv, reportPackRefusal } from './pack-agent-sim.mjs'

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

test('refuses a moved .obj model wherever it lands, in either case', () => {
  // The repository asset boundary already forbids .obj everywhere, so a moved model is the same
  // offender inside the old engine prefix and outside it, in either case. Ordinary files whose
  // names merely contain "obj" stay ordinary.
  expect(
    simPayloadOffenders([
      'chair.obj',
      'assets/chair.obj',
      'assets/agent-sim/chair.obj',
      'CHAIR.OBJ',
      'models/Chair.Obj',
      'assets/app.js',
      'objects.json',
      'obj.js',
      'chair.obj.txt',
    ])
  ).toEqual([
    'chair.obj',
    'assets/chair.obj',
    'assets/agent-sim/chair.obj',
    'CHAIR.OBJ',
    'models/Chair.Obj',
  ])
})

test('a client that carries a moved .obj model is refused, in either case', async () => {
  const lower = await client()
  await writeFile(join(lower, 'chair.obj'), 'private')
  await expect(inspectClient(lower)).rejects.toThrow('Sim payload')

  const upper = await client()
  await writeFile(join(upper, 'CHAIR.OBJ'), 'private')
  await expect(inspectClient(upper)).rejects.toThrow('Sim payload')

  // The ordinary fixtures beside it are still ordinary.
  const ordinary = await client()
  await writeFile(join(ordinary, 'objects.json'), '{}')
  await writeFile(join(ordinary, 'obj.js'), '// ordinary')
  expect(await inspectClient(ordinary)).toMatchObject({ simPayloadFiles: 0 })
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

test('archive qualification checks the installed inner client and rejects stale payloads', async () => {
  const root = await client()
  const installed = join(root, 'Adea.app/Contents/Resources/app/client')
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'index.html'), '<main>Chat and Dev</main>')
  const archive = join(root, 'installed.tar.zst')
  const pack = () => {
    const result = spawnSync('tar', ['--zstd', '-cf', archive, '-C', root, 'Adea.app'])
    expect(result.status).toBe(0)
  }
  pack()
  expect(inspectArchive(archive)).toMatchObject({ simPayloadFiles: 0 })
  await mkdir(join(installed, 'assets/agent-sim'), { recursive: true })
  await writeFile(join(installed, 'assets/agent-sim/engine.js'), 'private')
  pack()
  expect(() => inspectArchive(archive)).toThrow('Sim payload')
  await rm(installed, { recursive: true })
  await mkdir(installed)
  pack()
  expect(() => inspectArchive(archive)).toThrow('missing client/index.html')
  await writeFile(archive, 'corrupt')
  expect(() => inspectArchive(archive)).toThrow('Could not list')
})

test('an installed archive that carries a moved .obj model is refused, in either case', async () => {
  const root = await client()
  const installed = join(root, 'Adea.app/Contents/Resources/app/client')
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'index.html'), '<main>Chat and Dev</main>')
  const archive = join(root, 'installed.tar.zst')
  const pack = () => {
    const result = spawnSync('tar', ['--zstd', '-cf', archive, '-C', root, 'Adea.app'])
    expect(result.status).toBe(0)
  }
  pack()
  expect(inspectArchive(archive)).toMatchObject({ simPayloadFiles: 0 })

  await writeFile(join(installed, 'chair.obj'), 'private')
  pack()
  expect(() => inspectArchive(archive)).toThrow('Sim payload')
  await rm(join(installed, 'chair.obj'))

  await writeFile(join(installed, 'CHAIR.OBJ'), 'private')
  pack()
  expect(() => inspectArchive(archive)).toThrow('Sim payload')
})

test('an incomplete client cannot count as a payload-free application', async () => {
  const root = await client()
  await rm(join(root, 'index.html'))
  await expect(inspectClient(root)).rejects.toThrow('missing index.html')
})

test('the legacy pack CLI reports refusal and fails without staging assets', async () => {
  const previousExitCode = process.exitCode
  const messages: unknown[] = []
  const error = spyOn(console, 'error').mockImplementation((message) => messages.push(message))
  try {
    await packFromEnv({ environment: { ADEA_AGENT_SIM_DIST: '/not/read' } }).catch(
      reportPackRefusal
    )
    expect(process.exitCode).toBe(1)
    expect(messages).toEqual([
      'Agent Sim is hosted separately; ADEA_AGENT_SIM_DIST is no longer a client build input.',
    ])
  } finally {
    error.mockRestore()
    // Bun retains the native exit status when undefined is restored directly.
    process.exitCode = 0
    process.exitCode = previousExitCode
  }
  const entry = fileURLToPath(new URL('./pack-agent-sim.mjs', import.meta.url))
  const refused = spawnSync(process.execPath, [entry], {
    encoding: 'utf8',
    env: { ...process.env, ADEA_AGENT_SIM_DIST: '/not/read' },
  })
  expect(refused.status).toBe(1)
  expect(refused.stderr).toContain('Agent Sim is hosted separately')
  const allowed = spawnSync(process.execPath, [entry], {
    encoding: 'utf8',
    env: { ...process.env, ADEA_AGENT_SIM_DIST: '' },
  })
  expect(allowed.status).toBe(0)
  expect(allowed.stdout).toContain('client assets contain scene manifests only')
})
