/*
 * Build-time trim for the browser bundle, kept here because it is specific to
 * the auth provider's package (provider imports stay inside this package).
 *
 * The provider's client adapter imports all of zod for one three-field schema
 * (the anonymous token response), which puts ~124 KB of zod core into the
 * startup chunk. In the client build only, that adapter's `zod` import resolves
 * to `zodLiteSource`, which implements exactly the calls the adapter makes:
 * `z.object({ ... })` of `z.string()` / `z.number()` fields and `.safeParse`.
 * `tests/unit/vite-client-bundle.test.ts` fails if the installed adapter starts
 * calling anything else, and checks the stand-in against real zod.
 */
export const ZOD_LITE_ID = '\0adea-auth-zod-lite'

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

const ADAPTER_DIST = /[\\/]@neondatabase[\\/]auth[\\/]dist[\\/]/

/** A Vite plugin; typed structurally so this package does not depend on Vite. */
export type AuthZodLitePlugin = Readonly<{
  name: string
  enforce: 'pre'
  applyToEnvironment(environment: { name: string }): boolean
  resolveId(source: string, importer?: string): string | null
  load(id: string): string | null
}>

/** Client environment only; the server keeps real zod. */
export function authZodLite(): AuthZodLitePlugin {
  return {
    name: 'adea-auth-zod-lite',
    enforce: 'pre',
    applyToEnvironment: (environment) => environment.name === 'client',
    resolveId: (source, importer) =>
      source === 'zod' && importer !== undefined && ADAPTER_DIST.test(importer)
        ? ZOD_LITE_ID
        : null,
    load: (id) => (id === ZOD_LITE_ID ? zodLiteSource : null),
  }
}
