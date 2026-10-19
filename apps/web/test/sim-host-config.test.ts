import { expect, test } from 'bun:test'
import { createSimHostConfiguration } from '../src/server/sim-host-config'
import { createSimHost } from '../src/server/sim-host'

const origin = 'https://sim.example'
const parent = 'https://app.example'
const entryFiles = {
  hq: 'engine.js',
  'room-designer': 'room-designer.js',
  'character-designer': 'character-designer.js',
}
const valid = { origin, parentOrigins: [parent], assetPrefix: '/assets/agent-sim/', entryFiles }

test('a complete configuration validates and comes back frozen with canonical values', () => {
  const config = createSimHostConfiguration(valid)
  expect(config).toEqual({
    origin,
    parentOrigins: [parent],
    allowLoopbackHttp: false,
    assetPrefix: '/assets/agent-sim/',
    entryFiles,
  })
  expect(Object.isFrozen(config)).toBe(true)
  expect(Object.isFrozen(config.parentOrigins)).toBe(true)
  expect(Object.isFrozen(config.entryFiles)).toBe(true)
  expect(() => {
    ;(config as { origin: string }).origin = 'https://other.example'
  }).toThrow()
})

test('a missing or non-object configuration fails closed', () => {
  for (const value of [undefined, null, 'https://sim.example', 42])
    expect(() => createSimHostConfiguration(value)).toThrow('configuration object')
})

test('origins must be exact canonical origins, not paths, trailing slashes or plain HTTP', () => {
  for (const bad of [
    undefined,
    '',
    'https://sim.example/',
    'https://sim.example/path',
    'http://sim.example',
    'https://user@sim.example',
  ])
    expect(() => createSimHostConfiguration({ ...valid, origin: bad })).toThrow(
      'distinct canonical frame and parent origins'
    )
  for (const bad of ['https://app.example/', 'http://app.example'])
    expect(() => createSimHostConfiguration({ ...valid, parentOrigins: [bad] })).toThrow(
      'distinct canonical frame and parent origins'
    )
})

test('loopback HTTP is accepted only when the acceptance allowance is set explicitly', () => {
  const loopback = {
    ...valid,
    origin: 'http://127.0.0.1:4100',
    parentOrigins: ['http://localhost:3000'],
  }
  expect(() => createSimHostConfiguration(loopback)).toThrow('distinct canonical frame and parent')
  expect(createSimHostConfiguration({ ...loopback, allowLoopbackHttp: true })).toMatchObject({
    origin: 'http://127.0.0.1:4100',
    allowLoopbackHttp: true,
  })
  expect(() => createSimHostConfiguration({ ...loopback, allowLoopbackHttp: 'yes' })).toThrow(
    'must be a boolean'
  )
})

test('the frame and the parents need an exact, non-empty, distinct set of origins on separate cookie hosts', () => {
  expect(() => createSimHostConfiguration({ ...valid, parentOrigins: [] })).toThrow(
    'at least one parent origin'
  )
  expect(() => createSimHostConfiguration({ ...valid, parentOrigins: [origin] })).toThrow(
    'distinct canonical frame and parent origins'
  )
  // A parent on the frame's own host shares its cookie scope, whatever its port.
  expect(() =>
    createSimHostConfiguration({ ...valid, parentOrigins: ['https://sim.example:8443'] })
  ).toThrow('separate cookie host')
  expect(() => createSimHostConfiguration({ ...valid, parentOrigins: [parent, parent] })).toThrow(
    'must be distinct'
  )
  expect(() =>
    createSimHostConfiguration({ ...valid, parentOrigins: [parent, 'https://other.example'] })
  ).not.toThrow()
  expect(() =>
    createSimHostConfiguration({ ...valid, parentOrigins: [parent, 'https://app.example:8443'] })
  ).not.toThrow()
})

test('the asset prefix must be a plain nested path that ends in a slash', () => {
  for (const bad of [
    undefined,
    '',
    '/',
    'assets/agent-sim/',
    '/assets/agent-sim',
    '/assets/../x/',
    '/Assets/',
    '/a b/',
    '/assets//x/',
    '/a/b/c/d/e/',
  ])
    expect(() => createSimHostConfiguration({ ...valid, assetPrefix: bad })).toThrow('assetPrefix')
  expect(createSimHostConfiguration({ ...valid, assetPrefix: '/private/sim/' }).assetPrefix).toBe(
    '/private/sim/'
  )
})

test('entry files are plain .js names, one per surface, and the surface set is fixed', () => {
  const surfaces = (value: object) => () =>
    createSimHostConfiguration({ ...valid, entryFiles: value })
  expect(surfaces({ ...entryFiles, hq: undefined })).toThrow('must be a plain .js file name')
  expect(surfaces({ ...entryFiles, 'room-designer': '../room.js' })).toThrow('plain .js file name')
  expect(surfaces({ ...entryFiles, 'room-designer': 'room.css' })).toThrow('plain .js file name')
  expect(surfaces({ hq: 'a.js', 'room-designer': 'b.js' })).toThrow(
    'missing the character-designer surface'
  )
  expect(surfaces({ ...entryFiles, 'settings-designer': 'x.js' })).toThrow('unknown surface')
  expect(surfaces({ ...entryFiles, 'character-designer': 'engine.js' })).toThrow('must be distinct')
  expect(() => createSimHostConfiguration({ ...valid, entryFiles: undefined })).toThrow(
    'needs entryFiles'
  )
  const renamed = createSimHostConfiguration({
    ...valid,
    entryFiles: { hq: 'hq-1.js', 'room-designer': 'rd-1.js', 'character-designer': 'cd-1.js' },
  })
  expect(renamed.entryFiles.hq).toBe('hq-1.js')
})

test('createSimHost refuses to start without a valid configuration or a frame script', () => {
  const dependencies = {
    frameScript: '// bootstrap',
    exchange: async () => ({ body: { status: 'unavailable' } }) as never,
    session: async () => null,
    readAsset: async () => null,
  }
  expect(() => createSimHost({ ...dependencies, ...valid, parentOrigins: [] })).toThrow(
    'at least one parent origin'
  )
  expect(() =>
    createSimHost({ ...dependencies, ...valid, assetPrefix: undefined as never })
  ).toThrow('assetPrefix')
  expect(() =>
    createSimHost({ ...dependencies, ...valid, frameScript: undefined as unknown as string })
  ).toThrow('needs a frame script')
  expect(() => createSimHost({ ...dependencies, ...valid })).not.toThrow()
})

test('a configured prefix and renamed entries are the only paths served privately, with the surface still bound', async () => {
  const now = 1_000
  const sessions = new Map([
    ['s'.repeat(40), { surface: 'room-designer', expiresAt: now + 60_000 }],
  ] as const)
  const served: string[] = []
  const host = createSimHost({
    origin,
    parentOrigins: [parent],
    assetPrefix: '/private/sim/',
    entryFiles: { hq: 'hq-1.js', 'room-designer': 'rd-1.js', 'character-designer': 'cd-1.js' },
    frameScript: '// bootstrap',
    exchange: async () => ({ body: { status: 'unavailable' } }) as never,
    session: async (value) => (sessions.get(value) as never) ?? null,
    now: () => now,
    readAsset: async (path) => {
      served.push(path)
      return { body: `asset:${path}`, contentType: 'text/javascript' }
    },
  })
  const cookie = `__Host-adea-sim=${'s'.repeat(40)}`
  const get = (path: string) => host(new Request(`${origin}${path}`, { headers: { cookie } }))

  // The public contract carries the configured prefix and names, so the frame bootstrap reads the same values.
  expect(await (await host(new Request(`${origin}/configuration`))).json()).toMatchObject({
    assetPrefix: '/private/sim/',
    entryFiles: { hq: 'hq-1.js', 'room-designer': 'rd-1.js', 'character-designer': 'cd-1.js' },
  })
  expect((await get('/private/sim/rd-1.js')).status).toBe(200)
  expect((await get('/private/sim/hq-1.js')).status).toBe(403)
  expect((await get('/assets/agent-sim/rd-1.js')).status).toBe(404)
  expect((await get('/private/sim/rd-1.js')).headers.get('cache-control')).toBe('private, no-store')
  // Only the configured room-designer entry was ever read from private storage; the rejected hq read never reached it.
  expect(served.length).toBeGreaterThan(0)
  expect(served.every((path) => path === 'rd-1.js')).toBe(true)
  // The renamed entries' old names still exist in private storage in this fixture; they stay unreachable for every session.
  expect((await get('/private/sim/engine.js')).status).toBe(404)
  expect((await get('/private/sim/room-designer.js')).status).toBe(404)
  expect((await get('/private/sim/character-designer.js')).status).toBe(404)
  expect((await host(new Request(`${origin}/private/sim/rd-1.js`))).status).toBe(401)
  expect(
    (await host(new Request(`${origin}/configuration`))).headers.get('content-security-policy')
  ).toContain(`frame-ancestors ${parent}`)
})

test('an unrenamed entry keeps its own surface binding and is not treated as retired', async () => {
  const now = 1_000
  const sessions = new Map([
    ['t'.repeat(40), { surface: 'room-designer', expiresAt: now + 60_000 }],
  ] as const)
  const host = createSimHost({
    origin,
    parentOrigins: [parent],
    assetPrefix: '/assets/agent-sim/',
    entryFiles,
    frameScript: '// bootstrap',
    exchange: async () => ({ body: { status: 'unavailable' } }) as never,
    session: async (value) => (sessions.get(value) as never) ?? null,
    now: () => now,
    readAsset: async (path) => ({ body: `asset:${path}`, contentType: 'text/javascript' }),
  })
  const cookie = `__Host-adea-sim=${'t'.repeat(40)}`
  const get = (path: string) => host(new Request(`${origin}${path}`, { headers: { cookie } }))
  expect((await get('/assets/agent-sim/room-designer.js')).status).toBe(200)
  expect((await get('/assets/agent-sim/engine.js')).status).toBe(403)
  expect((await get('/assets/agent-sim/character-designer.js')).status).toBe(403)
})
