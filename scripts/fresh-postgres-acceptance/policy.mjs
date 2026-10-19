// Test-only target policy. The runner accepts no externally supplied database URL.
export function assertProvisionedLoopback(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('invalid provisioner target')
  }
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.port === '0' ||
    url.pathname !== '/postgres' ||
    url.username !== 'postgres' ||
    !url.password ||
    url.hash ||
    url.search !== '?sslmode=disable'
  ) {
    throw new Error('expected exact provisioner-owned loopback PostgreSQL target')
  }
  return value
}

function processEnvironment(inherited) {
  const result = {}
  // Deliberately exclude inherited database/auth/mail/provider/PG routing settings.
  for (const key of ['PATH', 'TMPDIR', 'LANG']) {
    if (inherited[key]) result[key] = inherited[key]
  }
  return result
}

export function fixtureEnvironment(provisionedUrl, inherited = process.env) {
  assertProvisionedLoopback(provisionedUrl)
  return {
    ...processEnvironment(inherited),
    MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL: provisionedUrl,
  }
}

export function memoryEnvironment(sourceRoot, inherited = process.env) {
  return {
    ...processEnvironment(inherited),
    FRESH_AUTH_ACCEPTANCE: '1',
    FRESH_AUTH_SOURCE_ROOT: sourceRoot,
  }
}

export function assertLocalDockerEndpoint(value) {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    (!value.startsWith('unix:///') && !value.startsWith('npipe:////./pipe/'))
  ) {
    throw new Error('fresh-schema provisioning requires a local Docker socket endpoint')
  }
  return value
}

// inspect reads context metadata only; it must never contact a Docker daemon.
export function resolveLocalDockerEndpoint(inherited, inspect) {
  if (inherited.DOCKER_TLS_VERIFY || inherited.DOCKER_CERT_PATH) {
    throw new Error('fresh-schema provisioning refuses Docker TLS overrides')
  }
  if (inherited.DOCKER_HOST) assertLocalDockerEndpoint(inherited.DOCKER_HOST)
  let contextEndpoint
  try {
    contextEndpoint = JSON.parse(inspect())
  } catch {
    throw new Error('could not inspect the selected Docker context endpoint')
  }
  assertLocalDockerEndpoint(contextEndpoint)
  // Reject remote configured targets even if another override would hide them.
  return inherited.DOCKER_CONTEXT ? contextEndpoint : inherited.DOCKER_HOST || contextEndpoint
}
