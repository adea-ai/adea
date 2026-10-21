import { describe, expect, test } from 'bun:test'

import {
  createSimPrivateAssetReader,
  simPrivateAssetKey,
  SIM_PRIVATE_ASSET_LOCATION,
} from '../src/server/sim-private-assets'
import { createSyntheticPrivateStore } from './fixtures/sim-private-assets/synthetic-store'

// The named private location: the rules that keep a private object behind the session gate and
// out of any public alias.
//
// Everything here is synthetic. The store is an in-memory map and a call log: no storage provider,
// no bucket, no credential and no deployment are involved. What is proven here is the request-side
// contract — which key is asked for, in which location, how many times, and what comes back. The
// storage-side gate, the access control list that makes the location private and the absence of a
// public alias for the same objects, are deployment prerequisites and are not claimed here.

const object = { body: 'private-bytes', contentType: 'text/javascript' }

describe('the private location name', () => {
  test('a plain location name is accepted and anything else is refused', () => {
    expect(SIM_PRIVATE_ASSET_LOCATION.test('agent-sim-export')).toBe(true)
    expect(SIM_PRIVATE_ASSET_LOCATION.test('agent_sim.export-2')).toBe(true)
    for (const refused of [
      'https://public.example/agent-sim',
      '/agent-sim',
      'agent sim',
      '',
      '.hidden',
      'a'.repeat(65),
    ]) {
      expect(SIM_PRIVATE_ASSET_LOCATION.test(refused)).toBe(false)
    }
  })

  test('a location name that could name a bucket, a prefix or a path is refused', () => {
    // The location is a plain identifier, so nothing here can name a public bucket, a public
    // prefix, a path or an alias for one.
    for (const refused of [
      '..',
      '.',
      '../agent-sim',
      'agent-sim/../other',
      'agent-sim/child',
      'agent-sim:export',
      'agent-sim@export',
      'agent sim',
      'agent-sim%2fchild',
      'AGENT-SIM/../other',
    ]) {
      expect(SIM_PRIVATE_ASSET_LOCATION.test(refused)).toBe(false)
    }
    // The longest plain name is still a name.
    expect(SIM_PRIVATE_ASSET_LOCATION.test('a'.repeat(64))).toBe(true)
  })
})

describe('the storage key', () => {
  test('a path that could leave the location has no key', () => {
    expect(simPrivateAssetKey('engine.js')).toBe('engine.js')
    expect(simPrivateAssetKey('shared/fonts/sans.woff2')).toBe('shared/fonts/sans.woff2')
    for (const refused of [
      '',
      '/engine.js',
      'shared//font.woff2',
      '../escape.js',
      'shared/../escape.js',
      './engine.js',
      'shared\\font.woff2',
      'engine.js\0',
    ]) {
      expect(simPrivateAssetKey(refused)).toBeNull()
    }
  })

  test('a path that is not a string has no key', () => {
    for (const refused of [undefined, null, 42, {}, ['engine.js']]) {
      expect(simPrivateAssetKey(refused as unknown as string)).toBeNull()
    }
  })

  test('a key that carries a percent escape a storage adapter would decode has no key', () => {
    // A storage adapter builds a URL or a file path out of the key, and both decode it. An encoded
    // separator, dot or NUL in the key is therefore a path in disguise, and it is refused here
    // rather than left to the adapter.
    for (const refused of [
      '%2e%2e%2fescape.js',
      '%2E%2E%2Fescape.js',
      'shared%2fengine.js',
      'engine%5cfont.woff2',
      'engine%00.js',
      'shared%2ffonts%2fsans.woff2',
    ]) {
      expect(simPrivateAssetKey(refused)).toBeNull()
    }
    // A percent escape that cannot become a path is a plain key.
    expect(simPrivateAssetKey('engine%20min.js')).toBe('engine%20min.js')
    expect(simPrivateAssetKey('100%.png')).toBe('100%.png')
  })
})

describe('the private reader', () => {
  test('it asks for the named location and the key, and returns the bytes without an address', async () => {
    const store = createSyntheticPrivateStore({ objects: { 'engine.js': object } })
    const reader = createSimPrivateAssetReader({ location: 'agent-sim-export', read: store.read })
    const asset = await reader('engine.js')
    expect(asset).toEqual(object)
    expect(store.requests).toEqual([{ location: 'agent-sim-export', key: 'engine.js' }])
    // The reader hands back the object, not an address to it. Whether the storage location itself
    // is private is a deployment prerequisite and is not asserted here.
    expect(JSON.stringify(asset)).not.toContain('agent-sim-export')
  })

  test('a malformed location name serves no object at all', async () => {
    const store = createSyntheticPrivateStore({ objects: { 'engine.js': object } })
    const reader = createSimPrivateAssetReader({
      location: 'https://public.example/agent-sim',
      read: store.read,
    })
    expect(await reader('engine.js')).toBeNull()
    expect(store.calls).toBe(0)
  })

  test('a path that could leave the location is refused before the storage is read', async () => {
    const store = createSyntheticPrivateStore({ objects: { 'engine.js': object } })
    const reader = createSimPrivateAssetReader({ location: 'agent-sim-export', read: store.read })
    expect(await reader('../escape.js')).toBeNull()
    expect(await reader('/engine.js')).toBeNull()
    expect(store.calls).toBe(0)
  })

  test('a key that is a path in disguise is refused before the storage is read', async () => {
    const store = createSyntheticPrivateStore({ objects: { 'engine.js': object } })
    const reader = createSimPrivateAssetReader({ location: 'agent-sim-export', read: store.read })
    // The host decodes the request path once before it reaches the reader, so a path that was
    // encoded twice arrives here still encoded. It cannot name a key outside the location, and
    // the storage is not asked for it at all.
    expect(await reader('%2e%2e%2fescape.js')).toBeNull()
    expect(await reader('%2fetc%2fpasswd')).toBeNull()
    expect(store.calls).toBe(0)
  })

  test('an absent object is null, so the host can answer without one', async () => {
    const store = createSyntheticPrivateStore({ objects: {} })
    const reader = createSimPrivateAssetReader({ location: 'agent-sim-export', read: store.read })
    expect(await reader('engine.js')).toBeNull()
    expect(store.calls).toBe(1)
  })

  test('a store that fails is reported as a failure, not as an absent object', async () => {
    const reader = createSimPrivateAssetReader({
      location: 'agent-sim-export',
      read: async () => {
        throw new Error('storage down')
      },
    })
    await expect(reader('engine.js')).rejects.toThrow('storage down')
  })

  test('a store that answers with something that is not an object is reported as a failure', async () => {
    // An answer that is not an object with a body and a content type is a fault of the storage
    // adapter, not an absent object. The reader refuses it instead of handing back an empty
    // object that would be served as a success.
    for (const answer of [
      'not an asset',
      42,
      { contentType: 'text/javascript' },
      { body: 'private-bytes' },
      { body: 'private-bytes', contentType: '' },
    ]) {
      const reader = createSimPrivateAssetReader({
        location: 'agent-sim-export',
        read: async () => answer as never,
      })
      await expect(reader('engine.js')).rejects.toThrow()
    }
  })

  test('a store that answers with nothing at all is an absent object, not a failure', async () => {
    for (const answer of [null, undefined]) {
      const reader = createSimPrivateAssetReader({
        location: 'agent-sim-export',
        read: async () => answer as never,
      })
      expect(await reader('engine.js')).toBeNull()
    }
  })

  test('a store that answers with an address never hands that address back', async () => {
    // The reader answers with the bytes and their type only, so the service cannot offer a
    // second route to a private object even when the storage adapter answers with one.
    const reader = createSimPrivateAssetReader({
      location: 'agent-sim-export',
      read: async () =>
        ({
          body: 'private-bytes',
          contentType: 'text/javascript',
          location: 'https://public.example/agent-sim/engine.js',
          url: 'https://public.example/agent-sim/engine.js?signature=secret',
          redirect: 'https://public.example/agent-sim/engine.js',
        }) as never,
    })
    const asset = await reader('engine.js')
    expect(asset).toEqual(object)
    expect(JSON.stringify(asset)).not.toContain('public.example')
    expect(Object.keys(asset ?? {}).toSorted()).toEqual(['body', 'contentType'])
  })

  test('one read asks the store exactly once, for exactly one key', async () => {
    const store = createSyntheticPrivateStore({ objects: { 'engine.js': object } })
    const reader = createSimPrivateAssetReader({ location: 'agent-sim-export', read: store.read })
    await reader('engine.js')
    await reader('engine.js')
    expect(store.calls).toBe(2)
    expect(store.requests).toEqual([
      { location: 'agent-sim-export', key: 'engine.js' },
      { location: 'agent-sim-export', key: 'engine.js' },
    ])
  })

  test('the location it asks for is the validated one, whatever the caller does later', async () => {
    const options = {
      location: 'agent-sim-export',
      read: async (request: { location: string; key: string }) => {
        expect(request.location).toBe('agent-sim-export')
        return object
      },
    }
    const reader = createSimPrivateAssetReader(options)
    await reader('engine.js')
    // A caller that mutates its own options afterwards does not move the reader.
    options.location = 'https://public.example/agent-sim'
    expect(await reader('engine.js')).toEqual(object)
  })
})
