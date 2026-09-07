export const TEMPORARY_SESSION_COOKIE = 'agent_hq_temporary_session'

const TEMPORARY_CREDENTIAL_PATTERN = /^adea_tmp_[A-Za-z0-9_-]{43}$/u

export function parseTemporaryCredential(value: string | null | undefined): string | null {
  return value && TEMPORARY_CREDENTIAL_PATTERN.test(value) ? value : null
}

export function createTemporaryCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `adea_tmp_${Buffer.from(bytes).toString('base64url')}`
}

export async function digestTemporaryCredential(credential: string): Promise<string> {
  const bytes = new TextEncoder().encode(credential)
  return Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')
}

export function readTemporaryCredential(request: Request): string | null {
  const authorization = request.headers.get('authorization')
  if (authorization) {
    const match = /^Temporary ([^\s]+)$/u.exec(authorization)
    return parseTemporaryCredential(match?.[1])
  }

  const cookies = request.headers.get('cookie')?.split(';') ?? []
  for (const cookie of cookies) {
    const [rawName, ...rawValue] = cookie.trim().split('=')
    if (rawName !== TEMPORARY_SESSION_COOKIE) continue
    try {
      return parseTemporaryCredential(decodeURIComponent(rawValue.join('=')))
    } catch {
      return null
    }
  }
  return null
}
