// The single JavaScript source of truth for the cloud origin. The desktop
// client build and the desktop shell both read it; the origin-boundary gate
// pins every consumer to this value.
export const DEFAULT_CLOUD_ORIGIN = 'https://adea.dev'

export function normalizeDesktopCloudOrigin(value = DEFAULT_CLOUD_ORIGIN) {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
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
