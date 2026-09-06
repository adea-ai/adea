"use client";

import { useState, type FormEvent } from "react";

type AuthMode = "sign-in" | "sign-up";

export function SignInForm({ returnTo }: { returnTo: string }) {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");

    try {
      const { createNeonClientAdapter } = await import("@adea/auth/client");
      const authentication = createNeonClientAdapter();
      if (mode === "sign-up") {
        await authentication.signUp({
          email,
          name: String(data.get("name") ?? "").trim(),
          password,
        });
      } else {
        await authentication.signIn({ email, password });
      }
      window.location.assign(returnTo);
    } catch {
      setError(
        mode === "sign-up"
          ? "Agent HQ could not create that account. Check the details or sign in instead."
          : "Agent HQ could not sign you in. Check your email and password, then try again."
      );
      setPending(false);
    }
  }

  function changeMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError("");
  }

  return (
    <>
      <div className="browser-auth-mode" aria-label="Choose authentication mode">
        <button
          type="button"
          aria-pressed={mode === "sign-in"}
          onClick={() => changeMode("sign-in")}
        >
          Sign in
        </button>
        <button
          type="button"
          aria-pressed={mode === "sign-up"}
          onClick={() => changeMode("sign-up")}
        >
          Create account
        </button>
      </div>

      <form className="browser-auth-form" onSubmit={submit}>
        {mode === "sign-up" ? (
          <label htmlFor="name">
            Display name
            <input id="name" name="name" autoComplete="name" required disabled={pending} />
          </label>
        ) : null}

        <label htmlFor="email">
          Email
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            disabled={pending}
          />
        </label>

        <label htmlFor="password">
          Password
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            minLength={8}
            required
            disabled={pending}
          />
        </label>

        <p className="browser-auth-error" role="status" aria-live="polite">
          {error}
        </p>

        <button className="browser-auth-submit" type="submit" disabled={pending}>
          {pending
            ? mode === "sign-up"
              ? "Creating account…"
              : "Signing in…"
            : mode === "sign-up"
              ? "Create account and continue"
              : "Sign in and continue"}
        </button>
      </form>
    </>
  );
}
