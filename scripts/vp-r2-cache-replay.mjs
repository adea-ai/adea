#!/usr/bin/env node
// A reproducible replay of the pinned Vite+ client against the shared task-cache transport.
//
// The proof has three steps, in this order:
//
//   1. the pinned client runs a task and stores its output archive in the transport;
//   2. the **local task cache and the generated outputs are both removed**, so nothing is left that could satisfy
//      the replay locally;
//   3. the pinned client runs the same task again and has to fetch the entry from the transport.
//
// The replay only counts when the client says it took a remote cache hit and when the restored bytes are the bytes
// the first run wrote.
//
// The harness is offline: the transport is served on loopback over an in-memory store, the client is the pinned
// `vite-plus` package of this checkout, and the project it runs in is a throwaway directory that is removed at the end.
// Nothing outside the temporary directory is written, and no credential, endpoint or deployment is involved.
//
//   node scripts/vp-r2-cache-replay.mjs            (prints the result as JSON)
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LIMITS, createTransport, handleRemoteCache, trustDomain } from './vp-r2-cache.mjs'
import { createMemoryStore } from './vp-r2-cache-fixtures.mjs'

/** The digest of a set of bytes. */
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** The bytes the replayed task writes. They are written and read back byte for byte. */
const PAYLOAD = Buffer.from('adea-vp-r2-replay-payload\n', 'utf8')

/** The runtime that runs the pinned client: node when it is there, the running runtime otherwise. */
export function clientRuntime() {
  const probe = spawnSync('node', ['--version'], { encoding: 'utf8' })
  if (probe.status === 0) return 'node'
  return process.execPath
}

/** The pinned client of this checkout: the `vite-plus` package and the version the manifest asks for. */
export function pinnedClient(root) {
  const manifest = join(root, 'node_modules', 'vite-plus', 'package.json')
  if (!existsSync(manifest)) return null
  const installed = JSON.parse(readFileSync(manifest, 'utf8')).version
  const asked = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies?.[
    'vite-plus'
  ]
  if (!asked || !asked.includes(installed)) return null
  return { version: installed, asked, bin: join(root, 'node_modules', 'vite-plus', 'bin', 'vp') }
}

/** Serves the transport on loopback, over an in-memory store, for the duration of the replay. */
export async function serveTransport(scope, store) {
  const transport = createTransport({ scope, store })
  const server = createServer((request, response) => {
    const chunks = []
    let size = 0
    let refused = false
    request.on('data', (chunk) => {
      // The adapter bounds the input it buffers: it never holds more than the transport accepts. What is over the
      // bound is drained, not kept, so the answer that follows is a single valid one.
      size += chunk.length
      if (size > LIMITS.maxRequestBytes) {
        refused = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (refused) {
        response.writeHead(413, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'the request is larger than the limit' }))
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (process.env.VP_R2_REPLAY_DEBUG)
        console.error('DEBUG request', request.method, url.pathname, 'bytes', chunks.length)
      handleRemoteCache(
        {
          method: request.method,
          path: url.pathname,
          headers: request.headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        },
        transport,
        { enabled: true, authorize: () => ({ allow: true, scope: scope.id }) }
      )
        .then((answer) => {
          response.writeHead(answer.status, answer.headers)
          response.end(answer.body.length ? answer.body : undefined)
        })
        .catch(() => {
          response.writeHead(500)
          response.end()
        })
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  return { port, close: () => new Promise((done) => server.close(done)) }
}

/**
 * Runs the pinned client once and returns what it printed and how it ended. The client runs in its own process and the
 * run is awaited rather than blocked on: the transport is served by this process, so the event loop has to keep
 * running while the client talks to it.
 */
function runClient({ root, project, runtime, port, cache }) {
  return new Promise((done) => {
    const child = spawn(
      runtime,
      [join(root, 'node_modules', 'vite-plus', 'bin', 'vp'), 'run', 'emit'],
      {
        cwd: project,
        env: {
          ...process.env,
          VP_REMOTE_CACHE_URL: `http://127.0.0.1:${port}`,
          VP_REMOTE_CACHE: 'read-write',
          VITE_CACHE_PATH: cache,
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString()
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
    timer.unref?.()
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, output })
    })
  })
}

/**
 * Runs the replay. It returns `{ skipped: true }` when the pinned client is not installed in this checkout, so a
 * checkout without dependencies reports that plainly instead of failing.
 */
export async function replayPinnedClient({
  root = resolve(fileURLToPath(import.meta.url), '../..'),
} = {}) {
  const client = pinnedClient(root)
  if (!client)
    return {
      skipped: true,
      reason: 'the pinned vite-plus client is not installed in this checkout',
    }
  const runtime = clientRuntime()
  const scope = trustDomain({
    namespace: 'adea-ai/adea',
    client: client.version,
    toolchain: 'vp-r2-cache-replay',
  })
  const store = createMemoryStore()
  const project = mkdtempSync(join(realpathSync(tmpdir()), 'vp-r2-replay-'))
  const cache = join(project, 'task-cache')
  const payload = PAYLOAD.toString('base64')
  try {
    mkdirSync(join(project, 'node_modules'), { recursive: true })
    // The output directory is part of the fixture, not of the task's output: the task writes one file into it. The
    // replay removes that file, and the workspace shape stays the same, so the entry's own fingerprint still holds.
    mkdirSync(join(project, 'out'), { recursive: true })
    symlinkSync(join(root, 'node_modules', 'vite-plus'), join(project, 'node_modules', 'vite-plus'))
    writeFileSync(
      join(project, 'package.json'),
      `${JSON.stringify({ name: 'vp-r2-replay', private: true, type: 'module', version: '0.0.0' }, null, 2)}\n`
    )
    writeFileSync(
      join(project, 'vite.config.ts'),
      [
        "import { defineConfig } from 'vite-plus'",
        '',
        'export default defineConfig({',
        '  run: {',
        '    tasks: {',
        '      emit: {',
        `        command: ${JSON.stringify(
          `${runtime} -e "require('fs').mkdirSync('out',{recursive:true});require('fs').writeFileSync('out/payload.bin',Buffer.from('${payload}','base64'))"`
        )},`,
        '        cache: {',
        // The task writes `out/` itself, so the listing of `out` and the workspace root entry for it are not
        // inputs: the replay removes the generated outputs, and the entry has to survive that.
        "          input: [{ auto: true }, '!out', '!out/**'],",
        "          output: ['out/**'],",
        '        },',
        '      },',
        '    },',
        '  },',
        '})',
        '',
      ].join('\n')
    )

    const bridge = await serveTransport(scope, store)
    try {
      const first = await runClient({ root, project, runtime, port: bridge.port, cache })
      if (first.code !== 0)
        return { skipped: false, failed: 'the first run did not finish', output: first.output }
      const produced = join(project, 'out', 'payload.bin')
      if (!existsSync(produced))
        return { skipped: false, failed: 'the first run wrote no output', output: first.output }
      const expected = readFileSync(produced)

      // The local task cache and the generated output are both removed, so the second run can only be served by the
      // transport: there is no local entry and no output file left to restore.
      rmSync(cache, { recursive: true, force: true })
      rmSync(produced, { force: true })
      const localCacheRemoved = !existsSync(cache)
      const outputsRemoved = !existsSync(produced)

      const second = await runClient({ root, project, runtime, port: bridge.port, cache })
      if (second.code !== 0)
        return { skipped: false, failed: 'the replay run did not finish', output: second.output }
      const restored = existsSync(produced) ? readFileSync(produced) : null
      return {
        skipped: false,
        client: client.version,
        runtime,
        localCacheRemoved,
        outputsRemoved,
        firstExitCode: first.code,
        secondExitCode: second.code,
        remoteHit: /remote cache hit/i.test(second.output),
        restored: restored !== null,
        bytesMatch: restored !== null && restored.equals(expected),
        sha256: restored === null ? null : digest(restored),
        expectedSha256: digest(expected),
        output: second.output,
      }
    } finally {
      await bridge.close()
    }
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await replayPinnedClient()
  console.log(JSON.stringify(result, null, 2))
  const passed =
    result.skipped === true ||
    (result.remoteHit === true && result.bytesMatch === true && result.localCacheRemoved === true)
  process.exitCode = passed ? 0 : 1
}
