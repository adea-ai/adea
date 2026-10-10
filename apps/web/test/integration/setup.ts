import { mock } from 'bun:test'

// Test-process framework stubs for server-route integration tests. The
// TanStack entrypoints evaluate client-gated modules at import time,
// which cannot load under bun's server runtime. These stubs stand in
// for framework WIRING only (route registration, request-context
// plumbing); every fence line under test — principal resolution,
// authorization, parsing, admission — runs for real. The stubbed
// request-context helpers throw if ever called, so no test can
// silently depend on framework behavior. Loaded via:
//   bun test --conditions=react-server \
//     --preload ./apps/web/test/integration/setup.ts <file>
mock.module('@tanstack/solid-router', () => ({
  createFileRoute: (path: string) => (config: unknown) => ({ path, config }),
}))
mock.module('@tanstack/solid-start/server', () => ({
  getRequest: () => {
    throw new Error('framework request context unavailable in tests')
  },
  setCookie: () => {
    throw new Error('framework request context unavailable in tests')
  },
}))
