export function evaluateEntryAccess(options: {
  configured: boolean
  resolveEmail: () => Promise<string | null | undefined>
  isAllowed: (email: string) => boolean
}): Promise<'allowed' | 'sign-in' | 'denied'>
