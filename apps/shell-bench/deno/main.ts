// shell-bench Deno Desktop parity shell (CEF backend). The window auto-binds to
// this Deno.serve handler, which proxies everything to the bench server on
// :14209 (static client + /__bench endpoints). Disposable — deleted by #371.

const UPSTREAM = 'http://127.0.0.1:14209'

Deno.serve(async (req: Request) => {
  const incoming = new URL(req.url)
  const target = `${UPSTREAM}${incoming.pathname}${incoming.search}`
  const headers = new Headers(req.headers)
  headers.delete('host')
  headers.delete('origin')
  headers.delete('referer')
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
      // @ts-ignore duplex is required by undici for streaming request bodies
      duplex: 'half',
    })
    const responseHeaders = new Headers(upstream.headers)
    responseHeaders.delete('content-encoding')
    responseHeaders.delete('content-length')
    responseHeaders.delete('transfer-encoding')
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    })
  } catch {
    return new Response('bench upstream unavailable', { status: 502 })
  }
})
