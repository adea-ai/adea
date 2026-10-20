/** Client dependency boundary shared by the Vite plugin and regression tests. */
/** @param {string} id */
export function forbiddenClientModule(id) {
  const path = id.replaceAll('\\', '/')
  return (
    /\/node_modules\/next\//.test(path) ||
    /(?:^|\/)next\/(?:dist|server|headers|navigation)(?:[/.?]|$)/.test(path) ||
    /(?:^|\/)server-only(?:\/|$|\?)/.test(path) ||
    /\/packages\/db\/(?:src|dist)\//.test(path) ||
    /\/@adea-ai\/db\//.test(path) ||
    // The published Control Plane client and schemas are host-only packages.
    /\/@adea-ai\/(?:sdk|contracts)\//.test(path) ||
    /\/apps\/web\/src\/server\//.test(path) ||
    /\/packages\/auth\/(?:src|dist)\/(?:server|start|desktop-server|desktop-http-server|config|security|better-auth-server)\./.test(
      path
    ) ||
    /\/@adea-ai\/auth\/(?:src|dist)\/(?:server|start|desktop-server|desktop-http-server|config|security|better-auth-server)\./.test(
      path
    ) ||
    /\/@neondatabase\/auth\/(?:dist\/)?(?:next\/|server\/|server\.)/.test(path) ||
    // Better Auth's server-only entry points (the framework-neutral client stays
    // allowed through `better-auth/client`).
    /\/node_modules\/better-auth\/(?:dist\/)?(?:api|adapters|db|cookies|test-utils)\//.test(path) ||
    /\/node_modules\/better-auth\/dist\/index\./.test(path) ||
    /\/apps\/web\/src\/start\/worker\.ts/.test(path) ||
    // One Solid UI stack: the React runtime and the React-only libraries it
    // replaced must never re-enter the browser graph.
    /\/node_modules\/(?:react|react-dom|scheduler)\//.test(path) ||
    /\/node_modules\/@types\/react(?:-dom)?\//.test(path) ||
    /\/node_modules\/@(?:radix-ui|base-ui)\//.test(path) ||
    /\/node_modules\/(?:next-themes|nuqs|lucide-react)\//.test(path) ||
    /\/node_modules\/@tanstack\/react-(?:query|router|start|store)\//.test(path)
  )
}

/** Native-only hosts must be absent from the rendered production web graph. */
/** @param {string} id */
export function desktopOnlyClientModule(id) {
  const path = id.replaceAll('\\', '/')
  return (
    /\/apps\/web\/src\/components\/(?:desktop-workspace-entry|desktop-first-run-chat|version-dialog)\.tsx$/.test(
      path
    ) || path.endsWith('/packages/workspace-ui/src/native-session-inventory-diagnostic.tsx')
  )
}

export const PRIVATE_ENV_NAMES = [
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'DATABASE_MIGRATION_URL',
  'AUTH_SECRET',
  'AUTH_DATABASE_URL',
  'AUTH_BASE_URL',
  // The legacy auth names stay denied while the auth lane's legacy reader, driver and
  // client SDK dependency are still in the tree. These are output deny markers: they
  // keep a name out of the browser bundle whether or not anything still reads it, and
  // removing one before the code that reads it is gone weakens the check rather than
  // proving anything. They are removed with that code, not before.
  'NEON_AUTH_COOKIE_SECRET',
  'NEON_AUTH_BASE_URL',
  'CONTROL_PLANE_API_TOKEN',
  // ADR 0013 per-request signer: the Ed25519 private key (Worker secret) and
  // its key id/issuer stay server-only.
  'CONTROL_PLANE_SIGNING_KEY',
  'CONTROL_PLANE_SIGNING_KEY_ID',
  'CONTROL_PLANE_SIGNING_ISSUER',
  'ADEA_ALLOWED_EMAILS',
]

/** Only these already-public values may be substituted into the shared browser code. */
export const PUBLIC_ENV_NAMES = [
  'ADEA_PUBLIC_WORLD_URL',
  'ADEA_PUBLIC_HQ_URL',
  'ADEA_PUBLIC_SCENE_TELEMETRY_ENDPOINT',
  'ADEA_PUBLIC_DEPLOY_GIT_COMMIT_SHA',
]
