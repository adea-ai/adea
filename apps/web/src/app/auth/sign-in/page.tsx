import type { Metadata } from "next";

import { normalizeDesktopAuthorizationReturnTo } from "../../../lib/desktop-auth-navigation";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in | Adea",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const requestedReturn = (await searchParams).returnTo;
  const returnTo = normalizeDesktopAuthorizationReturnTo(
    typeof requestedReturn === "string" ? requestedReturn : null
  );
  const desktopFlow = returnTo?.startsWith("/api/auth/desktop/authorize?") ?? false;

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="browser-auth-title">
        <p className="auth-eyebrow">{desktopFlow ? "Adea desktop" : "Adea workspace"}</p>
        <h1 className="auth-title" id="browser-auth-title">
          {desktopFlow ? "Connect this desktop" : "Save your workspace"}
        </h1>
        <p className="auth-introduction">
          {desktopFlow
            ? "Sign in here, then Adea will securely return you to the desktop app."
            : "Create an account or sign in to keep this temporary workspace across devices."}
        </p>
        <SignInForm returnTo={returnTo ?? "/"} />
        {!desktopFlow ? (
          <a className="browser-auth-continue" href="/">
            Continue without an account
          </a>
        ) : null}
      </section>
    </main>
  );
}
