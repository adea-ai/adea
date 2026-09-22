// Measure the sidecar entry used by the packaged build against the source
// entry. Each launch gets a fresh data directory and is stopped before the
// next one, so no prior endpoint or live sidecar affects the measurement.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shellRoot = join(desktopRoot, 'shell')
const source = join(shellRoot, 'src/dev-runtime/terminal/sidecar/entry.ts')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'adea-sidecar-startup-'))
const bundleDir = join(temporaryRoot, 'bundle')
const bundle = join(bundleDir, 'entry.js')
const launches = []
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]
let measurementError
let cleanupError

try {
  const build = Bun.spawnSync(
    [process.execPath, 'build', source, '--outdir', bundleDir, '--target=bun', '--minify'],
    { cwd: shellRoot, stdout: 'pipe', stderr: 'pipe' }
  )
  if (build.exitCode !== 0 || !existsSync(bundle))
    throw new Error(`sidecar bundle failed: ${build.stderr.toString().slice(0, 1000)}`)

  async function launch(label, entry, index) {
    const dataDir = join(temporaryRoot, `${label}-${index}`)
    const endpoint = join(dataDir, 'dev-runtime/terminal-sidecar/endpoint.json')
    const started = performance.now()
    const proc = Bun.spawn([process.execPath, entry, '--data-dir', dataDir], {
      cwd: shellRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    launches.push({ pid: proc.pid, proc, dataDir })
    const deadline = started + 10_000
    while (!existsSync(endpoint) && performance.now() < deadline) {
      if (proc.exitCode !== null)
        throw new Error(`${label} exited before writing an endpoint (code ${proc.exitCode})`)
      await Bun.sleep(2)
    }
    if (!existsSync(endpoint)) throw new Error(`${label} did not write an endpoint within 10s`)
    const observed = JSON.parse(readFileSync(endpoint, 'utf8'))
    if (observed.pid !== proc.pid) throw new Error(`${label} endpoint PID did not match launch`)
    const elapsedMs = performance.now() - started
    console.log(JSON.stringify({ label, run: index, pid: proc.pid, elapsedMs }))
    proc.kill('SIGTERM')
    let forced = false
    const timeout = setTimeout(() => {
      forced = true
      proc.kill('SIGKILL')
    }, 6_000)
    await proc.exited
    clearTimeout(timeout)
    if (forced) throw new Error(`${label} sidecar did not stop within 6s`)
    return elapsedMs
  }

  const results = { source: [], bundle: [] }
  for (let index = 1; index <= 5; index++) {
    results.source.push(await launch('source', source, index))
    results.bundle.push(await launch('bundle', bundle, index))
  }
  console.log(
    JSON.stringify({
      bun: Bun.version,
      platform: `${process.platform}-${process.arch}`,
      sourceMedianMs: median(results.source),
      bundleMedianMs: median(results.bundle),
      bundleMinusSourceMs: median(results.bundle) - median(results.source),
    })
  )
} catch (error) {
  measurementError = error
} finally {
  for (const { proc } of launches) {
    try {
      if (proc.exitCode === null) {
        proc.kill('SIGTERM')
        const timeout = setTimeout(() => proc.kill('SIGKILL'), 1_000)
        await proc.exited
        clearTimeout(timeout)
      }
    } catch {
      // The process may already be gone. The final PID check below remains
      // the authority for this measurement's cleanup report.
    }
  }
  for (const { pid } of launches) {
    try {
      process.kill(pid, 0)
      cleanupError ??= new Error(`task-owned sidecar PID ${pid} is still alive`)
    } catch (error) {
      if (error?.code !== 'ESRCH') cleanupError ??= error
    }
  }
  try {
    rmSync(temporaryRoot, { recursive: true, force: true })
  } catch (error) {
    cleanupError ??= error
  }
}
if (cleanupError) throw cleanupError
if (measurementError) throw measurementError
