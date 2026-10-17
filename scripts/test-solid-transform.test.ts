import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

/**
 * `scripts/test-solid-transform.ts` runs Babel inside Bun's `onLoad`. Babel installs an
 * `Error.prepareStackTrace` rewriter and raises `Error.stackTraceLimit` while it runs, and with
 * that rewriter left in place Bun's `Error.captureStackTrace` throws for any object that is not
 * an Error, which breaks `vite`. Overlapping imports must leave both globals as they were, so
 * this runs a cold process that imports several `.tsx` modules at once.
 */
test('concurrent .tsx imports leave the Error globals untouched', async () => {
  const preload = resolve(import.meta.dirname, 'test-solid-transform.ts')
  const probe = resolve(import.meta.dirname, 'test-solid-transform-fixtures/probe.ts')
  const child = Bun.spawn([process.execPath, '--conditions=browser', '--preload', preload, probe], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(stderr).toBe('')
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout.trim().split('\n').pop() ?? '')).toEqual({
    prepareStackTraceRestored: true,
    stackTraceLimitRestored: true,
    captureStackTrace: 'ok',
    vite: 'ok',
  })
}, 60_000)
