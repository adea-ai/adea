const DESKTOP_AUTHORIZATION_PATH = '/api/auth/desktop/authorize'
const DESKTOP_CALLBACK_TARGET = 'adea://auth/callback'

export function createDesktopCompletionUrl(authorizationUrl: URL, callback: string) {
  const completionUrl = new URL('/auth/desktop/complete', authorizationUrl.origin)
  completionUrl.hash = new URLSearchParams({ callback }).toString()
  return completionUrl
}

export function createDesktopErrorCompletionUrl(authorizationUrl: URL, error: string) {
  const completionUrl = new URL('/auth/desktop/complete', authorizationUrl.origin)
  completionUrl.hash = new URLSearchParams({ error }).toString()
  return completionUrl
}

export function parseDesktopCallbackFragment(fragment: string) {
  const fragmentParams = new URLSearchParams(
    fragment.startsWith('#') ? fragment.slice(1) : fragment
  )
  const fragmentKeys = [...fragmentParams.keys()]
  if (
    fragmentKeys.length !== 1 ||
    fragmentKeys[0] !== 'callback' ||
    fragmentParams.getAll('callback').length !== 1
  ) {
    return null
  }

  try {
    const callback = new URL(fragmentParams.get('callback') ?? '')
    if (`${callback.protocol}//${callback.host}${callback.pathname}` !== DESKTOP_CALLBACK_TARGET) {
      return null
    }
    if (callback.username || callback.password || callback.hash) return null

    const parameterNames = [...callback.searchParams.keys()]
    if (
      parameterNames.length !== 3 ||
      new Set(parameterNames).size !== parameterNames.length ||
      !parameterNames.every((parameter) => ['code', 'nonce', 'state'].includes(parameter))
    ) {
      return null
    }

    const code = callback.searchParams.get('code') ?? ''
    const nonce = callback.searchParams.get('nonce') ?? ''
    const state = callback.searchParams.get('state') ?? ''
    if (
      code.length < 8 ||
      code.length > 512 ||
      nonce.length < 16 ||
      nonce.length > 512 ||
      state.length < 16 ||
      state.length > 512
    ) {
      return null
    }
    return callback.toString()
  } catch {
    return null
  }
}

export function createDesktopSignInUrl(authorizationUrl: URL) {
  const signInUrl = new URL('/auth/sign-in', authorizationUrl.origin)
  signInUrl.searchParams.set('returnTo', `${authorizationUrl.pathname}${authorizationUrl.search}`)
  return signInUrl
}

export function normalizeDesktopAuthorizationReturnTo(value: string | null | undefined) {
  if (!value?.startsWith('/') || value.startsWith('//')) return null
  try {
    const target = new URL(value, 'https://agent-hq.invalid')
    if (target.origin !== 'https://agent-hq.invalid') {
      return null
    }
    if (target.pathname.startsWith('/api/') && target.pathname !== DESKTOP_AUTHORIZATION_PATH)
      return null
    return `${target.pathname}${target.search}`
  } catch {
    return null
  }
}
