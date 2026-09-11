import { createFileRoute } from '@tanstack/react-router'

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
  const requested = Array.isArray(search.returnTo) ? search.returnTo[0] : search.returnTo
  const returnTo = normalizeDesktopAuthorizationReturnTo(
    typeof requested === 'string' ? requested : null
  )
  const desktopFlow = returnTo?.startsWith('/api/auth/desktop/authorize?') ?? false

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="browser-auth-title">
        <p className="auth-eyebrow">{desktopFlow ? 'Adea desktop' : 'Adea workspace'}</p>
        <h1 className="auth-title" id="browser-auth-title">
          {desktopFlow ? 'Connect this desktop' : 'Save your workspace'}
        </h1>
        <p className="auth-introduction">
          {desktopFlow
            ? 'Sign in here, then Adea will securely return you to the desktop app.'
            : 'Create an account or sign in to keep this temporary workspace across devices.'}
        </p>
        <SignInForm returnTo={returnTo ?? '/'} />
        {!desktopFlow ? (
          <a className="browser-auth-continue" href="/">
            Continue without an account
          </a>
        ) : null}
      </section>
    </main>
  )
}
