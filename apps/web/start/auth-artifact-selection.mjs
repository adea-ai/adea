// Chooses the one built auth output an acceptance run may accept. The fixture output and
// the production output never stand in for each other: a fixture run refuses the
// production output by its real path, and a production run takes only its own output and
// refuses any fixture marker in it. Pure functions, so the rules are tested without a build.
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

// The real location of a directory, so a symlink or a trailing slash cannot name the
// production output under another path. A missing path keeps its resolved spelling.
function canonical(directory) {
  try {
    return realpathSync(resolve(directory))
  } catch {
    return resolve(directory)
  }
}

export function selectArtifact({ args, env, productionDir, defaultFixtureDir }) {
  const unknown = args.find((arg) => arg !== '--production')
  if (unknown !== undefined) throw new Error(`unknown argument: ${unknown}`)
  if (args.includes('--production')) {
    if (env.ADEA_AUTH_FIXTURE_DIST !== undefined)
      throw new Error(
        '--production accepts only the production output; unset ADEA_AUTH_FIXTURE_DIST'
      )
    return { kind: 'production', directory: resolve(productionDir), production: true }
  }
  if (env.ADEA_AUTH_FIXTURE_DIST === '') throw new Error('ADEA_AUTH_FIXTURE_DIST is set but empty')
  const directory = resolve(env.ADEA_AUTH_FIXTURE_DIST ?? defaultFixtureDir)
  if (canonical(directory) === canonical(productionDir))
    throw new Error('refusing to run the fixture acceptance against the production output')
  return { kind: 'fixture', directory, production: false }
}

// The Worker's own variables for one run. The fixture run requires verification and owns
// the loopback outbox. The production run is a local test-only lifecycle configuration:
// verification is explicitly false, and it carries no outbox or fixture variable. The
// application default (required, no transport) is not claimed by either run.
export function workerVariables({ kind, baseURL, databaseUrl, secret, outboxUrl }) {
  const shared = {
    AUTH_BASE_URL: baseURL,
    AUTH_DATABASE_URL: databaseUrl,
    AUTH_SECRET: secret,
    AUTH_SECURE_COOKIES: 'true',
    AUTH_TRUSTED_ORIGINS: baseURL,
  }
  if (kind === 'production') return { ...shared, AUTH_EMAIL_VERIFICATION_REQUIRED: 'false' }
  if (kind === 'fixture')
    return {
      ...shared,
      AUTH_EMAIL_VERIFICATION_REQUIRED: 'true',
      ADEA_AUTH_FIXTURE_OUTBOX_URL: outboxUrl,
    }
  throw new Error(`unknown artifact kind: ${kind}`)
}

export function checkMarkers({ kind, markerCount, directory }) {
  if (kind === 'production' && markerCount > 0)
    throw new Error(`production output carries fixture markers under ${directory}; refusing it`)
  if (kind === 'fixture' && markerCount === 0)
    throw new Error(`fixture output carries no fixture markers under ${directory}; refusing it`)
}
