// Chooses the one built auth output, and the one scenario, an acceptance run may use. The
// fixture output and the production output never stand in for each other: a fixture run
// refuses the production output by its real path, and a production run takes only its own
// output and refuses any fixture marker in it. Pure functions, so the rules are tested
// without a build.
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

// Scenarios: `fixture` is the recording-transport run; `lifecycle` is the production
// output with verification explicitly false; `default-refusal` is the production output
// with the application default (verification required, no transport).
export function selectArtifact({ args, env, productionDir, defaultFixtureDir }) {
  const known = new Set(['--production', '--default-refusal'])
  const unknown = args.find((arg) => !known.has(arg))
  if (unknown !== undefined) throw new Error(`unknown argument: ${unknown}`)
  const production = args.includes('--production')
  const refusal = args.includes('--default-refusal')
  if (refusal && !production)
    throw new Error('--default-refusal runs only against the production output; pass --production')
  if (production) {
    if (env.ADEA_AUTH_FIXTURE_DIST !== undefined)
      throw new Error(
        '--production accepts only the production output; unset ADEA_AUTH_FIXTURE_DIST'
      )
    return {
      kind: 'production',
      scenario: refusal ? 'default-refusal' : 'lifecycle',
      directory: resolve(productionDir),
      production: true,
    }
  }
  if (env.ADEA_AUTH_FIXTURE_DIST === '') throw new Error('ADEA_AUTH_FIXTURE_DIST is set but empty')
  const directory = resolve(env.ADEA_AUTH_FIXTURE_DIST ?? defaultFixtureDir)
  if (canonical(directory) === canonical(productionDir))
    throw new Error('refusing to run the fixture acceptance against the production output')
  return { kind: 'fixture', scenario: 'fixture', directory, production: false }
}

// The Worker's own variables for one run. The fixture run requires verification and owns
// the loopback outbox. The lifecycle run sets verification explicitly false and carries no
// outbox. The default-refusal run sets no verification variable at all, so the application
// default (required, no transport) is what it exercises.
export function workerVariables({ kind, scenario, baseURL, databaseUrl, secret, outboxUrl }) {
  const shared = {
    AUTH_BASE_URL: baseURL,
    AUTH_DATABASE_URL: databaseUrl,
    AUTH_SECRET: secret,
    AUTH_SECURE_COOKIES: 'true',
    AUTH_TRUSTED_ORIGINS: baseURL,
  }
  if (kind === 'production' && scenario === 'lifecycle')
    return { ...shared, AUTH_EMAIL_VERIFICATION_REQUIRED: 'false' }
  if (kind === 'production' && scenario === 'default-refusal') return { ...shared }
  if (kind === 'fixture' && scenario === 'fixture')
    return {
      ...shared,
      AUTH_EMAIL_VERIFICATION_REQUIRED: 'true',
      ADEA_AUTH_FIXTURE_OUTBOX_URL: outboxUrl,
    }
  throw new Error(`unknown artifact kind and scenario: ${kind}/${scenario}`)
}

export function checkMarkers({ kind, markerCount, directory }) {
  if (kind === 'production' && markerCount > 0)
    throw new Error(`production output carries fixture markers under ${directory}; refusing it`)
  if (kind === 'fixture' && markerCount === 0)
    throw new Error(`fixture output carries no fixture markers under ${directory}; refusing it`)
}
