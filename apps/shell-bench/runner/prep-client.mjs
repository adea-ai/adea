// Prepares the Tauri bench client: copies apps/desktop/dist into the Tauri
// shell's frontendDist with (1) the ready beacon injected (absolute bench
// origin, since the page itself is served from tauri://localhost) and (2) the
// baked cloud origin rewritten to the bench server origin (proxied). The page
// must be LOCAL to the Tauri shell because remote pages cannot invoke
// application commands in Tauri v2. Disposable — deleted by #371.
import { readdir, readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BENCH_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = dirname(dirname(BENCH_ROOT))
const SRC = join(REPO_ROOT, 'apps', 'desktop', 'dist')
const DEST = join(BENCH_ROOT, 'tauri', 'src-tauri', 'dist-client')
const BENCH_ORIGIN = 'http://127.0.0.1:1420'
const CLOUD_ORIGIN = 'https://adea.dev'

async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true })
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(s, d)
    } else if (entry.name.endsWith('.js')) {
      const body = await readFile(s, 'utf8')
      await writeFile(d, body.split(CLOUD_ORIGIN).join(BENCH_ORIGIN))
    } else {
      await cp(s, d)
    }
  }
}

if (!existsSync(join(SRC, 'index.html'))) {
  console.error(`client dist missing at ${SRC} — run \`bun run build\` in apps/desktop first`)
  process.exit(1)
}

await rm(DEST, { recursive: true, force: true })
await copyDir(SRC, DEST)

const beacon = `<script>
(function () {
  var ORIGIN = '${BENCH_ORIGIN}'
  function post(path, payload) {
    try {
      return fetch(ORIGIN + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        mode: 'cors',
        keepalive: true,
      })
    } catch (e) {}
  }
  function navPayload() {
    var nav = performance.getEntriesByType('navigation')[0]
    return {
      performanceNowMs: Math.round(performance.now()),
      domContentLoadedEventEndMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      loadEventEndMs: nav ? Math.round(nav.loadEventEnd) : null,
      title: document.title,
      url: location.href,
    }
  }
  function ready() { post('/__bench/ready', navPayload()) }
  function booted() {
    var main = document.querySelector('main.conventional-workspace')
    return main && !main.classList.contains('conventional-workspace--loading')
  }
  function poll(pred, ms, timeout) {
    return new Promise(function (resolve) {
      var start = performance.now()
      var t = setInterval(function () {
        var v = pred()
        if (v || performance.now() - start > timeout) { clearInterval(t); resolve(v) }
      }, ms)
    })
  }
  if (document.readyState === 'complete') setTimeout(ready, 0)
  else window.addEventListener('load', function () { setTimeout(ready, 0) })
  poll(booted, 250, 60000).then(function (ok) {
    if (!ok) return
    var bootedMs = Math.round(performance.now())
    var toggle = document.querySelector('[aria-label="Virtual view"]')
    if (toggle) { try { toggle.click() } catch (e) {} }
    poll(function () { return document.querySelector('.virtual-view-engine') }, 250, 15000)
      .then(function () {
        post('/__bench/workspace', {
          bootedMs: bootedMs,
          virtualMs: Math.round(performance.now()),
          virtualEnginePresent: !!document.querySelector('.virtual-view-engine'),
        })
      })
  })
})()
</script>`
if (!index.includes('__bench/ready')) {
  index = index.replace('</body>', beacon + '</body>')
}
await writeFile(join(DEST, 'index.html'), index)

console.log(`prepared ${DEST}`)
