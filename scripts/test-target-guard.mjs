// Fail-closed targets for tests and dev probes.
//
// A test run must reach only local services (loopback Postgres and web servers).
// A database URL or base URL inherited from a developer's shell or an agent's
// environment can point at production; nothing in the test lanes may then run
// against it silently. Everything that is not provably local is refused unless
// the caller names the exact host in ADEA_ALLOW_REMOTE_TEST_TARGET, and the
// production hosts are refused even then.
//
// The pull-request database lane proves a disposable loopback instance and
// nothing else, so no CI lane supplies a remote database host: there is no
// ephemeral branch, no provider API and no CI-provided host allowlist.
//
// A developer may still name one exact host in ADEA_ALLOW_REMOTE_TEST_TARGET,
// exactly as before this change, and that host is then accepted. A production
// host is never accepted, however it is named.
//
// Errors name the variable and the host, never the credentials in the URL.

/** Variables that carry a Postgres connection string into test lanes. */
export const DATABASE_TARGET_VARIABLES = [
  'AUTH_DATABASE_URL',
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'DATABASE_MIGRATION_URL',
  'MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL',
]

/** Variables that point a suite at an already-running server. */
const HTTP_TARGET_VARIABLES = [
  'PERF_BASE_URL',
  'ADEA_ACCEPTANCE_URL',
  'CONTROL_PLANE_ORIGIN',
  'AUTH_BASE_URL',
]

/**
 * Hosts that serve production. No allowance variable and no CI host list can
 * make a test target of these; `ADEA_PRODUCTION_TARGET_HOSTS` (comma-separated)
 * adds more, such as the production database hosts, which this repository does
 * not record. `apps/web/test/cloudflare-config.test.ts` pins the Worker's
 * production origins to this list.
 */
export const PRODUCTION_TARGET_HOSTS = [
  'adea.dev',
  'www.adea.dev',
  'updates.adea.dev',
  'adea-web.adea-ai.workers.dev',
  'control-planecontrol-api-production.up.railway.app',
]

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost')
}

function hostList(value) {
  return (value ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
}

function productionHosts(env) {
  return new Set([...PRODUCTION_TARGET_HOSTS, ...hostList(env.ADEA_PRODUCTION_TARGET_HOSTS)])
}

function dropPort(entry) {
  // `[::1]:5432` -> `[::1]`; `host:5432` -> `host`.
  if (entry.startsWith('[')) return entry.slice(0, entry.indexOf(']') + 1) || entry
  return entry.split(':')[0]
}

/**
 * Where postgres.js 3.4.9 will actually connect for `value`, worked out the
 * way the driver does it (`parseUrl`/`parseOptions` in its `src/index.js`):
 *
 * - the host comes from the URL authority only. A `?host=` or `?hostaddr=`
 *   query parameter is NOT transport: the driver forwards it to the server as
 *   a startup parameter and keeps connecting to the authority host.
 * - an empty authority (`postgresql:///db`) falls back to the inherited
 *   `PGHOST`, then `localhost`. So a socket-looking URL with no host reaches
 *   whatever `PGHOST` names.
 * - a comma-separated authority lists several hosts, tried in turn.
 * - a percent-encoded authority (`%2Fvar%2Frun%2Fpostgresql`) is a literal
 *   host name, not a socket directory.
 *
 * `ambiguous` is set for anything the driver would not read the way the URL
 * suggests (the query parameters above), so the caller can refuse it.
 */
export function effectiveDatabaseTarget(value, env = process.env) {
  if (typeof value !== 'string') return undefined
  if (!/^postgres(?:ql)?:\/\//.test(value)) return undefined

  const afterScheme = value.slice(value.indexOf('://') + 3)
  const authority = afterScheme.split(/[?/]/)[0]
  let hostPart
  try {
    hostPart = decodeURIComponent(authority.slice(authority.indexOf('@') + 1))
  } catch {
    return undefined
  }
  // The driver parses the URL with a multi-host list cut down to its first host.
  let url
  try {
    url = new URL(value.replace(hostPart, hostPart.split(',')[0]))
  } catch {
    return undefined
  }
  let hosts = hostPart.includes(',') ? hostPart.split(',').map(dropPort) : [url.hostname]
  hosts = hosts.map((host) => host.trim().toLowerCase())
  let source = 'url'
  if (hosts.every((host) => host === '')) {
    hosts = hostList(env.PGHOST ?? '').map(dropPort)
    source = 'PGHOST'
    if (hosts.length === 0) hosts = ['localhost']
  }
  let role = ''
  try {
    role = decodeURIComponent(url.username)
  } catch {
    // An undecodable role is not a CI role.
  }
  const ambiguous = url.searchParams.has('host') || url.searchParams.has('hostaddr')
  return { hosts, role, ambiguous, source }
}

function isLocalDatabaseHost(host) {
  // A socket directory can only come from PGHOST; it is a local transport.
  return isLoopbackHost(host) || host.startsWith('/')
}

/**
 * 'local' (every effective host is loopback or a unix socket), 'production'
 * (a known production host), or 'remote' (anything else, including a value
 * that does not parse or whose host is ambiguous).
 */
export function classifyDatabaseTarget(value, env = process.env) {
  const target = effectiveDatabaseTarget(value, env)
  if (!target) return 'remote'
  const denied = productionHosts(env)
  if (target.hosts.some((host) => denied.has(host))) return 'production'
  if (target.ambiguous) return 'remote'
  if (target.hosts.every(isLocalDatabaseHost)) return 'local'
  return 'remote'
}

/**
 * 'local' (an HTTP(S) URL on loopback), 'production' (a host this repository
 * knows to serve production), or 'remote'.
 */
export function classifyHttpTarget(value, env = process.env) {
  let url
  try {
    url = new URL(value)
  } catch {
    return 'remote'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'remote'
  const host = url.hostname.toLowerCase()
  if (productionHosts(env).has(host)) return 'production'
  if (isLoopbackHost(host)) return 'local'
  return 'remote'
}

function describeDatabaseHost(value, env) {
  const target = effectiveDatabaseTarget(value, env)
  if (!target) return '(unparseable)'
  const hosts = target.hosts.join(',')
  const via = target.source === 'PGHOST' ? ' via PGHOST' : ''
  return `${hosts}${via}${target.ambiguous ? ' (host/hostaddr parameter is ambiguous)' : ''}`
}

function describeHttpHost(value) {
  try {
    return new URL(value).hostname || '(none)'
  } catch {
    return '(unparseable)'
  }
}

/**
 * Throws when a configured test target is not local, or is a production host.
 * A remote target is accepted only when every host it reaches is named in
 * ADEA_ALLOW_REMOTE_TEST_TARGET (comma-separated exact hostnames) and none is
 * a production host; an ambiguous database URL is never accepted. Unset
 * variables are fine: tests that need one fail on their own.
 */
export function assertLocalTestTargets(env = process.env) {
  const allowedHosts = new Set(hostList(env.ADEA_ALLOW_REMOTE_TEST_TARGET))
  const refused = []
  const check = (name, kind) => {
    const value = env[name]
    if (!value) return
    const database = kind === 'database'
    const classification = database
      ? classifyDatabaseTarget(value, env)
      : classifyHttpTarget(value, env)
    if (classification === 'local') return
    const label = database ? describeDatabaseHost(value, env) : describeHttpHost(value)
    if (classification === 'production') {
      refused.push(`${name} (production host ${label}; no override)`)
      return
    }
    const hosts = database
      ? (effectiveDatabaseTarget(value, env)?.hosts ?? [])
      : [describeHttpHost(value).toLowerCase()]
    const ambiguous = database && effectiveDatabaseTarget(value, env)?.ambiguous
    if (!ambiguous && hosts.length > 0 && hosts.every((host) => allowedHosts.has(host))) return
    refused.push(`${name} (host ${label})`)
  }
  for (const name of DATABASE_TARGET_VARIABLES) check(name, 'database')
  for (const name of HTTP_TARGET_VARIABLES) check(name, 'http')
  if (refused.length > 0) {
    throw new Error(
      `Refusing to run tests against a non-local target: ${refused.join(', ')}. ` +
        'Tests use loopback services only. To target another host on purpose, ' +
        'name that exact host in ADEA_ALLOW_REMOTE_TEST_TARGET; production hosts are never accepted.'
    )
  }
}
