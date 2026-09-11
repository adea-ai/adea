// Server-environment replacement for the `server-only` marker package.
//
// That package throws from its default entry unless the bundler resolves the
// `react-server` condition (Next.js does; the Workers SSR build does not), so
// importing it would crash the deployed Worker at startup. Keeping the import
// specifiers in place still documents intent, and the client graph is guarded
// separately by start/client-policy.mjs, which rejects server-only module ids
// outright.
export const SERVER_ONLY_SHIM = true
