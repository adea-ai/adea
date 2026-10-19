// Failure evidence for the built-Worker harness. It never echoes response text or header
// values: a successful sign-up or sign-in body carries a session token, so only the status,
// normalized header categories and a fixed body category leave this function.

// Codes the harness can receive from the auth routes. Any other code is reported as `error`,
// so a new or unexpected code adds an entry here rather than becoming an echo path.
const knownErrorCodes = new Set([
  'EMAIL_NOT_VERIFIED',
  'INVALID_EMAIL_OR_PASSWORD',
  'INVALID_TOKEN',
  'USER_ALREADY_EXISTS',
])

function bodyCategoryOf(result) {
  const text = result.text ?? ''
  if (text.length === 0) return 'empty'
  if (result.status >= 200 && result.status < 300) return 'success'
  let code
  try {
    code = JSON.parse(text)?.code
  } catch {
    code = undefined
  }
  return typeof code === 'string' && knownErrorCodes.has(code) ? `error:${code}` : 'error'
}

function connectionCategory(value) {
  if (value === undefined || value === null) return 'absent'
  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'keep-alive' || normalized === 'close') return normalized
  return 'other'
}

function cacheControlCategory(value) {
  if (value === undefined || value === null) return 'absent'
  return String(value).toLowerCase().includes('no-store') ? 'no-store' : 'other'
}

export function describeResponse(result) {
  return {
    status: result.status,
    connection: connectionCategory(result.headers?.connection),
    cacheControl: cacheControlCategory(result.headers?.['cache-control']),
    bodyCategory: bodyCategoryOf(result),
  }
}
