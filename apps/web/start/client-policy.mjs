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
    /\/apps\/web\/src\/server\//.test(path) ||
    /\/packages\/auth\/(?:src|dist)\/(?:server|start|desktop-server|desktop-http-server|config|security)\./.test(
      path
    ) ||
    /\/@adea-ai\/auth\/(?:src|dist)\/(?:server|start|desktop-server|desktop-http-server|config|security)\./.test(
      path
    ) ||
    /\/@neondatabase\/auth\/(?:dist\/)?(?:next\/|server\/|server\.)/.test(path) ||
    /\/apps\/web\/src\/start\/worker\.ts/.test(path)
  )
}

export const PRIVATE_ENV_NAMES = [
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'DATABASE_MIGRATION_URL',
  'NEON_AUTH_COOKIE_SECRET',
  'CONTROL_PLANE_API_TOKEN',
  'CONTROL_PLANE_SERVICE_TOKEN',
  'NEON_AUTH_BASE_URL',
  'ADEA_ALLOWED_EMAILS',
]

/** Only these already-public values may be substituted into the shared browser code. */
export const PUBLIC_ENV_NAMES = [
  'NEXT_PUBLIC_ADEA_WORLD_URL',
  'NEXT_PUBLIC_ADEA_HQ_URL',
  'NEXT_PUBLIC_SCENE_TELEMETRY_ENDPOINT',
  'NEXT_PUBLIC_DEPLOY_GIT_COMMIT_SHA',
]
