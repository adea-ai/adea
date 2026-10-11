import { invoke, isDesktopRuntime } from './desktop-bridge'

const ADEA_REPOSITORY_ORIGIN = 'https://github.com'
const ADEA_REPOSITORY_PATH = '/adea-ai/adea'

/** Keep web and native external-link handoffs limited to Adea's HTTPS resources. */
export function resolveAdeaExternalUrl(input: string): string | undefined {
  try {
    const url = new URL(input)
    if (
      url.origin !== ADEA_REPOSITORY_ORIGIN ||
      !(
        url.pathname === ADEA_REPOSITORY_PATH || url.pathname.startsWith(`${ADEA_REPOSITORY_PATH}/`)
      ) ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return undefined
    }
    return url.href
  } catch {
    return undefined
  }
}

export async function openAdeaExternalUrl(input: string): Promise<void> {
  const url = resolveAdeaExternalUrl(input)
  if (!url) throw new Error('This external link is not an Adea resource.')

  if (isDesktopRuntime()) {
    await invoke<void>('desktop_open_external', { url })
    return
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}
