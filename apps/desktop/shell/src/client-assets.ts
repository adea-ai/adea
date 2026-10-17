import { realpath, stat } from 'node:fs/promises'
import { extname, join, posix, relative, resolve, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

const unavailable = (status = 404) =>
  new Response(null, { status, headers: { 'cache-control': 'no-store' } })

/** One decoded logical path controls both admission and filesystem resolution. */
export async function serveDesktopClient(
  request: Request,
  clientRoot: string,
  transformHtml: (html: string, request: Request) => string = (html) => html
): Promise<Response> {
  let logical: string
  try {
    logical = posix.normalize(
      '/' + decodeURIComponent(new URL(request.url).pathname).replaceAll('\\', '/')
    )
  } catch {
    return unavailable()
  }
  if (logical.includes('\0')) return unavailable()
  const folded = logical.toLowerCase()
  // Case folding also covers case-insensitive desktop filesystems. This runs
  // before any disk access, including for a stale pack in the client tree.
  if (folded === '/assets/agent-sim' || folded.startsWith('/assets/agent-sim/'))
    return unavailable()

  const root = await realpath(clientRoot)
  let filePath = resolve(root, '.' + logical)
  const inside = (path: string) => path === root || path.startsWith(root + sep)
  if (!inside(filePath)) return unavailable(403)
  let metadata = await stat(filePath).catch(() => null)
  if (metadata?.isDirectory()) {
    filePath = join(filePath, 'index.html')
    metadata = await stat(filePath).catch(() => null)
  }
  if (!metadata?.isFile()) {
    if (folded === '/assets' || folded.startsWith('/assets/')) return unavailable()
    filePath = join(root, 'index.html')
  }
  const physical = await realpath(filePath).catch(() => null)
  if (!physical) return unavailable()
  if (!inside(physical)) return unavailable(403)
  const physicalRelative = relative(root, physical).replaceAll('\\', '/').toLowerCase()
  if (physicalRelative === 'assets/agent-sim' || physicalRelative.startsWith('assets/agent-sim/'))
    return unavailable()
  let body = new Uint8Array(await Bun.file(physical).arrayBuffer())
  if (extname(physical).toLowerCase() === '.html') {
    body = new TextEncoder().encode(transformHtml(new TextDecoder().decode(body), request))
  }
  return new Response(body, {
    headers: {
      'content-type': MIME[extname(physical).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    },
  })
}
