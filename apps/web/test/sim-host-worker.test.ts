import { expect, test } from 'bun:test'

import worker, {
  createSimHostWorker,
  denyAllSimEntitlement,
  type SimHostWorkerPorts,
} from '../src/server/sim-host-worker'

// The Worker entry is inert source: the default export composes nothing, a composition that is
// missing, throwing or malformed answers closed, and an omitted entitlement policy denies.
const ORIGIN = 'https://sim.example'
const PARENT_ORIGIN = 'https://app.example'
const NOW = 1_000
const TOKEN = 'v'.repeat(40)

function ports(reads: string[], override: Partial<SimHostWorkerPorts> = {}): SimHostWorkerPorts {
  return {
    configuration: {
      origin: ORIGIN,
      parentOrigins: [PARENT_ORIGIN],
      assetPrefix: '/assets/agent-sim/',
      entryFiles: {
        hq: 'engine.js',
        'room-designer': 'room-designer.js',
        'character-designer': 'character-designer.js',
      },
    },
    store: {
      issue() {
        throw new Error('the hosted service never issues codes')
      },
      redeem: () => ({ ok: false as const, reason: 'unknown' as const }),
      redeemAndSave: () => ({ ok: false as const, reason: 'unknown' as const }),
    },
    sessions: async () => ({
      workspaceId: 'workspace-one',
      surface: 'hq',
      expiresAt: NOW + 60_000,
    }),
    readAsset: async (path) => {
      reads.push(path)
      return { body: `private:${path}`, contentType: 'text/javascript' }
    },
    frameScript: '// bootstrap',
    now: () => NOW,
    ...override,
  }
}

const asset = () =>
  new Request(`${ORIGIN}/assets/agent-sim/engine.js`, {
    headers: { cookie: `__Host-adea-sim=${TOKEN}` },
  })

async function expectClosed(response: Response) {
  expect(response.status).toBe(503)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.json()).toEqual({ error: 'not_configured' })
}

test('the default export composes nothing and answers every route closed', async () => {
  for (const request of [
    new Request(`${ORIGIN}/frame`),
    new Request(`${ORIGIN}/configuration`),
    new Request(`${ORIGIN}/session`, { method: 'POST', body: '{}' }),
    asset(),
  ]) {
    await expectClosed(await worker.fetch(request, {}))
  }
})

test('a composition that returns nothing is not configured', async () => {
  await expectClosed(await createSimHostWorker(() => null).fetch(asset(), {}))
  await expectClosed(await createSimHostWorker(() => undefined).fetch(asset(), {}))
})

test('a throwing composition is not configured and its message is not sent', async () => {
  const response = await createSimHostWorker(() => {
    throw new Error('secret binding name')
  }).fetch(asset(), {})
  await expectClosed(response)
})

test('a malformed host configuration is refused instead of starting', async () => {
  const reads: string[] = []
  const bad = ports(reads, {
    configuration: { ...ports(reads).configuration, parentOrigins: [] },
  })
  await expectClosed(await createSimHostWorker(() => bad).fetch(asset(), {}))
  expect(reads).toEqual([])
})

test('a composition without an entitlement policy serves no private asset', async () => {
  const reads: string[] = []
  const response = await createSimHostWorker(() => ports(reads)).fetch(asset(), {})
  expect(response.status).toBe(403)
  expect(reads).toEqual([])
})

test('an explicit entitled policy serves the asset, so the default-deny check bites', async () => {
  const reads: string[] = []
  const response = await createSimHostWorker(() =>
    ports(reads, { policy: () => 'entitled' })
  ).fetch(asset(), {})
  expect(response.status).toBe(200)
  expect(reads).toEqual(['engine.js'])
})

test('the composition receives the Worker environment and runs for each request', async () => {
  const seen: unknown[] = []
  const environment = { marker: 1 }
  const instance = createSimHostWorker<typeof environment>((env) => {
    seen.push(env)
    return null
  })
  await instance.fetch(asset(), environment)
  await instance.fetch(asset(), environment)
  expect(seen).toEqual([environment, environment])
})

test('the deny-all policy denies every workspace and surface', () => {
  for (const surface of ['hq', 'room-designer', 'character-designer'] as const) {
    expect(denyAllSimEntitlement({ workspaceId: 'workspace-one', surface })).toBe('not_entitled')
  }
})

// A composition may open something per request, such as a database connection, and hand back a
// `dispose` to release it. It runs once after the handler has answered, never reaches the caller,
// and is handed to waitUntil when the Worker supplies an execution context.
test('dispose runs once per request after the answer, and the answer is unchanged by it', async () => {
  const reads: string[] = []
  const events: string[] = []
  const instance = createSimHostWorker(() =>
    ports(reads, {
      policy: () => 'entitled',
      readAsset: async (path) => {
        events.push('read')
        reads.push(path)
        return { body: 'engine', contentType: 'text/javascript' }
      },
      dispose: () => {
        events.push('dispose')
      },
    })
  )
  const first = await instance.fetch(asset(), {})
  expect(first.status).toBe(200)
  expect(await first.text()).toBe('engine')
  expect(events).toEqual(['read', 'dispose'])
  await instance.fetch(asset(), {})
  expect(events).toEqual(['read', 'dispose', 'read', 'dispose'])
})

test('dispose is handed to waitUntil when there is an execution context, and is not awaited', async () => {
  const handed: Promise<unknown>[] = []
  let finished = false
  const instance = createSimHostWorker(() =>
    ports([], {
      dispose: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        finished = true
      },
    })
  )
  const response = await instance.fetch(
    asset(),
    {},
    { waitUntil: (promise) => handed.push(promise) }
  )
  expect(response.status).toBe(403)
  expect(handed).toHaveLength(1)
  expect(finished).toBe(false)
  await handed[0]
  expect(finished).toBe(true)
})

const throwing = () => {
  throw new Error('connection reset: postgresql://secret')
}
const rejecting = async () => {
  throw new Error('close failed')
}

test('a failing dispose is swallowed, with or without an execution context', async () => {
  for (const dispose of [throwing, rejecting]) {
    const instance = createSimHostWorker(() => ports([], { dispose }))
    expect((await instance.fetch(asset(), {})).status).toBe(403)
    const handed: Promise<unknown>[] = []
    const response = await instance.fetch(asset(), {}, { waitUntil: (p) => handed.push(p) })
    expect(response.status).toBe(403)
    // The promise handed over never rejects, so the Worker runtime sees no unhandled error.
    await expect(handed[0]).resolves.toBeUndefined()
  }
})

test('dispose still runs when the service cannot be built, and the answer is closed', async () => {
  let disposed = 0
  const bad = ports([], {
    configuration: { ...ports([]).configuration, parentOrigins: [] },
    dispose: () => {
      disposed += 1
    },
  })
  await expectClosed(await createSimHostWorker(() => bad).fetch(asset(), {}))
  expect(disposed).toBe(1)
})

test('dispose is not passed on to the service as an option', async () => {
  const reads: string[] = []
  const response = await createSimHostWorker(() =>
    ports(reads, { policy: () => 'entitled', dispose: () => undefined })
  ).fetch(asset(), {})
  expect(response.status).toBe(200)
  expect(reads).toEqual(['engine.js'])
})
