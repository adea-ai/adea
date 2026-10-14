import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { zodLiteSource } from '../apps/web/start/neon-auth-zod-lite.mjs'

const require = createRequire(join(import.meta.dir, '../apps/web/package.json'))
const authDist = join(dirname(require.resolve('@neondatabase/auth/package.json')), 'dist')

// The real zod the adapter would otherwise bundle.
type Schema = { safeParse(input: unknown): { success: boolean; data?: unknown } }
type ZodLike = {
  string(): unknown
  number(): unknown
  object(shape: Record<string, unknown>): Schema
}
const realZod = createRequire(join(authDist, 'x.mjs'))('zod').z as ZodLike

const adapterFiles = readdirSync(authDist).filter((name) => name.endsWith('.mjs'))
const zodUsers = adapterFiles
  .map((name) => ({ name, source: readFileSync(join(authDist, name), 'utf8') }))
  .filter(({ source }) => /from\s+["']zod["']/.test(source))

const make = (z: ZodLike) => z.object({ token: z.string(), expires_at: z.number() })

async function loadLite() {
  const url = `data:text/javascript;base64,${Buffer.from(zodLiteSource).toString('base64')}`
  return (await import(url)).default as ZodLike
}

describe('neon auth zod stand-in', () => {
  test('the installed adapter uses only what the stand-in implements', () => {
    expect(zodUsers.length).toBeGreaterThan(0)
    for (const { name, source } of zodUsers) {
      // Only a default import, bound once, and only z.object / z.string / z.number.
      const imports = [...source.matchAll(/import\s+([^;]*?)\s+from\s+["']zod["']/g)].map(
        (match) => match[1]
      )
      expect({ name, imports }).toEqual({ name, imports: ['z'] })
      const used = new Set([...source.matchAll(/\bz\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
      expect({ name, used: [...used].toSorted() }).toEqual({
        name,
        used: ['number', 'object', 'string'],
      })
    }
  })

  test('the only schema is the anonymous token response', () => {
    for (const { source } of zodUsers) {
      const schemas = [...source.matchAll(/\bz\.object\(\{([^}]*)\}\)/g)].map((m) =>
        m[1]!.replaceAll(/\s+/g, '')
      )
      expect(schemas).toEqual(['token:z.string(),expires_at:z.number()'])
      // Only the safe parse is called on it, and nothing reads zod error types.
      expect(source).toMatch(/anonymousTokenResponseSchema\.safeParse\(/)
      expect(source).not.toMatch(/\.parse\(responseData|ZodError|\.issues|\.error\b.*zod/)
    }
  })

  test('agrees with real zod on the token response schema', async () => {
    const lite = await loadLite()
    const samples: unknown[] = [
      { token: 'abc', expires_at: 1 },
      { token: 'abc', expires_at: 1.5, extra: true },
      { token: 'abc' },
      { expires_at: 1 },
      { token: 1, expires_at: 1 },
      { token: 'abc', expires_at: '1' },
      { token: 'abc', expires_at: Number.NaN },
      { token: 'abc', expires_at: Number.POSITIVE_INFINITY },
      { token: null, expires_at: null },
      [],
      null,
      undefined,
      'text',
      7,
    ]
    for (const sample of samples) {
      const expected = make(realZod).safeParse(sample)
      const actual = make(lite).safeParse(sample)
      expect({ sample, success: actual.success }).toEqual({ sample, success: expected.success })
      if (expected.success) expect(actual.data).toEqual(expected.data)
    }
  })
})
