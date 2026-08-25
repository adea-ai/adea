import type { Metadata } from "next";

import { normalizeDesktopAuthorizationReturnTo } from "../../../lib/desktop-auth-navigation";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in | Agent HQ",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const requestedReturn = (await searchParams).returnTo;
  const returnTo = normalizeDesktopAuthorizationReturnTo(
    typeof requestedReturn === "string" ? requestedReturn : null,
  );

  return (
    <main className="browser-auth-shell">
      <section className="browser-auth-panel" aria-labelledby="browser-auth-title">
        <div className="browser-auth-brand" aria-hidden="true">
          HQ
        </div>
        <p className="browser-auth-eyebrow">Agent HQ desktop</p>
        <h1 id="browser-auth-title">Connect this desktop</h1>
        <p className="browser-auth-introduction">
          Sign in here, then Agent HQ will return you to the desktop app without placing your
          password or session credentials in the callback URL.
        </p>
        <SignInForm returnTo={returnTo ?? "/"} />
      </section>
    </main>
  );
}
