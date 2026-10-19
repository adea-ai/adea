import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'bun:test'

// Optional source override supports the external proposal without copying owner files.
const root = process.env.FRESH_AUTH_SOURCE_ROOT ?? fileURLToPath(new URL('../../', import.meta.url))
const source = (name: string) => pathToFileURL(resolve(root, 'packages/auth/src', name)).href

test.skipIf(process.env.FRESH_AUTH_ACCEPTANCE !== '1' && !process.env.FRESH_AUTH_SOURCE_ROOT)(
  'dedicated opt-in: origin denial preserves the one-use PKCE code and session; trusted logout revokes saved credentials',
  async () => {
    const { createDesktopAuthorizationAttempt, createDesktopHttpSessionBroker } = await import(
      source('desktop.ts')
    )
    const { createDesktopAuthorizationCodeBroker, createDesktopSessionService } = await import(
      source('desktop-server.ts')
    )
    const { parseDesktopExchangeRequest, parseDesktopSessionRequest, desktopCorsHeaders } =
      await import(source('desktop-http-server.ts'))

    const now = Date.parse('2026-10-19T00:00:00Z')
    const cloud = 'https://fresh.example.test'
    const shell = 'http://127.0.0.1:4789'
    const trusted = [shell]
    // Intentionally memory-only persistence, matching the public store contracts.
    const codes = new Map<string, any>()
    const sessions = new Map<string, any>()
    let consumes = 0
    let revocations = 0
    const service = createDesktopSessionService({
      now: () => now,
      store: {
        async create(record: any) {
          sessions.set(record.credentialDigest, record)
        },
        async resolve(input: any) {
          const record = sessions.get(input.credentialDigest)
          return record &&
            record.sessionId === input.sessionId &&
            record.revokedAt === null &&
            record.expiresAt > input.now
            ? record
            : null
        },
        async rotate(input: any) {
          const record = await this.resolve(input)
          if (!record) return null
          sessions.delete(input.credentialDigest)
          const next = {
            ...record,
            credentialDigest: input.nextCredentialDigest,
            expiresAt: input.expiresAt,
          }
          sessions.set(input.nextCredentialDigest, next)
          return next
        },
        async revoke(input: any) {
          const record = sessions.get(input.credentialDigest)
          if (!record || record.sessionId !== input.sessionId || record.revokedAt !== null)
            return false
          sessions.set(input.credentialDigest, { ...record, revokedAt: now })
          revocations++
          return true
        },
      },
    })
    const codesBroker = createDesktopAuthorizationCodeBroker({
      now: () => now,
      issueSession: service.issue,
      store: {
        async save(record: any) {
          codes.set(record.codeDigest, record)
        },
        async consume(digest: string) {
          consumes++
          const record = codes.get(digest) ?? null
          codes.delete(digest)
          return record
        },
      },
    })
    // This is an in-process test composition of production primitives, NOT the web route handler.
    let requestOrigin: string | null = shell
    const requests: string[] = []
    const fetch = async (url: URL | RequestInfo, init?: RequestInit) => {
      assert.equal(init?.cache, 'no-store')
      assert.equal(init?.credentials, 'omit')
      assert.equal(init?.redirect, 'error')
      const headers = new Headers(init?.headers)
      if (requestOrigin !== null) headers.set('origin', requestOrigin)
      const request = new Request(url, { ...init, headers })
      requests.push(request.url)
      const path = new URL(request.url).pathname
      const responseHeaders = desktopCorsHeaders(request.headers.get('origin') ?? '', trusted)
      let response: Response
      try {
        if (path.endsWith('/exchange')) {
          const parsed = await parseDesktopExchangeRequest(request, trusted)
          response = Response.json(await codesBroker.exchange(parsed), { headers: responseHeaders })
        } else {
          const credential = parseDesktopSessionRequest(request, trusted)
          if (path.endsWith('/refresh'))
            response = Response.json(await service.refresh(credential), {
              headers: responseHeaders,
            })
          else {
            assert.ok(path.endsWith('/logout') || path.endsWith('/revoke'))
            await service[path.endsWith('/logout') ? 'logout' : 'revoke'](credential)
            response = new Response(null, { status: 204, headers: responseHeaders })
          }
        }
      } catch {
        response = Response.json(
          { error: 'synthetic desktop request denied' },
          { status: path.endsWith('/exchange') ? 400 : 401, headers: responseHeaders }
        )
      }
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(
        response.headers.get('access-control-allow-origin'),
        requestOrigin === shell ? shell : null
      )
      return response
    }
    const client = createDesktopHttpSessionBroker({ cloudOrigin: cloud, fetch })
    const attempt = await createDesktopAuthorizationAttempt({ now })
    const callback = new URL(
      await codesBroker.issue({
        codeChallenge: attempt.codeChallenge,
        nonce: attempt.nonce,
        state: attempt.state,
        redirectUri: attempt.redirectUri,
        email: 'fresh-desktop@example.test',
        providerExpiresAt: now + 3_600_000,
        providerSessionId: 'synthetic-provider-session',
        userId: 'synthetic-user',
      })
    )
    const exchange = {
      code: callback.searchParams.get('code')!,
      codeVerifier: attempt.codeVerifier,
      nonce: attempt.nonce,
      redirectUri: attempt.redirectUri,
    }
    assert.deepEqual([...callback.searchParams.keys()].toSorted(), ['code', 'nonce', 'state'])
    for (requestOrigin of [null, 'https://hostile.example.test']) {
      await assert.rejects(client.exchange(exchange), /request failed/)
      assert.equal(consumes, 0)
      assert.equal(codes.size, 1)
      assert.equal(sessions.size, 0)
    }
    requestOrigin = shell
    const session = await client.exchange(exchange)
    assert.equal(consumes, 1)
    assert.equal(codes.size, 0)
    assert.equal((await service.resolve(session))?.userId, 'synthetic-user')
    await assert.rejects(client.exchange(exchange), /request failed/)
    const rotated = await client.refresh(session)
    assert.equal(rotated.sessionId, session.sessionId)
    assert.notEqual(rotated.credential, session.credential)
    assert.equal(await service.resolve(session), null)
    for (requestOrigin of [null, 'https://hostile.example.test']) {
      await assert.rejects(client.logout(rotated), /request failed/)
      assert.equal(revocations, 0)
      assert.equal((await service.resolve(rotated))?.userId, 'synthetic-user')
    }
    requestOrigin = shell
    await client.logout(rotated)
    assert.equal(revocations, 1)
    assert.equal(await service.resolve(rotated), null)
    await assert.rejects(client.refresh(rotated), /request failed/)
    await assert.rejects(client.revoke(rotated), /request failed/)
    assert.equal(revocations, 1)
    assert.ok(
      requests.every(
        (url) => !url.includes(session.credential) && !url.includes(rotated.credential)
      )
    )
  }
)
