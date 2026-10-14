import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { ZOD_LITE_ID, authZodLite, zodLiteSource } from '../../src/vite-client-bundle'
import { zodCompatibilityProblems } from './zod-lite-compat'

type Schema = { safeParse(input: unknown): { success: boolean; data?: unknown } }
type ZodLike = {
  string(): unknown
  number(): unknown
  object(shape: Record<string, unknown>): Schema
}

const require = createRequire(import.meta.url)
const adapterDist = join(dirname(require.resolve('@neondatabase/auth/package.json')), 'dist')
// The real zod the adapter would otherwise bundle.
const realZod = createRequire(join(adapterDist, 'x.mjs'))('zod').z as ZodLike

const zodUsers = readdirSync(adapterDist)
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => ({ name, source: readFileSync(join(adapterDist, name), 'utf8') }))
  .filter(({ source }) => /from\s+["']zod["']/.test(source))

const make = (z: ZodLike) => z.object({ token: z.string(), expires_at: z.number() })

async function loadLite(): Promise<ZodLike> {
  const url = `data:text/javascript;base64,${Buffer.from(zodLiteSource).toString('base64')}`
  return (await import(url)).default as ZodLike
}

describe('client bundle zod stand-in', () => {
  test('the installed adapter uses zod only in the way the stand-in implements', () => {
    expect(zodUsers.length).toBeGreaterThan(0)
    for (const { name, source } of zodUsers) {
      expect({ name, problems: zodCompatibilityProblems(source) }).toEqual({ name, problems: [] })
    }
  })

  test('every file the plugin would swap is one the guard has checked', () => {
    // The plugin swaps zod for any file under the adapter's dist; none may import
    // it in a form the text search for `from "zod"` would miss.
    for (const name of readdirSync(adapterDist)) {
      if (!/\.(mjs|cjs|js)$/.test(name)) continue
      const source = readFileSync(join(adapterDist, name), 'utf8')
      if (zodUsers.some((user) => user.name === name)) continue
      expect({ name, problems: zodCompatibilityProblems(source) }).toEqual({ name, problems: [] })
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

  test('the plugin swaps only the adapter\u2019s zod import, in the client build', () => {
    const plugin = authZodLite()
    const adapter = '/repo/node_modules/@neondatabase/auth/dist/adapter-core-X.mjs'
    expect(plugin.applyToEnvironment({ name: 'client' })).toBe(true)
    expect(plugin.applyToEnvironment({ name: 'ssr' })).toBe(false)
    expect(plugin.resolveId('zod', adapter)).toBe(ZOD_LITE_ID)
    expect(
      plugin.resolveId('zod', 'C:\\repo\\node_modules\\@neondatabase\\auth\\dist\\x.mjs')
    ).toBe(ZOD_LITE_ID)
    expect(plugin.resolveId('zod', '/repo/node_modules/better-auth/dist/index.mjs')).toBeNull()
    expect(plugin.resolveId('zod/v4', adapter)).toBeNull()
    expect(plugin.resolveId('zod', undefined)).toBeNull()
    expect(plugin.load(ZOD_LITE_ID)).toBe(zodLiteSource)
    expect(plugin.load('/other')).toBeNull()
  })
})

// A conforming file, mutated one way at a time. Each mutation is something a
// future adapter release could do with zod that the stand-in does not handle.
const conforming = `import z from "zod";
const anonymousTokenResponseSchema = z.object({
\ttoken: z.string(),
\texpires_at: z.number()
});
async function handle(responseData) {
\tconst parsed = anonymousTokenResponseSchema.safeParse(responseData);
\tif (parsed.success) cache(parsed.data);
}
`

describe('zod compatibility guard', () => {
  test('accepts the conforming shape', () => {
    expect(zodCompatibilityProblems(conforming)).toEqual([])
  })

  test('a file that does not use zod has nothing to check', () => {
    expect(zodCompatibilityProblems('export const a = 1')).toEqual([])
  })

  const mutations: Record<string, (source: string) => string> = {
    'chained check on a field': (s) => s.replace('z.string()', 'z.string().min(1)'),
    'chained modifier on a field': (s) => s.replace('z.number()', 'z.number().int()'),
    'optional field': (s) => s.replace('z.string()', 'z.string().optional()'),
    'nullable field': (s) => s.replace('z.number()', 'z.number().nullable()'),
    'field with an argument': (s) => s.replace('z.string()', 'z.string("message")'),
    'chained on the object': (s) => s.replace('\n});', '\n}).strict();'),
    'extend on the object': (s) => s.replace('\n});', '\n}).extend({ more: z.string() });'),
    'unsupported field kind': (s) => s.replace('z.number()', 'z.boolean()'),
    'array field': (s) => s.replace('z.string()', 'z.array(z.string())'),
    'union field': (s) => s.replace('z.number()', 'z.union([z.number(), z.string()])'),
    'extra field': (s) => s.replace('z.number()', 'z.number(),\n\textra: z.string()'),
    'missing field': (s) => s.replace('\ttoken: z.string(),\n', ''),
    'renamed field': (s) => s.replace('expires_at', 'expiresAt'),
    'spread in the shape': (s) => s.replace('\ttoken: z.string(),', '\t...base,'),
    'shorthand field': (s) => s.replace('\ttoken: z.string(),', '\ttoken,'),
    'computed field name': (s) => s.replace('\ttoken:', '\t["token"]:'),
    'shape in a variable': (s) =>
      s.replace('z.object({', 'z.object(shape); const shape = ({').replace('\n});', '\n});'),
    'object with two arguments': (s) => s.replace('\n});', '\n}, {});'),
    'strict parse': (s) => s.replace('.safeParse(responseData)', '.parse(responseData)'),
    'async parse': (s) => s.replace('.safeParse(responseData)', '.safeParseAsync(responseData)'),
    'safeParse with a second argument': (s) =>
      s.replace('.safeParse(responseData)', '.safeParse(responseData, {})'),
    'schema read as a value': (s) => `${s}\nexport { anonymousTokenResponseSchema };`,
    'schema passed along': (s) => `${s}\nregister(anonymousTokenResponseSchema);`,
    'schema shape accessed': (s) => `${s}\nconst keys = anonymousTokenResponseSchema.shape;`,
    'schema infer helper': (s) => `${s}\nconst again = anonymousTokenResponseSchema.parse;`,
    'result error read': (s) => s.replace('cache(parsed.data)', 'log(parsed.error)'),
    'result passed along': (s) => s.replace('cache(parsed.data)', 'cache(parsed)'),
    'result destructured': (s) =>
      s.replace('const parsed =', 'const { success, data } =').replace('parsed.success', 'success'),
    'result not bound': (s) =>
      s.replace(
        'const parsed = anonymousTokenResponseSchema.safeParse(responseData);',
        'cache(anonymousTokenResponseSchema.safeParse(responseData));'
      ),
    'schema not const': (s) =>
      s.replace('const anonymousTokenResponseSchema', 'let anonymousTokenResponseSchema'),
    'schema not bound': (s) =>
      s
        .replace('const anonymousTokenResponseSchema = z.object', 'register(z.object')
        .replace('\n});', '\n}));'),
    'alias of z': (s) => `${s}\nconst s = z;\nconst other = s.array(s.string());`,
    'destructured from z': (s) => `${s}\nconst { array } = z;`,
    'element access on z': (s) => `${s}\nconst a = z["array"];`,
    'unsupported member of z': (s) => `${s}\nconst a = z.array(z.string());`,
    'z called': (s) => `${s}\nz();`,
    'z passed along': (s) => `${s}\nregister(z);`,
    'z shadowed': (s) =>
      s.replace('async function handle(responseData)', 'async function handle(z)'),
    'z redeclared': (s) => `${s}\nfunction other() { const z = makeOther(); return z.string(); }`,
    'field stored outside the object': (s) => `${s}\nconst loose = z.string();`,
    'field chained after the object': (s) => `${s}\nconst loose = z.number().int();`,
    'namespace import': (s) => s.replace('import z from "zod"', 'import * as z from "zod"'),
    'named import': (s) => s.replace('import z from "zod"', 'import { z } from "zod"'),
    'renamed default import': (s) => s.replace('import z from "zod"', 'import zod from "zod"'),
    'default and named import': (s) =>
      s.replace('import z from "zod"', 'import z, { ZodError } from "zod"'),
    'type-only import': (s) => s.replace('import z from "zod"', 'import type z from "zod"'),
    'second import': (s) => `${s}\nimport more from "zod";`,
    'subpath import': (s) => `${s}\nimport mini from "zod/mini";`,
    'v4 subpath import': (s) => `${s}\nimport { z as z4 } from "zod/v4";`,
    're-export': (s) => `${s}\nexport { z } from "zod";`,
    'export star': (s) => `${s}\nexport * from "zod";`,
    'dynamic import': (s) => `${s}\nconst lazy = import("zod");`,
    'dynamic import of a subpath': (s) => `${s}\nconst lazy = import("zod/v4");`,
    'dynamic import of a computed name': (s) => `${s}\nconst lazy = import(name);`,
    require: (s) => `${s}\nconst legacy = require("zod");`,
    'require of a subpath': (s) => `${s}\nconst legacy = require("zod/v4");`,
    'specifier kept as a string': (s) => `${s}\nconst name = "zod";`,
  }

  for (const [name, mutate] of Object.entries(mutations)) {
    test(`rejects: ${name}`, () => {
      const mutated = mutate(conforming)
      expect(mutated).not.toBe(conforming)
      expect(zodCompatibilityProblems(mutated).length).toBeGreaterThan(0)
    })
  }

  test('names the offending line', () => {
    const problems = zodCompatibilityProblems(conforming.replace('z.number()', 'z.number().int()'))
    expect(problems[0]).toMatch(/^line 4:/)
  })

  test('does not flag same-named variables in unrelated scopes', () => {
    const source = `${conforming}
function other() {
\tconst parsed = somethingElse();
\treturn parsed.error ?? parsed;
}
`
    expect(zodCompatibilityProblems(source)).toEqual([])
  })
})
