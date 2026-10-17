import { resolve } from 'node:path'

// Run in a cold `bun --preload` process by scripts/test-solid-transform.test.ts. The Solid
// transform (Babel) runs once per `.tsx` module; the imports below overlap on purpose. The modules
// hold no JSX because the repository root does not depend on solid-js. `vite` is resolved from
// `apps/web`, which declares it.
const original = {
  prepareStackTrace: Error.prepareStackTrace,
  stackTraceLimit: Error.stackTraceLimit,
}

await Promise.all(['./a.tsx', './b.tsx', './c.tsx', './d.tsx'].map((file) => import(file)))

const report = {
  prepareStackTraceRestored: Error.prepareStackTrace === original.prepareStackTrace,
  stackTraceLimitRestored: Error.stackTraceLimit === original.stackTraceLimit,
  captureStackTrace: 'ok' as string,
  vite: 'ok' as string,
}
try {
  Error.captureStackTrace({})
} catch (error) {
  report.captureStackTrace = String(error)
}
try {
  await import(Bun.resolveSync('vite', resolve(import.meta.dirname, '../../apps/web')))
} catch (error) {
  report.vite = String(error)
}
console.log(JSON.stringify(report))
