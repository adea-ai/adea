/*
 * `@neondatabase/auth` imports all of zod for one three-field schema (the
 * anonymous token response), which puts ~124 KB of zod core into the startup
 * chunk. In the client build only, the adapter's `zod` import resolves to this
 * stand-in, which implements exactly the calls the adapter makes:
 * `z.object({ ... })` of `z.string()` / `z.number()` fields and `.safeParse`.
 * `scripts/neon-auth-zod-lite.test.ts` fails if the installed adapter starts
 * calling anything else, and checks this stand-in against real zod.
 */
export const ZOD_LITE_ID = '\0adea-neon-auth-zod-lite'

export const zodLiteSource = `
const field = (type) => ({ type })
const accepts = (field, value) =>
  field.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === 'string'
const z = {
  string: () => field('string'),
  number: () => field('number'),
  object: (shape) => ({
    safeParse(input) {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) return { success: false }
      const data = {}
      for (const [key, schema] of Object.entries(shape)) {
        if (!accepts(schema, input[key])) return { success: false }
        data[key] = input[key]
      }
      return { success: true, data }
    },
  }),
}
export default z
`

const NEON_AUTH_DIST = /[\\/]@neondatabase[\\/]auth[\\/]dist[\\/]/

/** Vite plugin: client environment only; the server keeps real zod. */
export function neonAuthZodLite() {
  return {
    name: 'adea-neon-auth-zod-lite',
    enforce: 'pre',
    applyToEnvironment: (environment) => environment.name === 'client',
    resolveId(source, importer) {
      return source === 'zod' && importer && NEON_AUTH_DIST.test(importer) ? ZOD_LITE_ID : null
    },
    load(id) {
      return id === ZOD_LITE_ID ? zodLiteSource : null
    },
  }
}
