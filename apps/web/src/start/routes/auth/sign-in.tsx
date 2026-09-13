import { createFileRoute } from '@tanstack/solid-router'

import { SignInForm } from '../../../components/sign-in-form'
import { normalizeDesktopAuthorizationReturnTo } from '../../../lib/desktop-auth-navigation'

export const Route = createFileRoute('/auth/sign-in')({
  head: () => ({ meta: [{ title: 'Sign in | Adea' }] }),
  // The sign-in document only reads returnTo; unknown parameters are ignored.
  validateSearch: (search: Record<string, unknown>) => ({
    returnTo: search.returnTo as string | string[] | undefined,
  }),
  component: SignInPage,
})

function SignInPage() {
  const search = Route.useSearch()
  const requested = () => {
    const value = search()?.returnTo
    if (Array.isArray(value)) return value[0] ?? null
    return typeof value === 'string' ? value : null
  }
  const returnTo = () => normalizeDesktopAuthorizationReturnTo(requested())
  const desktopFlow = () => returnTo()?.startsWith('/api/auth/desktop/authorize?') ?? false

  return (
    <main class="auth-shell">
      <section class="auth-panel" aria-labelledby="browser-auth-title">
        <p class="auth-eyebrow">{desktopFlow() ? 'Adea desktop' : 'Adea workspace'}</p>
        <h1 class="auth-title" id="browser-auth-title">
          {desktopFlow() ? 'Connect this desktop' : 'Save your workspace'}
        </h1>
        <p class="auth-introduction">
          {desktopFlow()
            ? 'Sign in here, then Adea will securely return you to the desktop app.'
            : 'Create an account or sign in to keep this temporary workspace across devices.'}
        </p>
        <SignInForm returnTo={returnTo() ?? '/'} />
        {!desktopFlow() ? (
          <a class="browser-auth-continue" href="/">
            Continue without an account
          </a>
        ) : null}
      </section>
    </main>
  )
}
