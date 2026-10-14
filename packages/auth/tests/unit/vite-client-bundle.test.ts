import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import ts from 'typescript6'

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

/** Syntax errors only: the same parse the checker runs on the adapter's files. */
function syntaxErrors(source: string): string[] {
  const { diagnostics } = ts.transpileModule(source, {
    fileName: 'adapter.mjs',
    reportDiagnostics: true,
    compilerOptions: { allowJs: true, module: ts.ModuleKind.ESNext },
  })
  return (diagnostics ?? []).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
  )
}

describe('zod compatibility guard', () => {
  test('accepts the conforming shape', () => {
    expect(syntaxErrors(conforming)).toEqual([])
    expect(zodCompatibilityProblems(conforming)).toEqual([])
  })

  test('a file that does not use zod has nothing to check', () => {
    expect(zodCompatibilityProblems('export const a = 1')).toEqual([])
  })

  // What each mutation must be rejected for. A mutation that merely failed to
  // parse, or tripped an unrelated rule, would pass a bare "has problems" check
  // without showing the guard sees the thing it is named after.
  const FIELD = 'a z.object field is not a plain z.string() or z.number()'
  const FIELD_ARGUMENTS = 'a field takes arguments or type arguments'
  const FIELDS = 'the schema fields are'
  const LOOSE = 'a field is chained, stored or used outside z.object({ ... })'
  const OBJECT_ARGUMENT = 'z.object must take exactly one object literal'
  const SCHEMA_BOUND = 'a schema is not bound directly to a const'
  const SCHEMA_USE = 'is used other than as anonymousTokenResponseSchema.safeParse(value)'
  const RESULT_READ = 'parsed is read other than as .success or .data'
  const RESULT_BOUND = 'a safeParse result is not bound to a plain variable'
  const Z_USE = 'z is used other than as z.string(), z.number() or z.object({ ... })'
  const Z_REDECLARED = 'z is redeclared, so uses of it cannot be traced'
  const IMPORT = 'zod must be imported once as a default binding named z'
  const REEXPORT = 'zod is re-exported'
  const DYNAMIC = 'zod is loaded dynamically'
  const STRING = 'the zod specifier is used as a value'

  const mutations: Record<string, readonly [(source: string) => string, string]> = {
    'chained check on a field': [(s) => s.replace('z.string()', 'z.string().min(1)'), FIELD],
    'chained modifier on a field': [(s) => s.replace('z.number()', 'z.number().int()'), FIELD],
    'optional field': [(s) => s.replace('z.string()', 'z.string().optional()'), FIELD],
    'nullable field': [(s) => s.replace('z.number()', 'z.number().nullable()'), FIELD],
    'field with an argument': [
      (s) => s.replace('z.string()', 'z.string("message")'),
      FIELD_ARGUMENTS,
    ],
    'chained on the object': [(s) => s.replace('\n});', '\n}).strict();'), SCHEMA_BOUND],
    'extend on the object': [
      (s) => s.replace('\n});', '\n}).extend({ more: z.string() });'),
      SCHEMA_BOUND,
    ],
    'unsupported field kind': [(s) => s.replace('z.number()', 'z.boolean()'), Z_USE],
    'array field': [(s) => s.replace('z.string()', 'z.array(z.string())'), Z_USE],
    'union field': [(s) => s.replace('z.number()', 'z.union([z.number(), z.string()])'), Z_USE],
    'extra field': [(s) => s.replace('z.number()', 'z.number(),\n\textra: z.string()'), FIELDS],
    'missing field': [(s) => s.replace('\ttoken: z.string(),\n', ''), FIELDS],
    'renamed field': [(s) => s.replace('expires_at', 'expiresAt'), FIELDS],
    'spread in the shape': [(s) => s.replace('\ttoken: z.string(),', '\t...base,'), FIELD],
    'shorthand field': [(s) => s.replace('\ttoken: z.string(),', '\ttoken,'), FIELD],
    'computed field name': [(s) => s.replace('\ttoken:', '\t["token"]:'), FIELD],
    'shape in a variable': [
      (s) =>
        s
          .replace('const anonymousTokenResponseSchema = z.object({', 'const shape = {')
          .replace('\n});', '\n};\nconst anonymousTokenResponseSchema = z.object(shape);'),
      OBJECT_ARGUMENT,
    ],
    'object with two arguments': [(s) => s.replace('\n});', '\n}, {});'), OBJECT_ARGUMENT],
    'strict parse': [
      (s) => s.replace('.safeParse(responseData)', '.parse(responseData)'),
      SCHEMA_USE,
    ],
    'async parse': [
      (s) => s.replace('.safeParse(responseData)', '.safeParseAsync(responseData)'),
      SCHEMA_USE,
    ],
    'safeParse with a second argument': [
      (s) => s.replace('.safeParse(responseData)', '.safeParse(responseData, {})'),
      SCHEMA_USE,
    ],
    'schema read as a value': [(s) => `${s}\nexport { anonymousTokenResponseSchema };`, SCHEMA_USE],
    'schema passed along': [(s) => `${s}\nregister(anonymousTokenResponseSchema);`, SCHEMA_USE],
    'schema shape accessed': [
      (s) => `${s}\nconst keys = anonymousTokenResponseSchema.shape;`,
      SCHEMA_USE,
    ],
    'schema infer helper': [
      (s) => `${s}\nconst again = anonymousTokenResponseSchema.parse;`,
      SCHEMA_USE,
    ],
    'result error read': [(s) => s.replace('cache(parsed.data)', 'log(parsed.error)'), RESULT_READ],
    'result passed along': [(s) => s.replace('cache(parsed.data)', 'cache(parsed)'), RESULT_READ],
    'result destructured': [
      (s) =>
        s
          .replace('const parsed =', 'const { success, data } =')
          .replace('if (parsed.success) cache(parsed.data);', 'if (success) cache(data);'),
      RESULT_BOUND,
    ],
    'result not bound': [
      (s) =>
        s.replace(
          'const parsed = anonymousTokenResponseSchema.safeParse(responseData);\n\tif (parsed.success) cache(parsed.data);',
          'cache(anonymousTokenResponseSchema.safeParse(responseData));'
        ),
      RESULT_BOUND,
    ],
    'schema not const': [
      (s) => s.replace('const anonymousTokenResponseSchema', 'let anonymousTokenResponseSchema'),
      SCHEMA_BOUND,
    ],
    'schema not bound': [
      (s) =>
        s
          .replace('const anonymousTokenResponseSchema = z.object', 'register(z.object')
          .replace('\n});', '\n}));'),
      SCHEMA_BOUND,
    ],
    'alias of z': [(s) => `${s}\nconst s = z;\nconst other = s.array(s.string());`, Z_USE],
    'destructured from z': [(s) => `${s}\nconst { array } = z;`, Z_USE],
    'element access on z': [(s) => `${s}\nconst a = z["array"];`, Z_USE],
    'unsupported member of z': [(s) => `${s}\nconst a = z.array(z.string());`, Z_USE],
    'z called': [(s) => `${s}\nz();`, Z_USE],
    'z passed along': [(s) => `${s}\nregister(z);`, Z_USE],
    'z shadowed': [
      (s) => s.replace('async function handle(responseData)', 'async function handle(z)'),
      Z_REDECLARED,
    ],
    'z redeclared': [
      (s) => `${s}\nfunction other() { const z = makeOther(); return z.string(); }`,
      Z_REDECLARED,
    ],
    'field stored outside the object': [(s) => `${s}\nconst loose = z.string();`, LOOSE],
    'field chained after the object': [(s) => `${s}\nconst loose = z.number().int();`, LOOSE],
    'namespace import': [
      (s) => s.replace('import z from "zod"', 'import * as z from "zod"'),
      IMPORT,
    ],
    'named import': [(s) => s.replace('import z from "zod"', 'import { z } from "zod"'), IMPORT],
    'renamed default import': [
      (s) => s.replace('import z from "zod"', 'import zod from "zod"'),
      IMPORT,
    ],
    'default and named import': [
      (s) => s.replace('import z from "zod"', 'import z, { ZodError } from "zod"'),
      IMPORT,
    ],
    'second import': [(s) => `${s}\nimport more from "zod";`, IMPORT],
    'subpath import': [(s) => `${s}\nimport mini from "zod/mini";`, IMPORT],
    'v4 subpath import': [(s) => `${s}\nimport { z as z4 } from "zod/v4";`, IMPORT],
    're-export': [(s) => `${s}\nexport { z } from "zod";`, REEXPORT],
    'export star': [(s) => `${s}\nexport * from "zod";`, REEXPORT],
    'dynamic import': [(s) => `${s}\nconst lazy = import("zod");`, DYNAMIC],
    'dynamic import of a subpath': [(s) => `${s}\nconst lazy = import("zod/v4");`, DYNAMIC],
    'dynamic import of a computed name': [(s) => `${s}\nconst lazy = import(name);`, DYNAMIC],
    require: [(s) => `${s}\nconst legacy = require("zod");`, DYNAMIC],
    'require of a subpath': [(s) => `${s}\nconst legacy = require("zod/v4");`, DYNAMIC],
    'specifier kept as a string': [(s) => `${s}\nconst name = "zod";`, STRING],
  }

  for (const [name, [mutate, problem]] of Object.entries(mutations)) {
    test(`rejects: ${name}`, () => {
      const mutated = mutate(conforming)
      expect(mutated).not.toBe(conforming)
      // The checker reads broken source without complaint, so a malformed
      // fixture would be rejected for the wrong reason; it has to be valid.
      expect(syntaxErrors(mutated)).toEqual([])
      const problems = zodCompatibilityProblems(mutated)
      expect(problems.some((found) => found.includes(problem))).toBe(true)
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
