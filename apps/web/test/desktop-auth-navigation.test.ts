import { describe, expect, test } from "bun:test";

import {
  createDesktopSignInUrl,
  normalizeDesktopAuthorizationReturnTo,
} from "../src/lib/desktop-auth-navigation";

describe("desktop browser authentication navigation", () => {
  test("sends an unauthenticated authorization request through sign-in", () => {
    const request = new URL(
      "https://agent-hq.example/api/auth/desktop/authorize?state=state&nonce=nonce&code_challenge=challenge&code_challenge_method=S256&redirect_uri=agent-hq%3A%2F%2Fauth%2Fcallback",
    );

    const signIn = createDesktopSignInUrl(request);

    expect(signIn.origin).toBe(request.origin);
    expect(signIn.pathname).toBe("/auth/sign-in");
    expect(signIn.searchParams.get("returnTo")).toBe(`${request.pathname}${request.search}`);
  });

  test("accepts only the same-origin desktop authorization endpoint as a return target", () => {
    expect(
      normalizeDesktopAuthorizationReturnTo("/api/auth/desktop/authorize?state=state&nonce=nonce"),
    ).toBe("/api/auth/desktop/authorize?state=state&nonce=nonce");
    expect(normalizeDesktopAuthorizationReturnTo("https://evil.example/steal")).toBeNull();
    expect(normalizeDesktopAuthorizationReturnTo("//evil.example/steal")).toBeNull();
    expect(normalizeDesktopAuthorizationReturnTo("/api/auth/sign-out")).toBeNull();
  });
});
