// shell-bench Deno Desktop parity shell (CEF backend). The window auto-binds to
// this Deno.serve handler, which proxies everything to the bench server on
// :14209 (static client + /__bench endpoints). Disposable — deleted by #371.

const UPSTREAM = 'http://127.0.0.1:1420'

Deno.serve((req: Request) => {
  const incoming = new URL(req.url)
  // Navigations go straight to the bench origin (the window is the shell; the
  // bench server owns the page, shim, and endpoints). Subresources that arrive
  // here are proxied.
  if (incoming.pathname === '/' || incoming.pathname === '/index.html') {
    return Response.redirect(`${UPSTREAM}/`, 302)
  }
  return Response.redirect(`${UPSTREAM}${incoming.pathname}${incoming.search}`, 307)
})
