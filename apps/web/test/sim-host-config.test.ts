import { expect, test } from 'bun:test'
import { createSimHostIsolation } from '../src/server/sim-host-config'
import { createSimHost } from '../src/server/sim-host'

const origin = 'https://sim.example'
const parent = 'https://app.example'
const valid = { origin, parentOrigins: [parent] }

test('a complete isolation configuration validates and comes back frozen with canonical values', () => {
  const config = createSimHostIsolation(valid)
  expect(config).toEqual({ origin, parentOrigins: [parent], allowLoopbackHttp: false })
  expect(Object.isFrozen(config)).toBe(true)
  expect(Object.isFrozen(config.parentOrigins)).toBe(true)
  expect(() => {
    ;(config as { origin: string }).origin = 'https://other.example'
  }).toThrow()
})

test('a missing or non-object configuration fails closed', () => {
  for (const value of [undefined, null, 'https://sim.example', 42])
    expect(() => createSimHostIsolation(value)).toThrow('isolation configuration')
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
    expect(() => createSimHostIsolation({ ...valid, origin: bad })).toThrow(
      'distinct canonical frame and parent origins'
    )
  for (const bad of ['https://app.example/', 'http://app.example'])
    expect(() => createSimHostIsolation({ ...valid, parentOrigins: [bad] })).toThrow(
      'distinct canonical frame and parent origins'
    )
})

test('loopback HTTP is accepted only when the acceptance allowance is set explicitly', () => {
  const loopback = { origin: 'http://127.0.0.1:4100', parentOrigins: ['http://localhost:3000'] }
  expect(() => createSimHostIsolation(loopback)).toThrow('distinct canonical frame and parent')
  expect(createSimHostIsolation({ ...loopback, allowLoopbackHttp: true })).toMatchObject({
    origin: 'http://127.0.0.1:4100',
    allowLoopbackHttp: true,
  })
  expect(() => createSimHostIsolation({ ...loopback, allowLoopbackHttp: 'yes' })).toThrow(
    'must be a boolean'
  )
})

test('the frame and the parents need an exact, non-empty, distinct set of origins on separate cookie hosts', () => {
  expect(() => createSimHostIsolation({ origin, parentOrigins: [] })).toThrow(
    'at least one parent origin'
  )
  expect(() => createSimHostIsolation({ origin, parentOrigins: [origin] })).toThrow(
    'distinct canonical frame and parent origins'
  )
  // A parent on the frame's own host shares its cookie scope, whatever its port.
  expect(() =>
    createSimHostIsolation({ origin, parentOrigins: ['https://sim.example:8443'] })
  ).toThrow('separate cookie host')
  expect(() => createSimHostIsolation({ origin, parentOrigins: [parent, parent] })).toThrow(
    'must be distinct'
  )
  expect(() =>
    createSimHostIsolation({ origin, parentOrigins: [parent, 'https://other.example'] })
  ).not.toThrow()
  expect(() =>
    createSimHostIsolation({ origin, parentOrigins: [parent, 'https://app.example:8443'] })
  ).not.toThrow()
})

test('createSimHost refuses to start without a valid configuration or a frame script', () => {
  const dependencies = {
    frameScript: '// bootstrap',
    exchange: async () => ({ body: { status: 'unavailable' } }) as never,
    session: async () => null,
    readAsset: async () => null,
  }
  expect(() => createSimHost({ ...dependencies, origin, parentOrigins: [] })).toThrow(
    'at least one parent origin'
  )
  expect(() =>
    createSimHost({
      ...dependencies,
      frameScript: undefined as unknown as string,
      origin,
      parentOrigins: [parent],
    })
  ).toThrow('needs a frame script')
  expect(() => createSimHost({ ...dependencies, origin, parentOrigins: [parent] })).not.toThrow()
})
