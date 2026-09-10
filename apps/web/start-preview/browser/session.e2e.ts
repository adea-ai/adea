import { expect, test } from '@playwright/test'

// These requests use the actual isolated backend and PostgreSQL, not route mocks.
test('guest cookies, durable writes and tenant isolation survive the gateway', async ({
  playwright,
  baseURL,
}) => {
  const first = await playwright.request.newContext({
    baseURL,
    ignoreHTTPSErrors: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL!).hostname),
  })
  const second = await playwright.request.newContext({
    baseURL,
    ignoreHTTPSErrors: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL!).hostname),
  })
  try {
    const a = await first.post('/api/workspaces/bootstrap')
    expect(a.status()).toBe(200)
    const bootstrap = await a.json()
    expect(bootstrap.workspaces).toHaveLength(2)
    expect(bootstrap.principal.temporary).toBe(true)
    const cookies = (await first.storageState()).cookies
    expect(cookies.some((cookie) => cookie.httpOnly && cookie.sameSite === 'Lax')).toBe(true)
    const repeat = await first.post('/api/workspaces/bootstrap')
    expect((await repeat.json()).principal.userId).toBe(bootstrap.principal.userId)
    const b = await second.post('/api/workspaces/bootstrap')
    expect(b.status()).toBe(200)
    const other = await b.json()
    expect(other.principal.userId).not.toBe(bootstrap.principal.userId)
    expect(other.workspaces.map((item: { id: string }) => item.id)).not.toContain(
      bootstrap.activeWorkspace.id
    )
    const anonymous = await playwright.request.newContext({
      baseURL,
      ignoreHTTPSErrors: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL!).hostname),
    })
    try {
      expect((await anonymous.get('/api/workspaces')).status()).toBe(401)
    } finally {
      await anonymous.dispose()
    }
    const idempotencyKey = crypto.randomUUID()
    const create = () =>
      first.post('/api/workspaces', {
        headers: { 'Idempotency-Key': idempotencyKey },
        data: { name: 'Start migration verification', scene: 'home' },
      })
    expect((await create()).status()).toBe(201)
    expect((await create()).status()).toBe(200)
    const own = await first.get('/api/workspaces')
    const foreign = await second.get('/api/workspaces')
    expect(
      (await own.json()).some(
        (item: { name: string }) => item.name === 'Start migration verification'
      )
    ).toBe(true)
    expect(
      (await foreign.json()).some(
        (item: { name: string }) => item.name === 'Start migration verification'
      )
    ).toBe(false)
    const hostile = await first.post('/api/workspaces/bootstrap', {
      headers: { 'X-Adea-Client': 'desktop', Origin: 'https://untrusted.example' },
    })
    expect(hostile.status()).toBe(403)
    expect(hostile.headers()['access-control-allow-origin']).toBeUndefined()
    expect(own.headers()['cache-control']).toBe('private, no-store')
  } finally {
    await first.dispose()
    await second.dispose()
  }
})
