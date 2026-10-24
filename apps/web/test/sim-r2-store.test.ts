import { expect, test } from 'bun:test'

import { createSimPrivateAssetReader } from '../src/server/sim-private-assets'
import {
  createSimR2AssetStore,
  type SimR2Bucket,
  type SimR2Object,
} from '../src/server/sim-r2-store'

// The adapter asks one bucket for one object and hands back bytes and a content type. A fake
// bucket stands in for R2: it records every key it is asked for and refuses every other method, so
// a test fails if the adapter ever reaches for list, put, delete or anything that builds an address.
const LOCATION = 'agent-sim-export'

function fakeBucket(objects: Record<string, SimR2Object | Error>) {
  const asked: string[] = []
  const bucket = new Proxy(
    {
      async get(key: string) {
        asked.push(key)
        const found = objects[key]
        if (found instanceof Error) throw found
        return found ?? null
      },
    },
    {
      get(real, property) {
        if (property === 'get') return real.get
        throw new Error(`the adapter touched bucket.${String(property)}`)
      },
    }
  ) as SimR2Bucket
  return { bucket, asked }
}

const stream = (text: string) => new Response(text).body as ReadableStream

test('an object comes back as its bytes and the content type it was stored with', async () => {
  const body = stream('engine')
  const { bucket, asked } = fakeBucket({
    'engine.js': { body, httpMetadata: { contentType: 'text/javascript; charset=utf-8' } },
  })
  const answer = await createSimR2AssetStore({ location: LOCATION, bucket })({
    location: LOCATION,
    key: 'engine.js',
  })
  expect(answer).toEqual({ body, contentType: 'text/javascript; charset=utf-8' })
  expect(asked).toEqual(['engine.js'])
})

test('an object stored without a content type gets one from its extension, else octet-stream', async () => {
  const kinds: Record<string, string> = {
    'a/engine.js': 'text/javascript',
    'a/Engine.JS': 'text/javascript',
    'a/data.json': 'application/json',
    'a/core.wasm': 'application/wasm',
    'a/sprite.png': 'image/png',
    'a/model.glb': 'model/gltf-binary',
    'a/blob.unknown': 'application/octet-stream',
    'a/no-extension': 'application/octet-stream',
    'a/constructor': 'application/octet-stream',
    'a/.hidden': 'application/octet-stream',
    'a/empty.type': 'application/octet-stream',
  }
  const objects: Record<string, SimR2Object> = {}
  for (const key of Object.keys(kinds)) objects[key] = { body: stream(key), httpMetadata: {} }
  objects['a/empty.type'] = { body: stream('x'), httpMetadata: { contentType: '' } }
  const read = createSimR2AssetStore({ location: LOCATION, bucket: fakeBucket(objects).bucket })
  for (const [key, expected] of Object.entries(kinds)) {
    expect((await read({ location: LOCATION, key }))?.contentType).toBe(expected)
  }
  // An object with no metadata at all is typed the same way.
  const bare = createSimR2AssetStore({
    location: LOCATION,
    bucket: fakeBucket({ 'x.js': { body: stream('x') } }).bucket,
  })
  expect((await bare({ location: LOCATION, key: 'x.js' }))?.contentType).toBe('text/javascript')
})

test('an absent object is null', async () => {
  const { bucket, asked } = fakeBucket({})
  expect(
    await createSimR2AssetStore({ location: LOCATION, bucket })({
      location: LOCATION,
      key: 'missing.js',
    })
  ).toBeNull()
  expect(asked).toEqual(['missing.js'])
})

test('another location is absent and the bucket is not asked', async () => {
  const { bucket, asked } = fakeBucket({ 'engine.js': { body: stream('x') } })
  const read = createSimR2AssetStore({ location: LOCATION, bucket })
  expect(await read({ location: 'some-other-location', key: 'engine.js' })).toBeNull()
  expect(await read({ location: '', key: 'engine.js' })).toBeNull()
  expect(asked).toEqual([])
})

test('an object without a body is a fault, not an absent object', async () => {
  const { bucket } = fakeBucket({
    'none.js': { httpMetadata: { contentType: 'text/javascript' } },
    'null.js': { body: null },
  })
  const read = createSimR2AssetStore({ location: LOCATION, bucket })
  await expect(read({ location: LOCATION, key: 'none.js' })).rejects.toThrow('without a body')
  await expect(read({ location: LOCATION, key: 'null.js' })).rejects.toThrow('without a body')
})

test('a failing bucket throws instead of answering absent', async () => {
  const { bucket } = fakeBucket({ 'engine.js': new Error('r2 is down') })
  await expect(
    createSimR2AssetStore({ location: LOCATION, bucket })({ location: LOCATION, key: 'engine.js' })
  ).rejects.toThrow('r2 is down')
})

test('behind the reader, only a safe key outside the withheld packs reaches the bucket', async () => {
  const { bucket, asked } = fakeBucket({
    'engine.js': { body: stream('engine') },
    'scenes/sim/assets/ok.txt': { body: stream('ok') },
    'packages/characters/assets/x.txt': { body: stream('withheld') },
  })
  const reader = createSimPrivateAssetReader({
    location: LOCATION,
    read: createSimR2AssetStore({ location: LOCATION, bucket }),
  })
  expect(await reader('engine.js')).not.toBeNull()
  expect(await reader('scenes/sim/assets/ok.txt')).not.toBeNull()
  for (const refused of [
    'packages/characters/assets/x.txt',
    '%70ackages/characters/assets/x.txt',
    'packages%252fcharacters/assets/x.txt',
    '../engine.js',
    'a/../engine.js',
    '/engine.js',
    'a//b.js',
    '',
  ]) {
    expect(await reader(refused)).toBeNull()
  }
  expect(asked).toEqual(['engine.js', 'scenes/sim/assets/ok.txt'])
})
