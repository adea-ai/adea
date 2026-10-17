// The single JavaScript source of truth for the cloud origin. The desktop
// client build and the desktop shell both read it; the origin-boundary gate
// pins every consumer to this value.
export const DEFAULT_CLOUD_ORIGIN = 'https://adea.dev'

// What a development build or a repo-checkout shell talks to when nothing says
// otherwise: the local web dev server. Reaching the hosted cloud from a
// development run is always a deliberate choice (see `resolveCloudOrigin`).
export const LOCAL_DEV_CLOUD_ORIGIN = 'http://localhost:3000'

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

export function normalizeDesktopCloudOrigin(value = DEFAULT_CLOUD_ORIGIN) {
  const url = new URL(value)
  const loopback = LOOPBACK_HOSTS.includes(url.hostname)
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new Error('Desktop cloud origin must be an HTTPS origin or loopback HTTP origin')
  }
  return url.origin
}

export function isLoopbackCloudOrigin(origin) {
  return LOOPBACK_HOSTS.includes(new URL(origin).hostname)
}

/**
 * The cloud origin one build targets.
 *
 * - `release` (ADEA_DESKTOP_RELEASE_BUILD=true, set only by the release
 *   workflow) keeps the canonical hosted origin as its default.
 * - Every other build (`shell:build`, `shell:dev`, CI checks) defaults to the
 *   local dev server and may only reach a hosted origin when the caller both
 *   names it and sets `ADEA_ALLOW_HOSTED_CLOUD=true`. A hosted origin without
 *   that opt-in is refused instead of silently used.
 *
 * `explicit` is the origin the caller asked for, if any.
 */
export function resolveCloudOrigin({ explicit, release, allowHosted }) {
  if (release) return normalizeDesktopCloudOrigin(explicit || DEFAULT_CLOUD_ORIGIN)
  const origin = normalizeDesktopCloudOrigin(explicit || LOCAL_DEV_CLOUD_ORIGIN)
  if (!isLoopbackCloudOrigin(origin) && allowHosted !== 'true') {
    throw new Error(
      'Development runs target the local dev server; set ADEA_ALLOW_HOSTED_CLOUD=true to use a hosted cloud origin deliberately'
    )
  }
  return origin
}

// ---------------------------------------------------------------------------
// The persisted build target.
//
// What a build targets is decided once, when the client is built, and written
// next to the client (`adea-desktop-target.json`). The bundle copies the client
// directory, so a packaged shell carries the same record the client was built
// from. The shell reads it instead of guessing from how it was launched: a
// packaged shell built locally (`shell:build`) is a `local` build and talks to
// loopback, only the release workflow's build is `release`.
//
// - `release`: a release build. Origin: the canonical hosted origin (or the
//   explicit override the build was given).
// - `local`: a development build. Origin: loopback.
// - `hosted-dev`: a development build that named a hosted origin and allowed it
//   at build time. The shell additionally requires the same opt-in at run time.
// ---------------------------------------------------------------------------

export const DESKTOP_TARGET_FILE = 'adea-desktop-target.json'

const TARGET_MODES = ['release', 'local', 'hosted-dev']

/** The target one build records: its mode and the origin it was built for. */
export function desktopBuildTarget({ explicit, release, allowHosted }) {
  const cloudOrigin = resolveCloudOrigin({ explicit, release, allowHosted })
  const mode = release ? 'release' : isLoopbackCloudOrigin(cloudOrigin) ? 'local' : 'hosted-dev'
  return { mode, cloudOrigin }
}

export function serializeDesktopTarget(target) {
  return `${JSON.stringify(parseDesktopTargetValue(target), null, 2)}\n`
}

function parseDesktopTargetValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The desktop build target is malformed')
  }
  const { mode, cloudOrigin } = value
  if (!TARGET_MODES.includes(mode) || typeof cloudOrigin !== 'string') {
    throw new Error('The desktop build target is malformed')
  }
  const origin = normalizeDesktopCloudOrigin(cloudOrigin)
  if (origin !== cloudOrigin) throw new Error('The desktop build target origin is not canonical')
  const loopback = isLoopbackCloudOrigin(origin)
  if (mode === 'local' && !loopback) throw new Error('A local desktop build must target loopback')
  if (mode === 'hosted-dev' && loopback) {
    throw new Error('A hosted-dev desktop build must target a hosted origin')
  }
  return { mode, cloudOrigin }
}

/** Parses the persisted record; any malformed, unknown or inconsistent file throws. */
export function parseDesktopTarget(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('The desktop build target is not valid JSON')
  }
  return parseDesktopTargetValue(value)
}

/**
 * The origin the shell proxies to, from the persisted target. A run-time
 * `ADEA_CLOUD_ORIGIN` may only restate it: the client carries the origin it
 * authorizes against, so the shell cannot be re-pointed without a rebuild. A
 * `hosted-dev` build also needs the run-time opt-in.
 */
export function resolveShellCloudOrigin(target, { explicit, allowHosted } = {}) {
  const { mode, cloudOrigin } = parseDesktopTargetValue(target)
  if (explicit && normalizeDesktopCloudOrigin(explicit) !== cloudOrigin) {
    throw new Error(
      `ADEA_CLOUD_ORIGIN does not match the origin this client was built for (${cloudOrigin}); rebuild the client to change it`
    )
  }
  if (mode === 'hosted-dev' && allowHosted !== 'true') {
    throw new Error(
      'This client was built for a hosted cloud origin; set ADEA_ALLOW_HOSTED_CLOUD=true to run it deliberately'
    )
  }
  return cloudOrigin
}
